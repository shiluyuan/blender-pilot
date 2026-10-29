import { z } from "zod";
import {
  AssetLibrary,
  saveLibrarySchema,
} from "../../packages/blender-bridge/library.js";
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
import {
  MAX_TOTAL_DOCUMENT_CONTEXT_CHARS,
  documentMime,
  formatDocumentReference,
} from "../../packages/contracts/attachments.js";
import { readDocumentFile } from "../../packages/contracts/document-files.js";
import { normalizeCodexEvent } from "../../packages/contracts/chat-events.js";
import type {
  StartJob,
  PilotEvent,
  Capture,
  RunStatus,
  SceneInfo,
  Snapshot,
} from "../../packages/contracts/index.js";
import {
  workPlanSchema,
  type WorkPlan,
  type WorkPhase,
} from "../../packages/contracts/workflow.js";
import type { SceneQualityInspection } from "../../packages/contracts/quality.js";
import {
  readSkillResource,
  verifyRunSkills,
} from "../../packages/storage/skill-resources.js";
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
    report?: {
      captureId: string;
      captureIds?: string[];
      inspectionId?: string;
      passed: boolean;
      observations: string;
    };
    inspection?: SceneQualityInspection;
    viewCaptures?: Capture[];
    plan?: WorkPlan;
    baselineInfo?: SceneInfo;
    beforeSnapshot?: Snapshot;
    finalSnapshot?: Snapshot;
    savedPath?: string;
    review?: { repairsLeft: number; allowWrite: boolean };
    lastFailure?: { key: string; count: number };
    budgetError?: string;
  };
  states = new Map<string, JobState>();
  events = new Map<string, PilotEvent[]>();
  private persistence = Promise.resolve();
  storageFailure?: string;
  constructor(
    public root: string,
    public scene: SceneBridge,
  ) {}
  async init() {
    await mkdir(path.join(this.root, "jobs"), { recursive: true });
    const files = await readdir(path.join(this.root, "jobs"));
    for (const f of files) {
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
    // An admission can append its event but fail the atomic state rename.
    // Recover that uncertain receipt as interrupted, never as a new job to run.
    for (const file of files.filter(
      (f) =>
        f.endsWith(".ndjson") &&
        !files.includes(f.replace(/\.ndjson$/, ".json")),
    )) {
      const id = file.slice(0, -7);
      const events = (
        await readFile(path.join(this.root, "jobs", file), "utf8")
      )
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as PilotEvent];
          } catch {
            return [];
          }
        });
      const owner = events.find(
        (event) => event.runId === id && event.projectId && event.sessionId,
      );
      if (!owner) {
        this.storageFailure =
          "发现无法确定项目归属的未完成任务日志，请修复日志后重启执行服务";
        continue;
      }
      const recovered: JobState = {
        id,
        projectId: owner.projectId!,
        sessionId: owner.sessionId!,
        status: "interrupted",
        verification: "unavailable",
        seq: Math.max(...events.map((event) => event.seq), 0),
        error: "任务状态写入未完成，已恢复执行记录；没有自动重新操作场景。",
        createdAt: events[0]?.time || now(),
        updatedAt: now(),
      };
      this.states.set(id, recovered);
      this.events.set(id, events);
      await this.emit(recovered, "run.status", {
        status: recovered.status,
        verification: recovered.verification,
        error: recovered.error,
      });
    }
  }
  async emit(state: JobState, type: string, payload: Record<string, unknown>) {
    if (this.storageFailure)
      throw Object.assign(
        new Error("执行事件存储不可用，请修复磁盘并重启执行服务"),
        { statusCode: 503 },
      );
    const secret = this.active?.input.settings.apiKey || "";
    const safePayload = JSON.parse(redact(JSON.stringify(payload), [secret]));
    const event: PilotEvent = {
      schemaVersion: 1,
      runId: state.id,
      projectId: state.projectId,
      sessionId: state.sessionId,
      seq: ++state.seq,
      type,
      payload: safePayload,
      time: now(),
    };
    state.updatedAt = event.time;
    const persistedState = { ...state };
    this.persistence = this.persistence
      .then(async () => {
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
      })
      .catch((error) => {
        // A partial journal write has uncertain durability. Fail closed instead
        // of silently skipping a sequence or automatically replaying mutations.
        this.storageFailure = redact(String(error), [secret]);
        throw error;
      });
    await this.persistence;
    return event;
  }
  async start(input: StartJob, registeredState?: JobState) {
    const prior = this.states.get(input.runId);
    if (prior && prior !== registeredState) return prior;
    if (
      registeredState &&
      (prior !== registeredState ||
        registeredState.id !== input.runId ||
        registeredState.projectId !== input.projectId ||
        registeredState.sessionId !== input.sessionId)
    )
      throw new Error("任务队列归属不匹配");
    if (registeredState && registeredState.status !== "queued")
      return registeredState;
    if (this.active) throw new Error("已有任务正在操作 Blender");
    const state: JobState = registeredState || {
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
    try {
      if (!registeredState)
        await this.emit(state, "run.status", { status: "queued" });
    } catch (error) {
      if (this.active?.state === state) this.active = undefined;
      throw error;
    }
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
    if (active.captures.length >= this.captureLimit)
      throw new Error("本轮截图预算已用完");
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
  private get captureLimit() {
    return this.active?.input.qualityMode === "multi-view" ? 20 : 8;
  }
  private async phase(phase: WorkPhase) {
    await this.emit(this.active!.state, "work.phase", { phase });
  }
  private async inspectQuality() {
    const a = this.active!;
    a.report = undefined;
    a.inspection = await this.scene.inspectQuality();
    await this.emit(a.state, "quality.inspection", {
      inspection: a.inspection,
    });
    return a.inspection;
  }
  private async captureViews(phase: string, views?: unknown) {
    const a = this.active!;
    // Reserve a complete set before starting; partial sets never satisfy verification.
    if (a.captures.length + 3 > this.captureLimit)
      throw new Error("多角度截图预算不足，请报告未完成的检查");
    const results = await this.scene.captureViews(
      a.state.projectId,
      phase,
      a.state.id,
      views,
    );
    a.report = undefined;
    a.viewCaptures = results.map((r) => r.capture);
    if (
      a.inspection &&
      results.some(
        (r) => r.capture.sceneRevision !== a.inspection!.sceneRevision,
      )
    )
      a.inspection = undefined;
    for (const { capture } of results) {
      a.captures.push(capture);
      await this.emit(a.state, "capture.created", { capture });
    }
    return results;
  }
  private async verificationCurrent() {
    const a = this.active!;
    if (!a.report?.passed) return false;
    const current = await this.scene.info();
    const cap = a.captures.find((c) => c.id === a.report!.captureId);
    if (!cap || cap.sceneRevision !== current.revision) return false;
    if (a.input.qualityMode !== "multi-view") return true;
    return (
      !!a.inspection &&
      a.report.inspectionId === a.inspection.id &&
      a.inspection.sceneRevision === current.revision &&
      a.inspection.status !== "structural-errors" &&
      !!a.viewCaptures &&
      a.viewCaptures.length === 3 &&
      !!a.report.captureIds &&
      a.report.captureIds.length === 3 &&
      a.viewCaptures.every(
        (c) =>
          a.report!.captureIds!.includes(c.id) &&
          c.sceneRevision === current.revision,
      ) &&
      a.report.captureIds.includes(cap.id) &&
      !a.plan?.steps.some((s) => s.status !== "completed")
    );
  }
  private async execute() {
    const a = this.active!,
      state = a.state;
    try {
      if (a.input.skills?.length)
        await verifyRunSkills(
          this.root,
          state.projectId,
          state.id,
          a.input.skills,
        );
      state.status = "running";
      await this.emit(state, "run.status", { status: "running" });
      await this.phase("preparing");
      a.abort.signal.throwIfAborted();
      await this.scene.serial(async () => {
        a.abort.signal.throwIfAborted();
        await this.scene.activate(state.projectId);
        a.abort.signal.throwIfAborted();
        const snapshot = await this.scene.snapshot("AI 操作前", state.id);
        a.beforeSnapshot = snapshot;
        await this.emit(state, "snapshot.created", { snapshot });
        if (a.input.qualityMode === "multi-view")
          a.baselineInfo = await this.scene.info();
      });
      const baseline = await this.scene.serial(() => {
        a.abort.signal.throwIfAborted();
        return this.capture("before");
      });
      const root = this.scene.projectRoot(state.projectId);
      const proxyPath = fileURLToPath(
        new URL("../../packages/blender-bridge/mcp-proxy.js", import.meta.url),
      );
      const dev = import.meta.url.endsWith(".ts");
      const runtime = new CodexRuntime({
        home: path.join(this.root, "runtime", state.sessionId),
        cwd: root,
        settings: a.input.settings,
        skills: a.input.skills,
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
        onEvent: async (method, params) => {
          if (method === "diagnostic" && process.env.PILOT_DEBUG === "true")
            console.error(params.message);
          for (const event of normalizeCodexEvent(method, params))
            await this.emit(state, event.type, event.payload);
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
            "\nExplicit reusable library references (inspect with get_library_asset, import with import_library_asset): " +
            JSON.stringify(a.input.libraryAssets || []) +
            "\nAttached baseline capture: " +
            baseline.capture.id +
            "\nOnly these skills are selected for THIS run (read bundled references via read_skill_resource). Previously loaded but no longer selected skills are historical context, not active instructions: " +
            JSON.stringify(
              (a.input.skills || []).map(({ id, name, sha256 }) => ({
                id,
                name,
                sha256,
              })),
            ) +
            (a.input.qualityMode === "multi-view"
              ? "\nAcceptance: multi-view. Before success you MUST capture_views with front/right/top, then inspect_scene_quality, then report_verification with captureIds covering the whole current set and inspectionId. Capture first because viewport rendering can advance Blender's change counter. Machine warnings are candidates; visually explain them. For complex scenes first update_work_plan and update each phase with actual objectNames. Only mark a phase completed after actual scene readback."
              : "") +
            (a.input.workContext
              ? "\nPrevious persisted work plan (context only, NOT automatic permission to replay actions; inspect actual scene and follow this new user request): " +
                JSON.stringify(a.input.workContext)
              : ""),
        },
        { type: "localImage", path: baseline.capture.path },
      ];
      let documentBudget = MAX_TOTAL_DOCUMENT_CONTEXT_CHARS;
      for (const asset of a.input.assets) {
        const actual = await existingSafePath(root, asset.path);
        if (documentMime(actual)) {
          const document = formatDocumentReference(
            asset,
            await readDocumentFile(path.basename(actual), actual),
            documentBudget,
          );
          documentBudget -= document.info.contextCharacters;
          input.push({ type: "text", text: document.text });
          await this.emit(state, "attachment.context", {
            assetId: asset.id,
            name: asset.name,
            ...document.info,
          });
        } else if (/^image\/(png|jpeg|webp)$/.test(asset.mime)) {
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
      await this.phase("waiting_model");
      await runtime.turn(input, a.abort.signal);
      a.review = { repairsLeft: 2, allowWrite: true };
      // End-of-turn verification is enforced outside the model's self-reported completion.
      for (let round = 0; round < 3 && !a.abort.signal.aborted; round++) {
        if (a.report?.passed) {
          if (await this.scene.serial(() => this.verificationCurrent())) break;
          a.report = undefined;
        }
        if (
          a.captures.length >=
          this.captureLimit - (a.input.qualityMode === "multi-view" ? 2 : 0)
        )
          break;
        a.review.allowWrite = round < 2;
        await this.phase("inspecting");
        const finals = await this.scene.serial(async () => {
          if (a.input.qualityMode === "multi-view") {
            const views = await this.captureViews("final");
            await this.inspectQuality();
            return views;
          }
          return [await this.capture("final")];
        });
        const final = finals[0];
        await runtime.turn(
          [
            {
              type: "text",
              text: `Verify the current scene against the original request. Attached captureId=${final.capture.id}. captureIds=${JSON.stringify(finals.map((r) => r.capture.id))}. inspectionId=${a.inspection?.id || "none"}. Structural inspection=${JSON.stringify(a.inspection || null)}. Call report_verification with concrete visual observations and all supplied captureIds + inspectionId when present. ${round < 2 ? "If needed, at most one small correction then inspect the updated image." : "Budget exhausted: do not mutate, report remaining differences."} Original request: ${a.input.prompt}`,
            },
            ...finals.map((r) => ({
              type: "localImage" as const,
              path: r.capture.path,
            })),
          ],
          a.abort.signal,
        );
        if (await this.scene.serial(() => this.verificationCurrent())) break;
      }
      if (a.abort.signal.aborted) {
        state.status = a.budgetError ? "interrupted" : "cancelled";
        state.error = a.budgetError;
        state.verification = "unavailable";
      } else {
        await this.scene.serial(async () => {
          const verified = await this.verificationCurrent();
          state.verification = verified
            ? "passed"
            : a.report?.passed === false
              ? "failed"
              : "unavailable";
          state.status = verified ? "succeeded" : "interrupted";
          if (!verified)
            state.error =
              "场景执行已结束，视觉检查未通过、已过期或尚有未完成阶段";
          await this.phase("saving");
          a.savedPath = await this.scene.save();
          const snapshot = await this.scene.snapshot("AI 操作结果", state.id);
          a.finalSnapshot = snapshot;
          await this.emit(state, "snapshot.created", { snapshot });
          if (
            state.verification === "passed" &&
            !(await this.verificationCurrent())
          ) {
            state.verification = "unavailable";
            state.status = "interrupted";
            state.error = "保存期间场景或阶段发生变化，结果已保存，请重新检查";
          }
        });
      }
    } catch (e) {
      state.status = a.budgetError
        ? "interrupted"
        : a.abort.signal.aborted
          ? "cancelled"
          : /超时|timed out|closed|进程结束/i.test(String(e))
            ? "interrupted"
            : "failed";
      state.error =
        a.budgetError || redact(String(e), [a.input.settings.apiKey || ""]);
      state.verification = "unavailable";
    } finally {
      try {
        try {
          await a.runtime?.close();
        } catch (error) {
          // Revoke further MCP work even if native process cleanup cannot be
          // confirmed. An already executing bpy operation is drained below.
          a.abort.abort();
          state.status = "interrupted";
          state.verification = "unavailable";
          state.error = redact("执行端清理未完成：" + String(error), [
            a.input.settings.apiKey || "",
          ]);
        }
        await this.scene.idle();
        if (a.input.qualityMode === "multi-view") {
          let changes: ReturnType<typeof receipt> | undefined;
          let sceneChanged: boolean | undefined;
          try {
            if (a.baselineInfo) {
              const current = await this.scene.serial(() => this.scene.info());
              changes = receipt(a.baselineInfo, current);
              sceneChanged =
                a.mutations > 0 ||
                changes.created.length +
                  changes.modified.length +
                  changes.deleted.length >
                  0;
            }
          } catch {}
          await this.emit(state, "work.summary", {
            changes,
            sceneChanged,
            saved: !!a.savedPath,
            savedFile: a.savedPath ? path.basename(a.savedPath) : undefined,
            beforeSnapshot: a.beforeSnapshot,
            finalSnapshot: a.finalSnapshot,
            beforeCapture: a.captures.find((c) => c.phase === "before"),
            afterCaptures:
              a.viewCaptures ||
              a.captures
                .filter((capture) => capture.phase !== "before")
                .slice(-1),
            verification: state.verification,
            inspection: a.inspection,
            remainingSteps: a.plan?.steps.filter(
              (s) => s.status !== "completed",
            ),
          });
        }
        await this.emit(state, "run.status", {
          status: state.status,
          verification: state.verification,
          error: state.error,
        });
      } finally {
        // A failed final journal append must not retain a live token, model
        // credentials or a permanently busy studio. storageFailure separately
        // prevents accepting new jobs until the journal has been repaired.
        if (this.active === a) this.active = undefined;
      }
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
    if (!a || a.abort.signal.aborted || terminal.has(a.state.status))
      throw new Error("任务已停止");
    if (++a.calls > 40) {
      a.budgetError =
        "TOOL_BUDGET_EXCEEDED：本轮已达到 40 次工具调用上限，已停止后续操作。请检查当前场景后，在新一轮对话中继续。";
      // A throw-only budget lets the model loop on rejected tool requests
      // until its wall-clock timeout. Interrupt the turn and preserve the
      // distinction between a guardrail stop and a user's cancellation.
      a.abort.abort();
      await this.emit(a.state, "runtime.notice", {
        level: "warning",
        kind: "budget",
        code: "TOOL_BUDGET_EXCEEDED",
        message: a.budgetError,
      });
      throw new Error(a.budgetError);
    }
    return this.scene.serial(async () => {
      if (
        a !== this.active ||
        a.abort.signal.aborted ||
        terminal.has(a.state.status)
      )
        throw new Error("任务已停止");
      this.scene.assertProject(a.state.projectId);
      const callId = randomUUID();
      await this.emit(a.state, "tool.started", { callId, name, args });
      const failureKey = JSON.stringify([name, args]);
      try {
        if (a.lastFailure?.key === failureKey && a.lastFailure.count >= 3)
          throw new Error(
            "TOOL_RETRY_LIMIT：相同工具和参数已连续失败 3 次。停止重复调用，检查错误后调整参数；可读取场景、截图或向用户说明当前阻碍。",
          );
        let result: unknown;
        let image: any;
        let images: any[] = [];
        let resourceContent: any[] = [];
        let cap: Capture | undefined;
        if (name === "get_scene_info") result = await this.scene.info();
        else if (name === "read_skill_resource") {
          const request = z
            .object({
              skillId: z.string().uuid(),
              path: z.string().min(1).max(500),
            })
            .strict()
            .parse(args);
          resourceContent = await readSkillResource(
            a.input.skills || [],
            request.skillId,
            request.path,
          );
          result = {
            skillId: request.skillId,
            path: request.path,
            kind: resourceContent.some((c) => c.type === "image")
              ? "image"
              : "text",
          };
        } else if (name === "inspect_scene_quality") {
          await this.phase("inspecting");
          result = await this.inspectQuality();
        } else if (name === "capture_views") {
          await this.phase("inspecting");
          const views = await this.captureViews("inspection", args.views);
          images = views.map((r) => r.image);
          result = {
            captures: views.map(({ capture, view }) => ({ capture, view })),
            inspectionId: a.inspection?.id,
          };
        } else if (name === "update_work_plan") {
          const plan = workPlanSchema.parse(args);
          const newlyCompleted = plan.steps.filter(
            (s) =>
              s.status === "completed" &&
              a.plan?.steps.find((p) => p.id === s.id)?.status !== "completed",
          );
          if (newlyCompleted.length) {
            const current = await this.scene.info();
            const names = new Set(current.objects.map((o) => o.name));
            for (const step of newlyCompleted)
              if (step.objectNames.some((n) => !names.has(n)))
                throw new Error("阶段对象不在当前场景，请回读实际对象名称");
            const snapshot = await this.scene.snapshot(
              "阶段完成：" +
                newlyCompleted
                  .map((s) => s.step)
                  .join("、")
                  .slice(0, 80),
              a.state.id,
            );
            await this.emit(a.state, "snapshot.created", { snapshot });
          }
          a.plan = plan;
          a.report = undefined;
          await this.emit(a.state, "work.plan", { plan });
          await this.emit(a.state, "plan.updated", {
            itemId: "work-plan",
            explanation: plan.title,
            steps: plan.steps,
          });
          result = { plan, checkpointed: newlyCompleted.length > 0 };
        } else if (name === "search_library") {
          const query = z
            .object({
              search: z.string().max(200).optional(),
              category: z
                .enum([
                  "all",
                  "character",
                  "prop",
                  "scene",
                  "material",
                  "other",
                ])
                .optional(),
              page: z.number().int().min(0).max(100000).optional(),
            })
            .parse(args);
          const found = await new AssetLibrary(this.root).list(query);
          result = {
            ...found,
            items: found.items.map(
              ({ path, previewPath, ...metadata }) => metadata,
            ),
          };
        } else if (name === "get_library_asset") {
          const library = new AssetLibrary(this.root);
          const asset = await library.get(String(args.assetId));
          result = asset;
          if (asset.previewPath) {
            const preview = await sharp(await library.file(asset.id, true))
              .resize({
                width: 1280,
                height: 1280,
                fit: "inside",
                withoutEnlargement: true,
              })
              .jpeg({ quality: 80 })
              .toBuffer();
            image = {
              type: "image",
              mimeType: "image/jpeg",
              data: preview.toString("base64"),
            };
          }
        } else if (name === "save_library_asset") {
          result = await this.scene.saveLibraryAsset(
            saveLibrarySchema.parse(args),
          );
        } else if (name === "query_blender_api")
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
          if (a.input.qualityMode === "multi-view") {
            const reviewed = z
              .array(z.string())
              .min(3)
              .max(3)
              .parse(args.captureIds);
            if (
              !a.inspection ||
              a.inspection.id !== args.inspectionId ||
              a.inspection.sceneRevision !== current.revision
            )
              throw new Error(
                "结构检查缺失或已过期，请重新 inspect_scene_quality",
              );
            if (
              !a.viewCaptures ||
              a.viewCaptures.length !== 3 ||
              a.viewCaptures.some(
                (c) =>
                  !reviewed.includes(c.id) ||
                  c.sceneRevision !== current.revision,
              ) ||
              !reviewed.includes(chosen.id)
            )
              throw new Error(
                "需要检查当前完整的三个角度，并提供其 captureIds",
              );
            if (args.passed && a.inspection.status === "structural-errors")
              throw new Error("结构检查有阻断项，请修复后重新检查");
            if (
              args.passed &&
              a.plan?.steps.some((s) => s.status !== "completed")
            )
              throw new Error("创作阶段尚未完成，请更新阶段或如实报告未通过");
          }
          a.report = {
            captureId: chosen.id,
            ...(a.input.qualityMode === "multi-view"
              ? {
                  captureIds: [...args.captureIds],
                  inspectionId: a.inspection!.id,
                }
              : {}),
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
        } else if (
          name === "execute_blender_code" ||
          name === "import_asset" ||
          name === "import_library_asset"
        ) {
          if (a.review) {
            if (!a.review.allowWrite || a.review.repairsLeft <= 0)
              throw new Error("最终检查的修正预算已用完，请报告剩余差异");
            a.review.repairsLeft--;
          }
          if (
            a.captures.length >=
            this.captureLimit - (a.input.qualityMode === "multi-view" ? 3 : 1)
          )
            throw new Error("已保留最后一张截图额度，请结束修改并检查");
          await this.phase("modeling");
          const before = await this.scene.info();
          let error: unknown;
          try {
            if (name === "execute_blender_code") {
              if (typeof args.code !== "string" || args.code.length > 40000)
                throw new Error("代码为空或超过长度限制");
              result = await this.scene.upstream.python(args.code);
            } else if (name === "import_library_asset") {
              result = await this.scene.importLibraryAsset(
                String(args.assetId),
              );
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
          a.inspection = undefined;
          a.viewCaptures = undefined;
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
        await this.phase(a.review ? "inspecting" : "waiting_model");
        a.lastFailure = undefined;
        return {
          content: [
            { type: "text", text: JSON.stringify(result) },
            ...(image ? [image] : []),
            ...images,
            ...resourceContent,
          ],
        };
      } catch (e) {
        a.lastFailure = {
          key: failureKey,
          count:
            a.lastFailure?.key === failureKey ? a.lastFailure.count + 1 : 1,
        };
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
