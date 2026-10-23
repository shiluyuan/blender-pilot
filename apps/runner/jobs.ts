import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { mkdir, readFile, readdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SceneBridge, receipt } from "../../packages/blender-bridge/scene.js";
import {
  CodexRuntime,
  type CodexInput,
} from "../../packages/runtime-adapters/codex.js";
import { terminal } from "../../packages/contracts/index.js";
import type {
  StartJob,
  PilotEvent,
  Capture,
  RunStatus,
} from "../../packages/contracts/index.js";
import {
  atomicJson,
  now,
  redact,
  existingSafePath,
} from "../../packages/contracts/fs.js";
export interface JobState {
  id: string;
  projectId: string;
  sessionId: string;
  status: RunStatus;
  verification: string;
  nativeThreadId?: string;
  error?: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}
export class Jobs {
  active?: {
    state: JobState;
    input: StartJob;
    token: string;
    abort: AbortController;
    runtime?: CodexRuntime;
    captures: Capture[];
    mutations: number;
    calls: number;
    report?: { captureId: string; passed: boolean; observations: string };
    review?: { repairsLeft: number; allowWrite: boolean };
  };
  states = new Map<string, JobState>();
  events = new Map<string, PilotEvent[]>();
  private persistence = Promise.resolve();
  constructor(
    public root: string,
    public scene: SceneBridge,
  ) {}
  async init() {
    await mkdir(path.join(this.root, "jobs"), { recursive: true });
    for (const f of await readdir(path.join(this.root, "jobs"))) {
      if (!f.endsWith(".json")) continue;
      const state = JSON.parse(
        await readFile(path.join(this.root, "jobs", f), "utf8"),
      ) as JobState;
      this.states.set(state.id, state);
      let ev: PilotEvent[] = [];
      try {
        ev = (
          await readFile(
            path.join(this.root, "jobs", state.id + ".ndjson"),
            "utf8",
          )
        )
          .split("\n")
          .filter(Boolean)
          .flatMap((s) => {
            try {
              return [JSON.parse(s)];
            } catch {
              return [];
            }
          });
      } catch {}
      this.events.set(state.id, ev);
      state.seq = Math.max(
        state.seq,
        ev.reduce((max, e) => Math.max(max, e.seq), 0),
      );
      if (["running", "queued", "cancelling"].includes(state.status)) {
        state.status = "interrupted";
        state.error = "执行服务重启，未自动重放场景修改";
        await this.emit(state, "run.status", {
          status: state.status,
          error: state.error,
        });
      }
    }
  }
  async emit(state: JobState, type: string, payload: Record<string, unknown>) {
    const secret = this.active?.input.settings.apiKey || "";
    const safePayload = JSON.parse(redact(JSON.stringify(payload), [secret]));
    const event: PilotEvent = {
      schemaVersion: 1,
      runId: state.id,
      seq: ++state.seq,
      type,
      payload: safePayload,
      time: now(),
    };
    state.updatedAt = event.time;
    const persistedState = { ...state };
    this.persistence = this.persistence.then(async () => {
      await appendFile(
        path.join(this.root, "jobs", state.id + ".ndjson"),
        JSON.stringify(event) + "\n",
        { mode: 0o600 },
      );
      await atomicJson(
        path.join(this.root, "jobs", state.id + ".json"),
        persistedState,
      );
      (
        this.events.get(state.id) ||
        this.events.set(state.id, []).get(state.id)!
      ).push(event);
    });
    await this.persistence;
    return event;
  }
  async start(input: StartJob) {
    const prior = this.states.get(input.runId);
    if (prior) return prior;
    if (this.active) throw new Error("已有任务正在操作 Blender");
    const state: JobState = {
      id: input.runId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      status: "queued",
      verification: "pending",
      seq: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    this.states.set(state.id, state);
    this.active = {
      state,
      input,
      token: randomUUID(),
      abort: new AbortController(),
      captures: [],
      mutations: 0,
      calls: 0,
    };
    await this.emit(state, "run.status", { status: "queued" });
    void this.execute().catch((e) =>
      console.error(
        "Job cleanup failed",
        redact(String(e), [input.settings.apiKey || ""]),
      ),
    );
    return state;
  }
  private async capture(phase: string) {
    const active = this.active!;
    if (active.captures.length >= 8) throw new Error("本轮截图预算已用完");
    const result = await this.scene.capture(
      active.state.projectId,
      phase,
      active.state.id,
    );
    active.captures.push(result.capture);
    await this.emit(active.state, "capture.created", {
      capture: result.capture,
    });
    return result;
  }
  private async execute() {
    const a = this.active!,
      state = a.state;
    try {
      state.status = "running";
      await this.emit(state, "run.status", { status: "running" });
      await this.scene.serial(async () => {
        await this.scene.activate(state.projectId);
        const snapshot = await this.scene.snapshot("AI 操作前", state.id);
        await this.emit(state, "snapshot.created", { snapshot });
      });
      const baseline = await this.scene.serial(() => this.capture("before"));
      const root = this.scene.projectRoot(state.projectId);
      const proxyPath = fileURLToPath(
        new URL("../../packages/blender-bridge/mcp-proxy.js", import.meta.url),
      );
      const dev = import.meta.url.endsWith(".ts");
      const runtime = new CodexRuntime({
        home: path.join(this.root, "runtime", state.sessionId),
        cwd: root,
        settings: a.input.settings,
        runnerUrl:
          process.env.PILOT_RUNNER_LOCAL_URL ||
          `http://127.0.0.1:${process.env.RUNNER_PORT || 8091}`,
        runToken: a.token,
        proxyCommand: process.execPath,
        proxyArgs: dev
          ? [
              "--import",
              import.meta.resolve("tsx"),
              proxyPath.replace(/\.js$/, ".ts"),
            ]
          : [proxyPath],
        onEvent: (method, params) => {
          if (method === "diagnostic" && process.env.PILOT_DEBUG === "true")
            console.error(params.message);
          if (method === "item/agentMessage/delta")
            void this.emit(state, "message.delta", {
              itemId: params.itemId,
              delta: params.delta,
            });
          else if (
            method === "item/completed" &&
            params.item?.type === "agentMessage"
          )
            void this.emit(state, "message.completed", {
              itemId: params.item.id,
              text: params.item.text,
            });
          else if (method === "thread/tokenUsage/updated")
            void this.emit(state, "usage", { usage: params.tokenUsage });
          else if (method === "error")
            void this.emit(state, "diagnostic", {
              message: params.error?.message || "Codex error",
            });
        },
      });
      a.runtime = runtime;
      state.nativeThreadId = await runtime.start(
        a.input.nativeThreadId,
        a.abort.signal,
      );
      await this.emit(state, "session.bound", {
        nativeThreadId: state.nativeThreadId,
      });
      const input: CodexInput[] = [
        {
          type: "text",
          text:
            a.input.prompt +
            "\n\nProject resources (only explicit imports modify Blender):\n" +
            JSON.stringify(
              a.input.assets.map((x) => ({
                id: x.id,
                name: x.name,
                mime: x.mime,
              })),
            ) +
            "\nAttached baseline capture: " +
            baseline.capture.id,
        },
        { type: "localImage", path: baseline.capture.path },
      ];
      for (const asset of a.input.assets) {
        const actual = await existingSafePath(root, asset.path);
        if (/^image\/(png|jpeg|webp)$/.test(asset.mime)) {
          const imageDir = path.join(
            this.root,
            "runtime",
            state.sessionId,
            "inputs",
          );
          await mkdir(imageDir, { recursive: true });
          const imagePath = path.join(imageDir, asset.id + ".jpg");
          await sharp(actual, { limitInputPixels: 80_000_000 })
            .rotate()
            .resize({
              width: 1600,
              height: 1600,
              fit: "inside",
              withoutEnlargement: true,
            })
            .jpeg({ quality: 82 })
            .toFile(imagePath);
          input.push({ type: "localImage", path: imagePath });
        }
      }
      await runtime.turn(input, a.abort.signal);
      a.review = { repairsLeft: 2, allowWrite: true };
      // End-of-turn verification is enforced outside the model's self-reported completion.
      for (let round = 0; round < 3 && !a.abort.signal.aborted; round++) {
        if (a.report?.passed) {
          const current = await this.scene.serial(() => this.scene.info());
          const cap = a.captures.find((c) => c.id === a.report!.captureId);
          if (cap?.sceneRevision === current.revision) break;
          a.report = undefined;
        }
        if (a.captures.length >= 8) break;
        a.review.allowWrite = round < 2;
        const final = await this.scene.serial(() => this.capture("final"));
        await runtime.turn(
          [
            {
              type: "text",
              text: `Verify the current scene against the original request. Attached captureId=${final.capture.id}. Call report_verification with concrete visual observations. ${round < 2 ? "If needed, at most one small correction then inspect the updated image." : "Budget exhausted: do not mutate, report remaining differences."} Original request: ${a.input.prompt}`,
            },
            { type: "localImage", path: final.capture.path },
          ],
          a.abort.signal,
        );
        if (a.report?.passed) break;
      }
      if (a.abort.signal.aborted) {
        state.status = "cancelled";
        state.verification = "unavailable";
      } else {
        state.verification = a.report?.passed
          ? "passed"
          : a.report
            ? "failed"
            : "unavailable";
        state.status =
          state.verification === "passed" ? "succeeded" : "interrupted";
        if (state.status === "interrupted")
          state.error = "场景执行已结束，视觉检查未通过或未完成";
        await this.scene.serial(async () => {
          await this.scene.save();
          const snapshot = await this.scene.snapshot("AI 操作结果", state.id);
          await this.emit(state, "snapshot.created", { snapshot });
        });
      }
    } catch (e) {
      state.status = a.abort.signal.aborted
        ? "cancelled"
        : /超时|timed out|closed|进程结束/i.test(String(e))
          ? "interrupted"
          : "failed";
      state.error = redact(String(e), [a.input.settings.apiKey || ""]);
      state.verification = "unavailable";
    } finally {
      await a.runtime?.close();
      await this.scene.idle();
      await this.emit(state, "run.status", {
        status: state.status,
        verification: state.verification,
        error: state.error,
      });
      if (this.active === a) this.active = undefined;
    }
  }
  get(id: string): JobState | undefined {
    const state = this.states.get(id);
    if (!state) return undefined;
    // Do not publish completion before the final event is durable and the
    // scene lock is released. Otherwise the gateway can stop polling early.
    if (this.active?.state.id === id && terminal.has(state.status)) {
      return {
        ...state,
        status: this.active.abort.signal.aborted ? "cancelling" : "running",
      };
    }
    return { ...state };
  }
  async cancel(id: string) {
    const a = this.active;
    if (!a || a.state.id !== id || terminal.has(a.state.status))
      return this.get(id);
    a.state.status = "cancelling";
    a.abort.abort();
    await this.emit(a.state, "run.status", { status: "cancelling" });
    return a.state;
  }
  async tool(name: string, args: any) {
    const a = this.active;
    if (!a || a.abort.signal.aborted) throw new Error("任务已停止");
    if (++a.calls > 40) throw new Error("工具调用预算已用完");
    return this.scene.serial(async () => {
      if (a !== this.active || a.abort.signal.aborted)
        throw new Error("任务已停止");
      this.scene.assertProject(a.state.projectId);
      const callId = randomUUID();
      await this.emit(a.state, "tool.started", { callId, name, args });
      try {
        let result: unknown;
        let image: any;
        let cap: Capture | undefined;
        if (name === "get_scene_info") result = await this.scene.info();
        else if (name === "query_blender_api")
          result = await this.scene.queryApi(String(args.target));
        else if (name === "capture") {
          const r = await this.capture("inspection");
          cap = r.capture;
          image = r.image;
          result = { capture: cap };
        } else if (name === "report_verification") {
          if (
            typeof args.captureId !== "string" ||
            typeof args.passed !== "boolean" ||
            typeof args.observations !== "string" ||
            args.observations.trim().length < 3 ||
            args.observations.length > 4000
          )
            throw new Error("检查报告需要当前截图、明确结论和具体观察");
          const chosen = a.captures.find((c) => c.id === args.captureId);
          if (!chosen) throw new Error("未知截图，请先 capture");
          const current = await this.scene.info();
          if (chosen.sceneRevision !== current.revision)
            throw new Error("截图已过期，请重新 capture 后检查");
          a.report = {
            captureId: chosen.id,
            passed: args.passed === true,
            observations: String(args.observations),
          };
          result = a.report;
          await this.emit(a.state, "verification", { ...a.report });
        } else if (name === "save_scene")
          result = { path: await this.scene.save() };
        else if (name === "export_scene") {
          const format = String(args.format);
          if (!["glb", "gltf", "blend"].includes(format))
            throw new Error("不支持导出格式");
          const file = await this.scene.export(format as any);
          const artifact = {
            id: randomUUID(),
            projectId: a.state.projectId,
            path: file,
            name: path.basename(file),
            kind: "export",
            createdAt: now(),
          };
          await this.emit(a.state, "artifact.created", { artifact });
          result = artifact;
        } else if (name === "execute_blender_code" || name === "import_asset") {
          if (a.review) {
            if (!a.review.allowWrite || a.review.repairsLeft <= 0)
              throw new Error("最终检查的修正预算已用完，请报告剩余差异");
            a.review.repairsLeft--;
          }
          if (a.captures.length >= 7)
            throw new Error("已保留最后一张截图额度，请结束修改并检查");
          const before = await this.scene.info();
          let error: unknown;
          try {
            if (name === "execute_blender_code") {
              if (typeof args.code !== "string" || args.code.length > 40000)
                throw new Error("代码为空或超过长度限制");
              result = await this.scene.upstream.python(args.code);
            } else {
              const asset = a.input.assets.find((x) => x.id === args.assetId);
              if (!asset) throw new Error("资源必须先引用到本轮对话");
              result = await this.scene.import(
                await existingSafePath(
                  this.scene.projectRoot(a.state.projectId),
                  asset.path,
                ),
              );
            }
          } catch (e) {
            error = e;
          }
          a.mutations++;
          a.report = undefined;
          const after = await this.scene.info();
          const diff = receipt(before, after);
          await this.emit(a.state, "scene.receipt", { callId, receipt: diff });
          const r = await this.capture("after");
          cap = r.capture;
          image = r.image;
          result = { output: result, receipt: diff, capture: cap };
          if (error) throw error;
        } else throw new Error("未知工具");
        await this.emit(a.state, "tool.completed", { callId, name, result });
        return {
          content: [
            { type: "text", text: JSON.stringify(result) },
            ...(image ? [image] : []),
          ],
        };
      } catch (e) {
        await this.emit(a.state, "tool.failed", {
          callId,
          name,
          error: String(e),
        });
        return { isError: true, content: [{ type: "text", text: String(e) }] };
      }
    });
  }
}
export const toolDefinitions = [
  {
    name: "get_scene_info",
    description:
      "Read current live scene, selected objects, active object, mode and real dimensions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "execute_blender_code",
    description:
      "Execute a short Python bpy script in the live Blender. Automatically returns readback receipt and a new image. Inspect the image before continuing.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
  },
  {
    name: "capture",
    description:
      "Take a fresh viewport screenshot. Returns actual image content and captureId.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "query_blender_api",
    description:
      "Inspect actual Blender RNA types or operators. e.g. bpy.types.Mesh or bpy.ops.mesh.primitive_cube_add.",
    inputSchema: {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"],
    },
  },
  {
    name: "import_asset",
    description:
      "Explicitly import a referenced asset by ID. Images are loaded as image datablocks; use bpy to apply them.",
    inputSchema: {
      type: "object",
      properties: { assetId: { type: "string" } },
      required: ["assetId"],
    },
  },
  {
    name: "save_scene",
    description: "Save current project scene.blend.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "export_scene",
    description: "Export current scene to a downloadable model.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["glb", "gltf", "blend"] },
      },
      required: ["format"],
    },
  },
  {
    name: "report_verification",
    description:
      "After inspecting the latest screenshot, record whether the scene meets the request. Must cite a current captureId with concrete visual observations.",
    inputSchema: {
      type: "object",
      properties: {
        captureId: { type: "string" },
        passed: { type: "boolean" },
        observations: { type: "string" },
      },
      required: ["captureId", "passed", "observations"],
    },
  },
];
