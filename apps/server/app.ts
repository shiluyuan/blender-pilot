import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import staticPlugin from "@fastify/static";
import { WebSocket, WebSocketServer } from "ws";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdir,
  rm,
  copyFile,
  readFile,
  writeFile,
  stat,
  rename,
  unlink,
  statfs,
  open,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { z } from "zod";
import sharp from "sharp";
import {
  DOCUMENT_EXTENSIONS,
  MAX_DOCUMENT_BYTES,
  documentInfo,
  documentMime,
} from "../../packages/contracts/attachments.js";
import { readDocumentFile } from "../../packages/contracts/document-files.js";
import {
  AssetLibrary,
  libraryMetadataSchema,
  saveLibrarySchema,
} from "../../packages/blender-bridge/library.js";
import { LibraryCatalog } from "../../packages/storage/library-catalog.js";
import { Store } from "./db.js";
import { registerTemplateRoutes } from "./template-routes.js";
import {
  MAX_CHAT_PROMPT_CHARS,
  MAX_CHAT_ATTACHMENTS,
} from "../../packages/contracts/chat-limits.js";
import { Vault, validPassword } from "./security.js";
import {
  idSchema,
  modelSettingsSchema,
  terminal,
  type Run,
  type Asset,
  type Session,
  type Project,
  type ModelSettings,
} from "../../packages/contracts/index.js";
import {
  now,
  safePath,
  existingSafePath,
  redact,
} from "../../packages/contracts/fs.js";
export interface AppOptions {
  dataRoot: string;
  databaseUrl?: string;
  databaseSchema?: string;
  password: string;
  internalToken: string;
  runnerUrl: string;
  webRoot?: string;
  secureCookie?: boolean;
  poll?: boolean;
}
export async function buildApp(options: AppOptions) {
  if (options.password.length < 12)
    throw new Error("PILOT_PASSWORD must contain at least 12 characters");
  await mkdir(options.dataRoot, { recursive: true });
  const store = new Store(options.dataRoot, {
    url: options.databaseUrl,
    schema: options.databaseSchema,
  });
  await store.init();
  try {
    await stat(path.join(options.dataRoot, "database", "PG_VERSION"));
    const imported = await store.db.query(
      `SELECT source FROM ${store.db.table("migration_imports")} WHERE source='legacy-v1'`,
    );
    if (!imported.rowCount) {
      await store.db.close();
      throw new Error(
        "发现旧版 PGlite 数据，请运行 docker-up.sh 完成数据库迁移后启动。",
      );
    }
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }

  const vault = new Vault(path.join(options.dataRoot, "config"));
  await vault.init();
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });
  await app.register(cookie);
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: 5 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );
  const authAttempts = new Map<string, { count: number; until: number }>();
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "same-origin")
      .header("X-Frame-Options", "SAMEORIGIN");
    if (!req.url.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    const origin = req.headers.origin;
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {}
      if (originHost !== req.headers.host)
        return reply.code(403).send({ error: "跨来源请求被拒绝" });
    }
    if (
      req.url === "/api/auth/login" ||
      req.url === "/api/auth/status" ||
      req.url === "/api/ready"
    )
      return;
    if (!vault.valid(req.cookies.pilot_session))
      return reply.code(401).send({ error: "请先登录" });
  });
  app.setErrorHandler((error: any, _req, reply) =>
    reply
      .code(
        error instanceof z.ZodError
          ? 400
          : error.statusCode ||
              (error.code === "23505"
                ? 409
                : error.code === "23503"
                  ? 400
                  : ["ECONNREFUSED", "ECONNRESET", "57P01", "57P03"].includes(
                        error.code,
                      )
                    ? 503
                    : 500),
      )
      .send({
        error:
          error instanceof z.ZodError
            ? error.issues.map((x: any) => x.message).join("；")
            : error.code === "23505"
              ? "该项目已有活动任务或记录重复，请刷新后重试"
              : error.code === "23503"
                ? "关联记录不存在或不属于当前项目"
                : ["ECONNREFUSED", "ECONNRESET", "57P01", "57P03"].includes(
                      error.code,
                    )
                  ? "数据库暂时不可用，请稍后重试"
                  : error.message || "操作失败",
      }),
  );
  registerTemplateRoutes(app, store);
  const shutdownController = new AbortController();
  const streams = new Set<import("node:http").ServerResponse>();
  const fail = (message: string, statusCode = 400) =>
    Object.assign(new Error(message), { statusCode });
  const runner = async (endpoint: string, body?: unknown) => {
    const res = await fetch(options.runnerUrl + endpoint, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${options.internalToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([
        shutdownController.signal,
        AbortSignal.timeout(endpoint === "/health" ? 10000 : 180000),
      ]),
    });
    const json = (await res.json()) as any;
    if (!res.ok) throw fail(json.error || "执行服务请求失败", res.status);
    return json;
  };
  const project = async (id: string) => {
    idSchema.parse(id);
    const p = await store.get<Project>("project", id);
    if (!p) throw fail("项目不存在", 404);
    return p;
  };
  const model = async (): Promise<ModelSettings> => {
    const s = await store.get<any>("config", "model");
    if (!s?.encryptedKey)
      throw fail("请先在设置中填写模型 Key、Base URL 和模型名");
    return {
      baseUrl: s.baseUrl,
      model: s.model,
      effort: s.effort,
      apiKey: vault.decrypt(s.encryptedKey),
    };
  };
  const publicModel = async () => {
    const s = await store.get<any>("config", "model");
    return {
      baseUrl: s?.baseUrl || "",
      model: s?.model || "",
      effort: s?.effort || "medium",
      hasKey: !!s?.encryptedKey,
    };
  };
  const operations = new Map<string, Promise<unknown>>();
  const dispatches = new Map<string, Promise<void>>();
  // Resolve the resource's owner before entering a per-project queue. Different
  // projects never wait for another project's Blender startup/import/render.
  const exclusive = async <T>(req: any, fn: () => Promise<T>): Promise<T> => {
    const resource = req.url.split("?")[0].split("/")[2];
    const id = (req.params as any)?.id;
    let key = "global";
    if (resource === "projects") key = idSchema.parse(id);
    else if (
      resource === "sessions" ||
      resource === "snapshots" ||
      resource === "assets"
    ) {
      const kind =
        resource === "sessions"
          ? "session"
          : resource === "snapshots"
            ? "snapshot"
            : "asset";
      key = (await store.get<any>(kind, idSchema.parse(id)))?.projectId || key;
    } else if (resource === "library")
      key = req.body?.projectId
        ? idSchema.parse(req.body.projectId)
        : "library:" + idSchema.parse(id);
    const job = (operations.get(key) || Promise.resolve())
      .catch(() => {})
      .then(fn);
    operations.set(key, job);
    try {
      return await job;
    } finally {
      if (operations.get(key) === job) operations.delete(key);
    }
  };
  const ensureIdle = async (projectId: string) => {
    const runs = await store.list<Run>("run");
    if (runs.some((r) => r.projectId === projectId && !terminal.has(r.status)))
      throw fail("已有任务正在运行，请先停止或等待完成", 409);
  };
  app.get("/api/ready", async (_req, reply) => {
    try {
      await store.db.health();
      return { ok: true };
    } catch {
      return reply
        .code(503)
        .send({ ok: false, error: "PostgreSQL unavailable" });
    }
  });
  app.get("/api/auth/status", async (req) => ({
    authenticated: vault.valid(req.cookies.pilot_session),
  }));
  app.post("/api/auth/login", async (req, reply) => {
    const body = z.object({ password: z.string().max(500) }).parse(req.body);
    const ip = req.ip;
    const limit = authAttempts.get(ip);
    if (limit && limit.until > Date.now() && limit.count >= 10)
      throw fail("尝试过多，请稍后重试", 429);
    if (!validPassword(body.password, options.password)) {
      authAttempts.set(ip, {
        count: (limit && limit.until > Date.now() ? limit.count : 0) + 1,
        until: Date.now() + 60000,
      });
      throw fail("访问密码不正确", 401);
    }
    authAttempts.delete(ip);
    reply.setCookie("pilot_session", vault.session(), {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: options.secureCookie,
      maxAge: 7 * 86400,
    });
    return { ok: true };
  });
  app.post("/api/auth/logout", async (_req, reply) => {
    reply.clearCookie("pilot_session", { path: "/" });
    return { ok: true };
  });
  app.get("/api/settings", publicModel);
  app.put("/api/settings", async (req) => {
    const input = modelSettingsSchema.parse(req.body);
    const u = new URL(input.baseUrl);
    if (u.username || u.password || u.search || u.hash)
      throw fail("Base URL 不应包含账号、查询参数或锚点");
    if (/\/(responses|chat\/completions)\/?$/.test(u.pathname))
      throw fail("请填写 API 根地址，不要包含 /responses 或 /chat/completions");
    const old = await store.get<any>("config", "model");
    const key = input.clearKey
      ? undefined
      : input.apiKey
        ? vault.encrypt(input.apiKey)
        : old?.encryptedKey;
    await store.put("config", "model", {
      baseUrl: input.baseUrl.replace(/\/$/, ""),
      model: input.model,
      effort: input.effort,
      encryptedKey: key,
    });
    return publicModel();
  });
  app.post("/api/settings/test", async () => {
    const s = await model();
    try {
      const response = await fetch(s.baseUrl + "/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${s.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: s.model,
          instructions: "This is a connection test. Reply briefly.",
          input: [{ role: "user", content: "Reply with OK." }],
          store: false,
          stream: true,
          reasoning: { effort: s.effort },
        }),
        signal: AbortSignal.timeout(45000),
      });
      if (!response.ok)
        throw new Error(
          `HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
        );
      if (!response.body) throw new Error("响应为空");
      const reader = response.body.getReader();
      let text = "";
      let bytes = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > 1024 * 1024) {
          await reader.cancel();
          throw new Error("响应超过测试限制");
        }
        text += new TextDecoder().decode(next.value);
      }
      if (/"type"\s*:\s*"(error|response.failed)"/.test(text))
        throw new Error(text.slice(-800));
      if (!/response.completed|"status"\s*:\s*"completed"/.test(text))
        throw new Error("接口没有返回完成事件；请检查 Responses API 流式协议");
      return {
        ok: true,
        message:
          "Responses API 连通。视觉与 Blender 工具能力请通过工作台真实任务验证。",
      };
    } catch (e) {
      throw fail(redact(String(e), [s.apiKey || ""]), 502);
    }
  });
  app.get("/api/health", async () => {
    let execution;
    try {
      execution = await runner("/health");
    } catch (e) {
      execution = { ok: false, error: String(e) };
    }
    const disk = await statfs(options.dataRoot);
    return {
      app: true,
      database: await store.db.health().catch(() => ({
        ok: false,
        engine: "PostgreSQL",
        error: "数据库暂时不可用",
      })),
      execution,
      storage: {
        free: Number(disk.bavail) * Number(disk.bsize),
        total: Number(disk.blocks) * Number(disk.bsize),
      },
      model: await publicModel().catch(() => ({
        baseUrl: "",
        model: "",
        hasKey: false,
      })),
      versions: {
        app: "0.1.0",
        codex: "0.164.0",
        mcp: "2.2.2",
        blender:
          process.env.BLENDER_VERSION ||
          execution?.studios?.find((s: any) => s.blenderVersion)
            ?.blenderVersion ||
          "按项目启动时检测",
      },
    };
  });
  app.get("/api/projects", async () => store.list<Project>("project"));
  app.post("/api/projects", async (req) => {
    const input = z
      .object({ name: z.string().trim().min(1).max(80) })
      .parse(req.body);
    const p: Project = {
      id: randomUUID(),
      name: input.name,
      createdAt: now(),
      updatedAt: now(),
    };
    await mkdir(safePath(options.dataRoot, "projects", p.id), {
      recursive: true,
    });
    await store.put("project", p.id, p);
    return p;
  });
  app.patch("/api/projects/:id", async (req) => {
    const p = await project((req.params as any).id);
    const { name } = z
      .object({ name: z.string().trim().min(1).max(80) })
      .parse(req.body);
    p.name = name;
    p.updatedAt = now();
    await store.put("project", p.id, p);
    return p;
  });
  app.post("/api/projects/:id/activate", async (req) =>
    exclusive(req, async () => {
      const p = await project((req.params as any).id);
      const result = await runner("/scene", {
        projectId: p.id,
        action: "activate",
      });
      await store.put("config", "active", { projectId: p.id });
      return result;
    }),
  );
  app.post("/api/projects/:id/close", async (req) =>
    exclusive(req, async () => {
      const p = await project((req.params as any).id);
      await ensureIdle(p.id);
      return runner(`/projects/${p.id}/close`, {});
    }),
  );
  app.get("/api/active", async () => store.get("config", "active"));
  app.get("/api/projects/:id/scene", async (req) =>
    exclusive(req, async () => {
      const p = await project((req.params as any).id);
      await ensureIdle(p.id);
      return runner("/scene", { projectId: p.id, action: "info" });
    }),
  );
  app.post("/api/projects/:id/captures", async (req) =>
    exclusive(req, async () => {
      const p = await project((req.params as any).id);
      await ensureIdle(p.id);
      const capture = await runner("/scene", {
        projectId: p.id,
        action: "capture",
      });
      await store.put("capture", capture.id, capture);
      return capture;
    }),
  );
  app.get("/api/projects/:id/captures", async (req) =>
    store.list("capture", (await project((req.params as any).id)).id),
  );
  app.post("/api/projects/:id/save", async (req) =>
    exclusive(req, async () => {
      const p = await project((req.params as any).id);
      await ensureIdle(p.id);
      return runner("/scene", { projectId: p.id, action: "save" });
    }),
  );
  app.get("/api/projects/:id/snapshots", async (req) =>
    store.list("snapshot", (await project((req.params as any).id)).id),
  );
  app.post("/api/projects/:id/snapshots", async (req) =>
    exclusive(req, async () => {
      const p = await project((req.params as any).id);
      await ensureIdle(p.id);
      const body = z
        .object({ name: z.string().max(100).default("手动快照") })
        .parse(req.body || {});
      const snapshot = await runner("/scene", {
        projectId: p.id,
        action: "snapshot",
        name: body.name,
      });
      await store.put("snapshot", snapshot.id, snapshot);
      return snapshot;
    }),
  );
  app.post("/api/snapshots/:id/restore", async (req) =>
    exclusive(req, async () => {
      const id = idSchema.parse((req.params as any).id);
      const s = await store.get<any>("snapshot", id);
      if (!s) throw fail("快照不存在", 404);
      await ensureIdle(s.projectId);
      const before = await runner("/scene", {
        projectId: s.projectId,
        action: "restore",
        path: s.path,
      });
      await store.put("snapshot", before.id, before);
      return { ok: true, before };
    }),
  );
  app.post("/api/projects/:id/export", async (req) =>
    exclusive(req, async () => {
      const p = await project((req.params as any).id);
      await ensureIdle(p.id);
      const { format } = z
        .object({ format: z.enum(["glb", "gltf", "blend"]) })
        .parse(req.body);
      const result = await runner("/scene", {
        projectId: p.id,
        action: "export",
        format,
      });
      const file = await existingSafePath(
        safePath(options.dataRoot, "projects", p.id),
        result.path,
      );
      const artifact = {
        id: randomUUID(),
        projectId: p.id,
        path: file,
        name: p.name + "." + format,
        createdAt: now(),
        kind: "export",
      };
      await store.put("artifact", artifact.id, artifact);
      return artifact;
    }),
  );
  app.get("/api/projects/:id/sessions", async (req) =>
    store.list<Session>("session", (await project((req.params as any).id)).id),
  );
  app.post("/api/projects/:id/sessions", async (req) => {
    const p = await project((req.params as any).id);
    const s: Session = {
      id: randomUUID(),
      projectId: p.id,
      title: "新对话",
      createdAt: now(),
    };
    await store.put("session", s.id, s);
    return s;
  });
  app.get("/api/sessions/:id/runs", async (req) => {
    const id = idSchema.parse((req.params as any).id);
    return (await store.list<Run>("run"))
      .filter((r) => r.sessionId === id)
      .reverse();
  });
  app.get("/api/sessions/:id/requests/:requestId", async (req) => {
    const sid = idSchema.parse((req.params as any).id);
    const requestId = idSchema.parse((req.params as any).requestId);
    if (!(await store.get<Session>("session", sid)))
      throw fail("对话不存在", 404);
    return { run: (await store.requestedRun(sid + ":" + requestId)) || null };
  });
  app.post("/api/sessions/:id/turns", async (req) =>
    exclusive(req, async () => {
      const sid = idSchema.parse((req.params as any).id);
      const body = z
        .object({
          text: z.string().trim().min(1).max(MAX_CHAT_PROMPT_CHARS),
          assetIds: z.array(idSchema).max(12).default([]),
          libraryAssetIds: z.array(idSchema).max(12).default([]),
          clientRequestId: idSchema,
        })
        .refine(
          (input) =>
            input.assetIds.length + input.libraryAssetIds.length <=
            MAX_CHAT_ATTACHMENTS,
          "项目附件与共享素材合计最多引用 12 项",
        )
        .parse(req.body);
      const session = await store.get<Session>("session", sid);
      if (!session) throw fail("对话不存在", 404);
      const requestKey = sid + ":" + body.clientRequestId;
      const prior = await store.requestedRun(requestKey, {
        sessionId: sid,
        projectId: session.projectId,
        prompt: body.text,
        assetIds: body.assetIds,
        libraryAssetIds: body.libraryAssetIds,
      });
      if (prior) return prior;
      const settings = await model();
      const assets = [];
      for (const id of body.assetIds) {
        const projectAsset = await store.get<Asset>("asset", id);
        const asset = projectAsset || (await store.get<any>("capture", id));
        if (!asset || asset.projectId !== session.projectId)
          throw fail("引用资源不属于当前项目");
        if (documentMime(asset.path)) {
          try {
            const file = await existingSafePath(
              safePath(options.dataRoot, "projects", session.projectId),
              asset.path,
            );
            await readDocumentFile(path.basename(file), file);
          } catch (e) {
            throw fail(`文档 ${asset.name} 无法读取：${(e as Error).message}`);
          }
        }
        assets.push({
          id: asset.id,
          name: asset.name || "场景截图",
          path: asset.path,
          mime: asset.mime,
          referenceKind: projectAsset
            ? ("asset" as const)
            : ("capture" as const),
        });
      }
      const libraryAssets = await Promise.all(
        body.libraryAssetIds.map(async (id) => {
          const a = await library.get(id);
          await library.file(id);
          return { id: a.id, name: a.name };
        }),
      );
      const run: Run = {
        id: randomUUID(),
        sessionId: sid,
        projectId: session.projectId,
        prompt: body.text,
        assetIds: body.assetIds,
        libraryAssetIds: body.libraryAssetIds,
        clientRequestId: body.clientRequestId,
        attachmentRefs: [
          ...assets.map((asset) => ({
            id: asset.id,
            name: asset.name,
            kind: asset.referenceKind,
            mime: asset.mime,
          })),
          ...libraryAssets.map((asset) => ({
            id: asset.id,
            name: asset.name,
            kind: "library" as const,
          })),
        ],
        status: "queued",
        verification: "pending",
        createdAt: now(),
        updatedAt: now(),
      };
      const accepted = await store.createRun(run, requestKey);
      if (accepted.id !== run.id) return accepted;
      if (session.title === "新对话") {
        session.title = body.text.slice(0, 28);
        // A cosmetic title failure must not strand an already accepted send.
        await store.put("session", sid, session).catch(() => {});
      }
      const dispatch = (async () => {
        // Admission is already durable. Return its receipt immediately while
        // the worker prepares Blender, and retain a cancellable dispatch owner.
        const current = await store.get<Run>("run", run.id);
        if (current?.cancelRequestedAt || current?.status === "cancelled") {
          await runner(`/jobs/${run.id}/cancel`, {
            projectId: run.projectId,
            sessionId: sid,
          });
          return;
        }
        await runner("/jobs", {
          runId: run.id,
          sessionId: sid,
          projectId: session.projectId,
          prompt: body.text,
          assets,
          libraryAssets,
          nativeThreadId: session.nativeThreadId,
          settings,
        });
      })().catch(async (e) => {
        await store.updateRun(run.id, (current) => {
          if (terminal.has(current.status) || current.status === "running")
            return;
          if (current.status !== "cancelling") current.status = "interrupted";
          current.error =
            "任务提交未能确认：" + redact(String(e), [settings.apiKey || ""]);
          current.updatedAt = now();
        });
      });
      dispatches.set(run.id, dispatch);
      void dispatch.catch(() => {}).finally(() => dispatches.delete(run.id));
      return run;
    }),
  );
  app.post("/api/runs/:id/cancel", async (req) => {
    const id = idSchema.parse((req.params as any).id);
    const run = await store.updateRun(id, (current) => {
      if (
        terminal.has(current.status) &&
        !(
          current.status === "interrupted" &&
          current.error?.startsWith("任务提交")
        )
      )
        return;
      current.status = "cancelling";
      current.cancelRequestedAt ||= now();
      current.updatedAt = now();
    });
    if (!run) throw fail("任务不存在", 404);
    if (
      terminal.has(run.status) &&
      !(run.status === "interrupted" && run.error?.startsWith("任务提交"))
    )
      return run;
    try {
      await runner(`/jobs/${id}/cancel`, {
        projectId: run.projectId,
        sessionId: run.sessionId,
      });
    } catch (e) {
      const updated = await store.updateRun(run.id, (current) => {
        if (terminal.has(current.status)) return;
        current.error =
          "停止请求尚未确认，将继续核对执行端状态：" +
          String((e as Error).message);
      });
      if (updated) return updated;
    }
    // The poller imports the worker's final event before settling cancelled.
    return run;
  });
  app.get("/api/runs/:id/events", async (req, reply) => {
    const id = idSchema.parse((req.params as any).id);
    if (!(await store.get("run", id))) throw fail("任务不存在", 404);
    let cursor = Math.max(
      0,
      Number(req.headers["last-event-id"] || (req.query as any).after || 0),
    );
    if (!Number.isSafeInteger(cursor)) cursor = 0;
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");
    let closed = false,
      busy = false,
      lastHeartbeat = Date.now();
    const cleanup = () => {
      closed = true;
      streams.delete(reply.raw);
      clearInterval(timer);
    };
    const write = async (data: string) => {
      if (closed || reply.raw.destroyed) return;
      if (reply.raw.write(data)) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          reply.raw.off("drain", done);
          reply.raw.off("close", done);
          resolve();
        };
        reply.raw.once("drain", done);
        reply.raw.once("close", done);
      });
    };
    const flush = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        // Drain complete history, including all pages of an already finished run.
        // A reconnect must never see "done" after only the first 500 events.
        while (!closed) {
          const events = await store.events(id, cursor, 500);
          for (const e of events) {
            if (closed) break;
            await write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
            cursor = e.seq;
          }
          if (closed) break;
          if (events.length === 500) continue;
          const r = await store.get<Run>("run", id);
          if (r && terminal.has(r.status)) {
            // The run can become terminal while the preceding page is read.
            if ((await store.latestSequence(id)) > cursor) continue;
            await write(`event: done\ndata: ${JSON.stringify({ run: r })}\n\n`);
            reply.raw.end();
            cleanup();
          } else if (Date.now() - lastHeartbeat >= 15000) {
            await write(": heartbeat\n\n");
            lastHeartbeat = Date.now();
          }
          break;
        }
      } catch {
        reply.raw.end();
        cleanup();
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void flush(), 800);
    reply.raw.once("close", cleanup);
    await flush();
  });
  // Resumable uploads: sequential 4 MiB chunks, server offset is authoritative.
  const uploads = new Map<string, Promise<unknown>>();
  app.post("/api/uploads", async (req) => {
    const b = z
      .object({
        projectId: idSchema.optional(),
        destination: z.enum(["project", "library"]).default("project"),
        library: libraryMetadataSchema.optional(),
        name: z.string().min(1).max(200),
        size: z
          .number()
          .int()
          .positive()
          .max(2 * 1024 ** 3),
        folder: z.string().max(100).default(""),
      })
      .parse(req.body);
    if (b.destination === "project") await project(idSchema.parse(b.projectId));
    const disk = await statfs(options.dataRoot);
    if (Number(disk.bavail) * Number(disk.bsize) < b.size + 256 * 1024 ** 2)
      throw fail("可用磁盘不足", 507);
    const ext = path.extname(b.name).toLowerCase();
    if (documentMime(b.name)) {
      if (b.destination === "library")
        throw fail(
          "文档请从对话上传作为参考；素材库用于可复用的图片和 3D 资源",
        );
      if (b.size > MAX_DOCUMENT_BYTES)
        throw fail("文档附件最大 2 MiB；请拆分后上传");
    }
    if (
      ![
        ...DOCUMENT_EXTENSIONS,
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".glb",
        ".gltf",
        ".fbx",
        ".obj",
        ".blend",
        ".hdr",
        ".exr",
        ".bin",
      ].includes(ext)
    )
      throw fail("不支持此文件格式");
    const id = randomUUID(),
      file = safePath(options.dataRoot, "uploads", id + ".part");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "", { flag: "wx", mode: 0o600 });
    const upload = { ...b, id, path: file, offset: 0, createdAt: now() };
    await store.put("upload", id, upload);
    return upload;
  });
  app.get("/api/uploads/:id", async (req) => {
    const u = await store.get<any>(
      "upload",
      idSchema.parse((req.params as any).id),
    );
    if (!u) throw fail("上传不存在", 404);
    if (u.completed)
      return { id: u.id, offset: u.size, size: u.size, assetId: u.assetId };
    return { id: u.id, offset: (await stat(u.path)).size, size: u.size };
  });
  app.patch("/api/uploads/:id", async (req) => {
    const id = idSchema.parse((req.params as any).id);
    if (uploads.has(id)) throw fail("该文件仍有分块正在上传", 409);
    const job = (async () => {
      const u = await store.get<any>("upload", id);
      if (!u || u.completed) throw fail("上传不可写", 409);
      const data = req.body;
      if (!Buffer.isBuffer(data) || data.length === 0)
        throw fail("请发送二进制分块");
      const actual = (await stat(u.path)).size;
      if (Number(req.headers["upload-offset"]) !== actual)
        throw fail(`分块偏移不一致，当前 ${actual}`, 409);
      if (actual + data.length > u.size) throw fail("文件超过声明大小");
      const f = await open(u.path, "a");
      try {
        await f.write(data);
      } finally {
        await f.close();
      }
      u.offset = actual + data.length;
      await store.put("upload", id, u);
      return { offset: u.offset };
    })();
    uploads.set(id, job);
    try {
      return await job;
    } finally {
      uploads.delete(id);
    }
  });
  app.post("/api/uploads/:id/complete", async (req) => {
    const id = idSchema.parse((req.params as any).id);
    if (uploads.has(id)) throw fail("上传仍在进行", 409);
    const job = (async () => {
      const u = await store.get<any>("upload", id);
      if (!u) throw fail("上传不存在", 404);
      if (u.completed)
        return u.destination === "library"
          ? library.get(u.assetId)
          : store.get("asset", u.assetId);
      if (u.destination === "library") {
        const recovered = await library.catalog.get(id);
        if (recovered) {
          u.completed = true;
          u.assetId = id;
          await store.put("upload", id, u);
          await unlink(u.path).catch(() => {});
          await rm(safePath(options.dataRoot, "uploads", id), {
            recursive: true,
            force: true,
          }).catch(() => {});
          return recovered;
        }
      }
      if ((await stat(u.path)).size !== u.size) throw fail("文件尚未上传完整");
      let info;
      if (documentMime(u.name)) {
        try {
          info = documentInfo(await readDocumentFile(u.name, u.path));
        } catch (e) {
          throw fail((e as Error).message);
        }
      }
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(u.path)) hash.update(chunk);
      const sha256 = hash.digest("hex");
      const existing =
        u.destination === "library"
          ? undefined
          : (await store.list<Asset>("asset", u.projectId)).find(
              (a) =>
                a.sha256 === sha256 &&
                documentMime(a.path) === documentMime(u.name),
            );
      if (existing) {
        u.completed = true;
        u.assetId = existing.id;
        await store.put("upload", id, u);
        await unlink(u.path).catch(() => {});
        return existing;
      }
      const ext = path.extname(u.name).toLowerCase();
      let mime: string =
        (
          {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".glb": "model/gltf-binary",
            ".gltf": "model/gltf+json",
            ".obj": "text/plain",
            ".bin": "application/octet-stream",
          } as Record<string, string>
        )[ext] ||
        documentMime(u.name) ||
        "application/octet-stream";
      const assetId = id;
      const directory =
        u.destination === "library"
          ? safePath(options.dataRoot, "uploads", id)
          : safePath(
              options.dataRoot,
              "projects",
              u.projectId,
              "assets",
              assetId,
            );
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, "source" + ext);
      let previewPath: string | undefined;
      if (/^image\//.test(mime)) {
        const meta = await sharp(u.path, {
          limitInputPixels: 80_000_000,
        }).metadata();
        if (!meta.width || !meta.height) throw fail("图片无效");
        previewPath = path.join(directory, "preview.jpg");
        await sharp(u.path)
          .rotate()
          .resize(400, 400, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toFile(previewPath);
      }
      if (ext === ".gltf") {
        const data = JSON.parse(await readFile(u.path, "utf8"));
        const deps = [...(data.buffers || []), ...(data.images || [])].filter(
          (x) => x.uri && !String(x.uri).startsWith("data:"),
        );
        if (deps.length)
          throw fail("首版仅支持内嵌资源的 glTF；请打包成 GLB 后上传");
      }
      if (ext === ".glb") {
        const f = await open(u.path, "r");
        const b = Buffer.alloc(4);
        await f.read(b, 0, 4, 0);
        await f.close();
        if (b.toString() !== "glTF") throw fail("GLB 文件头无效");
      }
      await copyFile(u.path, file);
      const asset: Asset = {
        id: assetId,
        projectId: u.projectId,
        name: u.name,
        path: file,
        previewPath,
        mime,
        size: u.size,
        sha256,
        kind: [".glb", ".gltf", ".obj", ".fbx", ".blend"].includes(ext)
          ? "model"
          : [".hdr", ".exr"].includes(ext)
            ? "texture"
            : "reference",
        tags: [],
        folder: u.folder,
        createdAt: now(),
        ...(info ? { documentInfo: info } : {}),
      };
      if (u.destination === "library") {
        const result = await library.publish(
          libraryMetadataSchema.parse(
            u.library || { name: u.name, category: "other" },
          ),
          { id, file, preview: previewPath, mime, source: "upload" },
        );
        u.completed = true;
        u.assetId = result.id;
        await store.put("upload", id, u);
        await rm(directory, { recursive: true, force: true }).catch(() => {});
        await unlink(u.path).catch(() => {});
        return result;
      }
      u.completed = true;
      u.assetId = asset.id;
      await store.db.transaction(async (tx) => {
        await store.put("asset", asset.id, asset, tx);
        await store.put("upload", id, u, tx);
      });
      await unlink(u.path).catch(() => {});
      return asset;
    })();
    uploads.set(id, job);
    try {
      return await job;
    } finally {
      uploads.delete(id);
    }
  });
  const library = new AssetLibrary(
    options.dataRoot,
    new LibraryCatalog(store.db),
  );
  app.get("/api/library", async (req) => {
    const q = z
      .object({
        search: z.string().max(200).optional(),
        category: z
          .enum(["all", "character", "prop", "scene", "material", "other"])
          .optional(),
        favorite: z.enum(["true", "false"]).optional(),
        page: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .parse(req.query);
    return library.list({ ...q, favorite: q.favorite === "true" });
  });
  app.patch("/api/library/:id", async (req) =>
    exclusive(req, () =>
      library.update(idSchema.parse((req.params as any).id), req.body),
    ),
  );
  app.get("/api/library/:id", async (req) => {
    const id = idSchema.parse((req.params as any).id);
    const asset = await library.get(id);
    await library.file(id);
    return asset;
  });
  app.post("/api/projects/:id/library", async (req) =>
    exclusive(req, async () => {
      const p = await project((req.params as any).id);
      const input = saveLibrarySchema.parse(req.body);
      await ensureIdle(p.id);
      return runner("/scene", {
        projectId: p.id,
        action: "library-save",
        library: input,
      });
    }),
  );
  app.post("/api/library/:id/import", async (req) =>
    exclusive(req, async () => {
      const id = idSchema.parse((req.params as any).id);
      await library.get(id);
      await library.file(id);
      const body = z.object({ projectId: idSchema }).parse(req.body);
      await project(body.projectId);
      await ensureIdle(body.projectId);
      return runner("/scene", {
        projectId: body.projectId,
        action: "library-import",
        assetId: id,
      });
    }),
  );
  app.post("/api/assets/:id/publish", async (req) =>
    exclusive(req, async () => {
      const asset = await store.get<Asset>(
        "asset",
        idSchema.parse((req.params as any).id),
      );
      if (!asset) throw fail("资源不存在", 404);
      if (documentMime(asset.path))
        throw fail("文档仅作为对话参考，不能发布到 3D 素材库");
      const input = libraryMetadataSchema.parse(req.body);
      const root = safePath(options.dataRoot, "projects", asset.projectId);
      return library.publish(input, {
        projectId: asset.projectId,
        file: await existingSafePath(root, asset.path),
        preview: asset.previewPath
          ? await existingSafePath(root, asset.previewPath)
          : undefined,
        mime: asset.mime,
        source: "upload",
      });
    }),
  );
  app.get("/api/library/:id/file", async (req, reply) => {
    const id = idSchema.parse((req.params as any).id),
      q = req.query as any;
    const asset = await library.get(id),
      preview = q.preview === "true";
    const file = await library.file(id, preview);
    reply.type(preview ? "image/jpeg" : "application/octet-stream");
    if (!preview)
      reply.header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(asset.name.endsWith(path.extname(file)) ? asset.name : asset.name + path.extname(file))}`,
      );
    return reply.send(createReadStream(file));
  });
  app.get("/api/projects/:id/assets", async (req) => {
    const p = await project((req.params as any).id),
      q = req.query as any;
    const search = String(q.search || "")
      .slice(0, 200)
      .toLowerCase();
    const kind = String(q.kind || "all");
    const page = Math.min(100000, Math.max(0, Math.floor(Number(q.page) || 0)));
    const where = `project_id=$1
      AND ($2='' OR position($2 in lower(coalesce(data->>'name','') || ' ' || coalesce(data->>'tags','') || ' ' || coalesce(data->>'folder',''))) > 0)
      AND ($3='all' OR data->>'kind'=$3)`;
    const values = [p.id, search, kind];
    const count = await store.db.query<{ count: number }>(
      `SELECT count(*)::int as count FROM ${store.db.table("assets")} WHERE ${where}`,
      values,
    );
    const rows = await store.db.query<{ data: Asset }>(
      `SELECT data FROM ${store.db.table("assets")} WHERE ${where} ORDER BY created_at DESC,id LIMIT 60 OFFSET $4`,
      [...values, page * 60],
    );
    return {
      items: rows.rows.map((r) => r.data),
      total: count.rows[0].count,
      page,
    };
  });
  app.patch("/api/assets/:id", async (req) => {
    const id = idSchema.parse((req.params as any).id);
    const asset = await store.get<Asset>("asset", id);
    if (!asset) throw fail("资源不存在", 404);
    const patch = z
      .object({
        name: z.string().min(1).max(200).optional(),
        tags: z.array(z.string().max(40)).max(20).optional(),
        folder: z.string().max(100).optional(),
      })
      .parse(req.body);
    Object.assign(asset, patch);
    await store.put("asset", id, asset);
    return asset;
  });
  app.post("/api/assets/:id/import", async (req) =>
    exclusive(req, async () => {
      const asset = await store.get<Asset>(
        "asset",
        idSchema.parse((req.params as any).id),
      );
      if (!asset) throw fail("资源不存在", 404);
      if (documentMime(asset.path))
        throw fail("文档仅作为对话参考，请引用到聊天中，不能导入 Blender");
      await ensureIdle(asset.projectId);
      return runner("/scene", {
        projectId: asset.projectId,
        action: "import",
        path: asset.path,
      });
    }),
  );
  app.get("/api/files/:kind/:id", async (req, reply) => {
    const { kind, id } = z
      .object({
        kind: z.enum(["asset", "capture", "snapshot", "artifact"]),
        id: idSchema,
      })
      .parse(req.params);
    const record = await store.get<any>(kind, id);
    if (!record) throw fail("文件不存在", 404);
    const file = await existingSafePath(
      safePath(options.dataRoot, "projects", record.projectId),
      (req.query as any).preview && record.previewPath
        ? record.previewPath
        : record.path,
    );
    const inline =
      (kind === "capture" ||
        (kind === "asset" && /^image\/(jpeg|png|webp)$/.test(record.mime))) &&
      !(req.query as any).download;
    reply
      .header(
        "Content-Disposition",
        `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(record.name || path.basename(file))}`,
      )
      .type(
        inline
          ? (req.query as any).preview
            ? "image/jpeg"
            : record.mime || "image/jpeg"
          : "application/octet-stream",
      );
    return reply.send(createReadStream(file));
  });
  let syncing = false;
  const sync = async () => {
    if (syncing) return;
    syncing = true;
    try {
      const runs = await store.list<Run>("run");
      for (const run of runs.filter(
        (r) =>
          !terminal.has(r.status) ||
          (r.status === "interrupted" && r.error?.startsWith("任务提交")),
      )) {
        try {
          let remote;
          try {
            if (run.cancelRequestedAt)
              await runner(`/jobs/${run.id}/cancel`, {
                projectId: run.projectId,
                sessionId: run.sessionId,
              });
            remote = await runner("/jobs/" + run.id);
          } catch (e) {
            if (
              (e as any).statusCode === 404 &&
              run.status === "queued" &&
              !dispatches.has(run.id)
            ) {
              await store.updateRun(run.id, (current) => {
                if (current.status !== "queued") return;
                current.status = "interrupted";
                current.error =
                  "任务提交未能确认：执行端未记录该任务；为避免重复操作，没有自动重新执行。";
                current.updatedAt = now();
              });
            }
            continue;
          }
          let cursor = await store.latestSequence(run.id);
          const expected = Number(remote.seq || 0);
          let incomplete = false;
          while (true) {
            const events = await runner(
              `/jobs/${run.id}/events?after=${cursor}&limit=500`,
            );
            if (!Array.isArray(events)) throw new Error("执行事件响应无效");
            if (!events.length) {
              incomplete = cursor < expected;
              break;
            }
            for (const e of events) {
              if (
                e.runId !== run.id ||
                !Number.isSafeInteger(e.seq) ||
                e.seq !== cursor + 1
              )
                throw new Error("执行事件顺序不完整，等待恢复后重试");
              await store.db.transaction(async (tx) => {
                await store.event(e, tx);
                if (e.type === "capture.created")
                  await store.put(
                    "capture",
                    e.payload.capture.id,
                    e.payload.capture,
                    tx,
                  );
                if (e.type === "snapshot.created")
                  await store.put(
                    "snapshot",
                    e.payload.snapshot.id,
                    e.payload.snapshot,
                    tx,
                  );
                if (e.type === "artifact.created")
                  await store.put(
                    "artifact",
                    e.payload.artifact.id,
                    e.payload.artifact,
                    tx,
                  );
                if (e.type === "session.bound") {
                  const session = await store.get<Session>(
                    "session",
                    run.sessionId,
                    tx,
                  );
                  if (session) {
                    session.nativeThreadId = e.payload.nativeThreadId;
                    await store.put("session", session.id, session, tx);
                  }
                }
              });
              cursor = e.seq;
            }
            if (events.length < 500 && cursor >= expected) break;
          }
          // Do not publish a terminal state until every advertised event is durable.
          if (incomplete) continue;
          await store.updateRun(run.id, (current) =>
            Object.assign(current, {
              status:
                current.cancelRequestedAt && !terminal.has(remote.status)
                  ? "cancelling"
                  : remote.status,
              verification: remote.verification,
              error: remote.error,
              nativeThreadId: remote.nativeThreadId,
              updatedAt: remote.updatedAt,
            }),
          );
        } catch {
          // Keep the cursor and retry this project without starving other studios.
          continue;
        }
      }
    } finally {
      syncing = false;
    }
  };
  const poll =
    options.poll === false
      ? undefined
      : setInterval(() => void sync().catch(() => {}), 800);
  poll?.unref();
  const ws = new WebSocketServer({ noServer: true });
  app.server.on("upgrade", async (req, socket, head) => {
    const origin = req.headers.origin;
    let validOrigin = false;
    try {
      validOrigin = !!origin && new URL(origin).host === req.headers.host;
    } catch {}
    const cookies = app.parseCookie(req.headers.cookie || "");
    const desktop = new URL(req.url || "/", "http://localhost");
    const pid = desktop.searchParams.get("projectId") || "";
    if (
      desktop.pathname !== "/desktop" ||
      !idSchema.safeParse(pid).success ||
      !validOrigin ||
      !vault.valid(cookies.pilot_session)
    ) {
      socket.destroy();
      return;
    }
    try {
      if (!(await store.get("project", pid))) {
        socket.destroy();
        return;
      }
    } catch {
      socket.destroy();
      return;
    }
    ws.handleUpgrade(req, socket, head, (client) => {
      const remote = new WebSocket(
        options.runnerUrl.replace(/^http/, "ws") +
          "/vnc?projectId=" +
          encodeURIComponent(pid),
        { headers: { authorization: `Bearer ${options.internalToken}` } },
      );
      const pending: Buffer[] = [];
      let pendingBytes = 0;
      client.on("message", (d) => {
        const b = Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer);
        if (remote.readyState === 1) remote.send(b);
        else if ((pendingBytes += b.length) < 4 * 1024 * 1024) pending.push(b);
        else client.close();
      });
      remote.on("open", () => pending.forEach((d) => remote.send(d)));
      remote.on("message", (d) => {
        if (client.readyState === 1) client.send(d);
      });
      remote.on("error", () => client.close());
      client.on("error", () => remote.close());
      remote.on("close", () => client.close());
      client.on("close", () => remote.close());
    });
  });
  if (options.webRoot) {
    await app.register(staticPlugin, { root: options.webRoot, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/"))
        return reply.code(404).send({ error: "接口不存在" });
      return reply.sendFile("index.html");
    });
  }
  app.addHook("preClose", async () => {
    if (poll) clearInterval(poll);
    shutdownController.abort();
    for (const stream of streams) stream.end();
    for (const client of ws.clients) client.terminate();
    await Promise.allSettled([...operations.values()]);
    await Promise.allSettled([...dispatches.values()]);
    while (syncing) await new Promise<void>((resolve) => setImmediate(resolve));
  });
  app.addHook("onClose", async () => {
    if (poll) clearInterval(poll);
    ws.close();
    await store.db.close();
  });
  return { app, store, sync };
}
