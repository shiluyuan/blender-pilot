import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import staticPlugin from "@fastify/static";
import { WebSocket, WebSocketServer } from "ws";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdir,
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
  AssetLibrary,
  libraryMetadataSchema,
  saveLibrarySchema,
} from "../../packages/blender-bridge/library.js";
import { Store } from "./db.js";
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
  const store = new Store(options.dataRoot);
  await store.init();
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
    if (req.url === "/api/auth/login" || req.url === "/api/auth/status") return;
    if (!vault.valid(req.cookies.pilot_session))
      return reply.code(401).send({ error: "请先登录" });
  });
  app.setErrorHandler((error: any, _req, reply) =>
    reply
      .code(error instanceof z.ZodError ? 400 : error.statusCode || 500)
      .send({
        error:
          error instanceof z.ZodError
            ? error.issues.map((x: any) => x.message).join("；")
            : error.message || "操作失败",
      }),
  );
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
  let operation: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>) => {
    const job = operation.catch(() => {}).then(fn);
    operation = job;
    return job;
  };
  const ensureIdle = async () => {
    const runs = await store.list<Run>("run");
    if (runs.some((r) => !terminal.has(r.status)))
      throw fail("已有任务正在运行，请先停止或等待完成", 409);
  };
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
      execution,
      storage: {
        free: Number(disk.bavail) * Number(disk.bsize),
        total: Number(disk.blocks) * Number(disk.bsize),
      },
      model: await publicModel(),
      versions: {
        app: "0.1.0",
        codex: "0.164.0",
        mcp: "2.2.2",
        blender: "4.5.4",
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
    exclusive(async () => {
      await ensureIdle();
      const p = await project((req.params as any).id);
      const result = await runner("/scene", {
        projectId: p.id,
        action: "activate",
      });
      await store.put("config", "active", { projectId: p.id });
      return result;
    }),
  );
  app.get("/api/active", async () => store.get("config", "active"));
  app.get("/api/projects/:id/scene", async (req) =>
    exclusive(async () => {
      await ensureIdle();
      const p = await project((req.params as any).id);
      return runner("/scene", { projectId: p.id, action: "info" });
    }),
  );
  app.post("/api/projects/:id/captures", async (req) =>
    exclusive(async () => {
      await ensureIdle();
      const p = await project((req.params as any).id);
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
    exclusive(async () => {
      await ensureIdle();
      const p = await project((req.params as any).id);
      return runner("/scene", { projectId: p.id, action: "save" });
    }),
  );
  app.get("/api/projects/:id/snapshots", async (req) =>
    store.list("snapshot", (await project((req.params as any).id)).id),
  );
  app.post("/api/projects/:id/snapshots", async (req) =>
    exclusive(async () => {
      await ensureIdle();
      const p = await project((req.params as any).id);
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
    exclusive(async () => {
      await ensureIdle();
      const id = idSchema.parse((req.params as any).id);
      const s = await store.get<any>("snapshot", id);
      if (!s) throw fail("快照不存在", 404);
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
    exclusive(async () => {
      await ensureIdle();
      const p = await project((req.params as any).id);
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
  app.post("/api/sessions/:id/turns", async (req) =>
    exclusive(async () => {
      const sid = idSchema.parse((req.params as any).id);
      const body = z
        .object({
          text: z.string().trim().min(1).max(16000),
          assetIds: z.array(idSchema).max(12).default([]),
          clientRequestId: idSchema,
        })
        .parse(req.body);
      const prior = (
        await store.db.query<{ run_id: string }>(
          "SELECT run_id FROM requests WHERE key=$1",
          [sid + ":" + body.clientRequestId],
        )
      ).rows[0];
      if (prior) return store.get("run", prior.run_id);
      await ensureIdle();
      const session = await store.get<Session>("session", sid);
      if (!session) throw fail("对话不存在", 404);
      const settings = await model();
      const assets = [];
      for (const id of body.assetIds) {
        const asset =
          (await store.get<Asset>("asset", id)) ||
          (await store.get<any>("capture", id));
        if (!asset || asset.projectId !== session.projectId)
          throw fail("引用资源不属于当前项目");
        assets.push({
          id: asset.id,
          name: asset.name || "场景截图",
          path: asset.path,
          mime: asset.mime,
        });
      }
      const run: Run = {
        id: randomUUID(),
        sessionId: sid,
        projectId: session.projectId,
        prompt: body.text,
        assetIds: body.assetIds,
        status: "queued",
        verification: "pending",
        createdAt: now(),
        updatedAt: now(),
      };
      await store.db.transaction(async (tx) => {
        await tx.query("INSERT INTO requests VALUES($1,$2)", [
          sid + ":" + body.clientRequestId,
          run.id,
        ]);
        await tx.query("INSERT INTO records VALUES($1,$2,$3)", [
          "run",
          run.id,
          JSON.stringify(run),
        ]);
      });
      if (session.title === "新对话") {
        session.title = body.text.slice(0, 28);
        await store.put("session", sid, session);
      }
      try {
        await runner("/jobs", {
          runId: run.id,
          sessionId: sid,
          projectId: session.projectId,
          prompt: body.text,
          assets,
          nativeThreadId: session.nativeThreadId,
          settings,
        });
      } catch (e) {
        run.status = "interrupted";
        run.error =
          "任务提交未能确认：" + redact(String(e), [settings.apiKey || ""]);
        await store.put("run", run.id, run);
      }
      return run;
    }),
  );
  app.post("/api/runs/:id/cancel", async (req) => {
    const id = idSchema.parse((req.params as any).id);
    const run = await store.get<Run>("run", id);
    if (!run) throw fail("任务不存在", 404);
    return runner(`/jobs/${id}/cancel`, {});
  });
  app.get("/api/runs/:id/events", async (req, reply) => {
    const id = idSchema.parse((req.params as any).id);
    if (!(await store.get("run", id))) throw fail("任务不存在", 404);
    let cursor = Math.max(
      0,
      Number(req.headers["last-event-id"] || (req.query as any).after || 0),
    );
    if (!Number.isFinite(cursor)) cursor = 0;
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.once("close", () => streams.delete(reply.raw));
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");
    let closed = false,
      busy = false;
    const flush = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const events = await store.events(id, cursor);
        for (const e of events) {
          if (closed) break;
          reply.raw.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
          cursor = e.seq;
        }
        const r = await store.get<Run>("run", id);
        if (r && terminal.has(r.status)) {
          reply.raw.write(`event: done\ndata: {}\n\n`);
          reply.raw.end();
          clearInterval(timer);
        }
      } catch {
        reply.raw.end();
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void flush(), 800);
    req.raw.on("close", () => {
      closed = true;
      clearInterval(timer);
    });
    await flush();
  });
  // Resumable uploads: sequential 4 MiB chunks, server offset is authoritative.
  const uploads = new Map<string, Promise<unknown>>();
  app.post("/api/uploads", async (req) => {
    const b = z
      .object({
        projectId: idSchema,
        name: z.string().min(1).max(200),
        size: z
          .number()
          .int()
          .positive()
          .max(2 * 1024 ** 3),
        folder: z.string().max(100).default(""),
      })
      .parse(req.body);
    await project(b.projectId);
    const disk = await statfs(options.dataRoot);
    if (Number(disk.bavail) * Number(disk.bsize) < b.size + 256 * 1024 ** 2)
      throw fail("可用磁盘不足", 507);
    const ext = path.extname(b.name).toLowerCase();
    if (
      ![
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
      if (u.completed) return store.get("asset", u.assetId);
      if ((await stat(u.path)).size !== u.size) throw fail("文件尚未上传完整");
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(u.path)) hash.update(chunk);
      const sha256 = hash.digest("hex");
      const existing = (await store.list<Asset>("asset", u.projectId)).find(
        (a) => a.sha256 === sha256,
      );
      if (existing) {
        await unlink(u.path);
        u.completed = true;
        u.assetId = existing.id;
        await store.put("upload", id, u);
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
        )[ext] || "application/octet-stream";
      const assetId = randomUUID();
      const directory = safePath(
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
      await rename(u.path, file);
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
      };
      await store.put("asset", asset.id, asset);
      u.completed = true;
      u.assetId = asset.id;
      await store.put("upload", id, u);
      return asset;
    })();
    uploads.set(id, job);
    try {
      return await job;
    } finally {
      uploads.delete(id);
    }
  });
  const library = new AssetLibrary(options.dataRoot);
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
    exclusive(() =>
      library.update(idSchema.parse((req.params as any).id), req.body),
    ),
  );
  app.post("/api/projects/:id/library", async (req) =>
    exclusive(async () => {
      const p = await project((req.params as any).id);
      const input = saveLibrarySchema.parse(req.body);
      await ensureIdle();
      return runner("/scene", {
        projectId: p.id,
        action: "library-save",
        library: input,
      });
    }),
  );
  app.post("/api/library/:id/import", async (req) =>
    exclusive(async () => {
      const id = idSchema.parse((req.params as any).id);
      await library.get(id);
      const body = z.object({ projectId: idSchema }).parse(req.body);
      await project(body.projectId);
      await ensureIdle();
      return runner("/scene", {
        projectId: body.projectId,
        action: "library-import",
        assetId: id,
      });
    }),
  );
  app.post("/api/assets/:id/publish", async (req) =>
    exclusive(async () => {
      const asset = await store.get<Asset>(
        "asset",
        idSchema.parse((req.params as any).id),
      );
      if (!asset) throw fail("资源不存在", 404);
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
    const where = `kind='asset' AND data->>'projectId'=$1
      AND ($2='' OR position($2 in lower(coalesce(data->>'name','') || ' ' || coalesce(data->>'tags','') || ' ' || coalesce(data->>'folder',''))) > 0)
      AND ($3='all' OR data->>'kind'=$3)`;
    const values = [p.id, search, kind];
    const count = await store.db.query<{ count: number }>(
      `SELECT count(*)::int as count FROM records WHERE ${where}`,
      values,
    );
    const rows = await store.db.query<{ data: Asset }>(
      `SELECT data FROM records WHERE ${where} ORDER BY data->>'createdAt' DESC LIMIT 60 OFFSET $4`,
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
    exclusive(async () => {
      await ensureIdle();
      const asset = await store.get<Asset>(
        "asset",
        idSchema.parse((req.params as any).id),
      );
      if (!asset) throw fail("资源不存在", 404);
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
        let remote;
        try {
          remote = await runner("/jobs/" + run.id);
        } catch {
          continue;
        }
        const known = await store.events(run.id);
        const events = await runner(
          `/jobs/${run.id}/events?after=${known.at(-1)?.seq || 0}`,
        );
        for (const e of events) {
          await store.event(e);
          if (e.type === "capture.created")
            await store.put("capture", e.payload.capture.id, e.payload.capture);
          if (e.type === "snapshot.created")
            await store.put(
              "snapshot",
              e.payload.snapshot.id,
              e.payload.snapshot,
            );
          if (e.type === "artifact.created")
            await store.put(
              "artifact",
              e.payload.artifact.id,
              e.payload.artifact,
            );
          if (e.type === "session.bound") {
            const session = await store.get<Session>("session", run.sessionId);
            if (session) {
              session.nativeThreadId = e.payload.nativeThreadId;
              await store.put("session", session.id, session);
            }
          }
        }
        Object.assign(run, {
          status: remote.status,
          verification: remote.verification,
          error: remote.error,
          nativeThreadId: remote.nativeThreadId,
          updatedAt: remote.updatedAt,
        });
        await store.put("run", run.id, run);
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
  app.server.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin;
    let validOrigin = false;
    try {
      validOrigin = !!origin && new URL(origin).host === req.headers.host;
    } catch {}
    const cookies = app.parseCookie(req.headers.cookie || "");
    if (
      req.url !== "/desktop" ||
      !validOrigin ||
      !vault.valid(cookies.pilot_session)
    ) {
      socket.destroy();
      return;
    }
    ws.handleUpgrade(req, socket, head, (client) => {
      const remote = new WebSocket(
        options.runnerUrl.replace(/^http/, "ws") + "/vnc",
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
    await operation.catch(() => {});
    while (syncing) await new Promise<void>((resolve) => setImmediate(resolve));
  });
  app.addHook("onClose", async () => {
    if (poll) clearInterval(poll);
    ws.close();
    await store.db.close();
  });
  return { app, store, sync };
}
