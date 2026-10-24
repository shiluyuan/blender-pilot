import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { connect } from "node:net";
import { mkdir } from "node:fs/promises";
import { StudioPool } from "./pool.js";
import { StartupJobs } from "./dispatch.js";
import { collectRunnerHealth } from "./health.js";
import { saveLibrarySchema } from "../../packages/blender-bridge/library.js";
import { toolDefinitions } from "./jobs.js";
import { equal } from "../server/security.js";
import {
  idSchema,
  modelSettingsSchema,
} from "../../packages/contracts/index.js";
import { z } from "zod";
import { existingSafePath } from "../../packages/contracts/fs.js";
const dataRoot = process.env.PILOT_DATA || "/data";
await mkdir(dataRoot, { recursive: true });
const token = process.env.PILOT_INTERNAL_TOKEN;
if (!token || token.length < 24)
  throw new Error("PILOT_INTERNAL_TOKEN must contain at least 24 characters");
import {
  sharedDatabase,
  closeSharedDatabase,
} from "../../packages/storage/database.js";
await sharedDatabase().init();
const pool = new StudioPool(dataRoot);
await pool.init();
const queuedJobs = new StartupJobs(pool);
const app = Fastify({ bodyLimit: 3 * 1024 * 1024, logger: false });
app.addHook("onRequest", async (req, reply) => {
  const value = req.headers.authorization?.replace(/^Bearer /, "") || "";
  const allowed = req.url.startsWith("/mcp/")
    ? pool.byToken(value)?.active?.token
    : token;
  if (!allowed || !equal(value, allowed))
    return reply.code(401).send({ error: "Unauthorized" });
});
app.setErrorHandler((e: any, req, reply) => {
  reply
    .code(
      e instanceof z.ZodError
        ? 400
        : e.statusCode || (e.message?.includes("正在") ? 409 : 500),
    )
    .send({ error: e.message || "Runner failed" });
});
app.get("/health", async (_req, reply) => {
  const health = await collectRunnerHealth(
    pool,
    sharedDatabase(),
    queuedJobs.all(),
  );
  if (!health.ok) reply.code(503);
  return health;
});
app.post("/projects/:id/close", async (req) => {
  await pool.close(idSchema.parse((req.params as any).id));
  return { ok: true };
});
app.get("/jobs", async () => queuedJobs.all());
app.get("/jobs/:id", async (req) => {
  const id = idSchema.parse((req.params as any).id);
  const state = queuedJobs.get(id);
  if (!state) throw Object.assign(new Error("任务不存在"), { statusCode: 404 });
  return state;
});
app.get("/jobs/:id/events", async (req) => {
  const query = z
    .object({
      after: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(500).default(500),
    })
    .parse(req.query);
  return (pool.history.events.get(idSchema.parse((req.params as any).id)) || [])
    .filter((e) => e.seq > query.after)
    .slice(0, query.limit);
});
app.post("/jobs", async (req) => {
  const input = z
    .object({
      runId: idSchema,
      projectId: idSchema,
      sessionId: idSchema,
      prompt: z.string().min(1).max(16000),
      nativeThreadId: z.string().optional(),
      settings: modelSettingsSchema,
      libraryAssets: z
        .array(z.object({ id: idSchema, name: z.string() }))
        .max(12)
        .optional(),
      assets: z
        .array(
          z.object({
            id: idSchema,
            name: z.string(),
            path: z.string(),
            mime: z.string(),
          }),
        )
        .max(12),
    })
    .parse(req.body);
  return queuedJobs.submit(input);
});
app.post("/jobs/:id/cancel", async (req) => {
  const owner = z
    .object({ projectId: idSchema, sessionId: idSchema })
    .optional()
    .parse(
      req.body && Object.keys(req.body as any).length ? req.body : undefined,
    );
  return queuedJobs.cancel(idSchema.parse((req.params as any).id), owner);
});
app.get("/mcp/tools", async () => ({ tools: toolDefinitions }));
app.post("/mcp/call", async (req) => {
  const body = z
    .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) })
    .parse(req.body);
  return pool
    .byToken(req.headers.authorization!.replace(/^Bearer /, ""))!
    .tool(body.name, body.arguments);
});
app.post("/scene", async (req) => {
  const body = z
    .object({
      projectId: idSchema,
      action: z.enum([
        "activate",
        "info",
        "capture",
        "save",
        "snapshot",
        "restore",
        "export",
        "import",
        "library-save",
        "library-import",
      ]),
      library: saveLibrarySchema.optional(),
      assetId: idSchema.optional(),
      name: z.string().optional(),
      path: z.string().optional(),
      format: z.enum(["glb", "gltf", "blend"]).optional(),
    })
    .parse(req.body);
  const { scene, jobs } = await pool.open(body.projectId);
  if (body.action === "activate")
    return { projectId: body.projectId, status: "ready" };
  if (jobs.active) throw new Error("该项目任务正在执行，请先停止");
  return scene.serial(async () => {
    await scene.activate(body.projectId);
    switch (body.action) {
      case "activate":
      case "info":
        return scene.info();
      case "capture":
        return (await scene.capture(body.projectId, "manual")).capture;
      case "save":
        return { path: await scene.save() };
      case "snapshot":
        return scene.snapshot(body.name || "手动快照");
      case "restore":
        return scene.restore(
          body.projectId,
          await existingSafePath(
            scene.projectRoot(body.projectId),
            body.path || "",
          ),
        );
      case "export":
        return { path: await scene.export(body.format || "glb") };
      case "library-save":
        return scene.saveLibraryAsset(saveLibrarySchema.parse(body.library));
      case "library-import":
        return scene.importLibraryAsset(idSchema.parse(body.assetId));
      case "import":
        return {
          result: await scene.import(
            await existingSafePath(
              scene.projectRoot(body.projectId),
              body.path || "",
            ),
          ),
        };
    }
  });
});
// noVNC over the same authenticated gateway; no raw VNC socket is published.
const ws = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
app.server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", "http://localhost");
  const projectId = url.searchParams.get("projectId") || "";
  const studio = pool.studios.get(projectId);
  if (
    url.pathname !== "/vnc" ||
    !studio ||
    studio.status !== "ready" ||
    !equal(request.headers.authorization?.replace(/^Bearer /, "") || "", token)
  ) {
    socket.destroy();
    return;
  }
  ws.handleUpgrade(request, socket, head, (client) => {
    const tcp = connect({
      host: "127.0.0.1",
      port: studio.vncPort,
    });
    tcp.on("data", (d) => {
      if (client.readyState === 1) client.send(d);
    });
    client.on("message", (d) =>
      tcp.write(Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer)),
    );
    tcp.on("error", () => client.close());
    client.on("error", () => tcp.destroy());
    client.on("close", () => tcp.destroy());
    tcp.on("close", () => client.close());
  });
});
await app.listen({
  host: process.env.RUNNER_HOST || "0.0.0.0",
  port: Number(process.env.RUNNER_PORT || 8091),
});
console.log("Blender Pilot runner ready");
let shutdownPromise: Promise<void> | undefined;
const shutdown = () =>
  (shutdownPromise ||= (async () => {
    for (const client of ws.clients) client.terminate();
    const queuedShutdown = queuedJobs.shutdown();
    await pool.shutdown();
    await queuedShutdown;
    await closeSharedDatabase();
    await app.close();
    process.exit(0);
  })());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
