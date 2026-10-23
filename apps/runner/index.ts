import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { connect } from "node:net";
import { mkdir } from "node:fs/promises";
import { SceneBridge } from "../../packages/blender-bridge/scene.js";
import { saveLibrarySchema } from "../../packages/blender-bridge/library.js";
import { Jobs, toolDefinitions } from "./jobs.js";
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
const scene = new SceneBridge(dataRoot);
await scene.init();
const jobs = new Jobs(dataRoot, scene);
await jobs.init();
const app = Fastify({ bodyLimit: 3 * 1024 * 1024, logger: false });
app.addHook("onRequest", async (req, reply) => {
  const value = req.headers.authorization?.replace(/^Bearer /, "") || "";
  const allowed = req.url.startsWith("/mcp/") ? jobs.active?.token : token;
  if (!allowed || !equal(value, allowed))
    return reply.code(401).send({ error: "Unauthorized" });
});
app.setErrorHandler((e: any, req, reply) => {
  reply
    .code(
      e instanceof z.ZodError ? 400 : e.message?.includes("正在") ? 409 : 500,
    )
    .send({ error: e.message || "Runner failed" });
});
app.get("/health", async () => {
  let blender = false,
    error: string | undefined;
  try {
    await scene.upstream.connect();
    if (!jobs.active) await scene.serial(() => scene.info());
    blender = true;
  } catch (e) {
    error = String(e);
  }
  return {
    ok: blender,
    blender,
    activeProject: scene.activeProject,
    generation: scene.generation,
    runId: jobs.active?.state.id,
    activeRun: jobs.active
      ? {
          id: jobs.active.state.id,
          projectId: jobs.active.state.projectId,
          sessionId: jobs.active.state.sessionId,
        }
      : undefined,
    error,
  };
});
app.get("/jobs", async () => [...jobs.states.keys()].map((id) => jobs.get(id)));
app.get("/jobs/:id", async (req) => {
  const id = idSchema.parse((req.params as any).id);
  const s = jobs.get(id);
  if (!s) throw new Error("任务不存在");
  return s;
});
app.get("/jobs/:id/events", async (req) => {
  const id = idSchema.parse((req.params as any).id);
  return (jobs.events.get(id) || []).filter(
    (e) => e.seq > Number((req.query as any).after || 0),
  );
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
  return jobs.start(input);
});
app.post("/jobs/:id/cancel", async (req) =>
  jobs.cancel(idSchema.parse((req.params as any).id)),
);
app.get("/mcp/tools", async () => ({ tools: toolDefinitions }));
app.post("/mcp/call", async (req) => {
  const body = z
    .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) })
    .parse(req.body);
  return jobs.tool(body.name, body.arguments);
});
app.post("/scene", async (req) => {
  if (jobs.active) throw new Error("任务正在执行，请先停止");
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
  if (
    request.url !== "/vnc" ||
    !equal(request.headers.authorization?.replace(/^Bearer /, "") || "", token)
  ) {
    socket.destroy();
    return;
  }
  ws.handleUpgrade(request, socket, head, (client) => {
    const tcp = connect({
      host: "127.0.0.1",
      port: Number(process.env.VNC_PORT || 5900),
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
const shutdown = async () => {
  if (jobs.active) await jobs.cancel(jobs.active.state.id);
  await app.close();
  await scene.upstream.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
