import type { StartJob } from "../../packages/contracts/index.js";
import { terminal } from "../../packages/contracts/index.js";
import { now, redact } from "../../packages/contracts/fs.js";
import type { JobState } from "./jobs.js";
import type { StudioPool } from "./pool.js";

/** Queue admission is durable before desktop startup. A cancellation can be
 * recorded even before POST /jobs arrives, so crossed HTTP requests cannot
 * start a task the user has already stopped. No credentials are persisted. */
export class StartupJobs {
  readonly pending = new Map<string, { state: JobState; started: boolean }>();
  private tasks = new Set<Promise<void>>();
  private journalFailures = new Set<string>();
  private stopping = false;
  constructor(private pool: StudioPool) {}

  get(id: string) {
    const jobs = this.pool.byRun(id);
    const state = jobs.get(id);
    const durableSequence = this.pool.history.events.get(id)?.at(-1)?.seq || 0;
    if (
      this.journalFailures.has(id) ||
      (this.pool.history.storageFailure &&
        state &&
        state.seq > durableSequence) ||
      (jobs !== this.pool.history && jobs.storageFailure)
    )
      throw Object.assign(
        new Error("任务事件写入未完成，请修复磁盘并重启执行服务"),
        { statusCode: 503 },
      );
    return state;
  }
  all() {
    return [...this.pool.history.states.keys()].flatMap((id) => {
      try {
        const state = this.get(id);
        return state ? [state] : [];
      } catch {
        return [];
      }
    });
  }

  async submit(input: StartJob) {
    if (this.stopping)
      throw Object.assign(new Error("执行服务正在关闭"), { statusCode: 503 });
    if (this.pool.history.storageFailure)
      throw Object.assign(
        new Error("执行事件存储不可用，请修复磁盘并重启执行服务"),
        { statusCode: 503 },
      );
    const existing = this.get(input.runId);
    if (existing) {
      if (
        existing.projectId !== input.projectId ||
        existing.sessionId !== input.sessionId
      )
        throw Object.assign(new Error("任务编号已属于其他项目或对话"), {
          statusCode: 409,
        });
      return existing;
    }
    if (
      this.all().some(
        (s) => s.projectId === input.projectId && !terminal.has(s.status),
      )
    )
      throw Object.assign(new Error("该项目已有任务正在执行"), {
        statusCode: 409,
      });
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
    const entry = { state, started: false };
    this.pending.set(state.id, entry);
    this.pool.history.states.set(state.id, state);
    try {
      await this.pool.history.emit(state, "run.status", { status: "queued" });
    } catch (error) {
      this.journalFailures.add(state.id);
      // Admission failed: there must be no in-memory ghost that a retry could
      // mistake for a successfully accepted job, and no desktop may be opened.
      this.pending.delete(state.id);
      if (
        state.status === "queued" &&
        this.pool.history.states.get(state.id) === state
      )
        this.pool.history.states.delete(state.id);
      throw error;
    }
    if (terminal.has(state.status)) {
      this.pending.delete(state.id);
      return state;
    }
    const task = (async () => {
      try {
        const studio = await this.pool.open(input.projectId);
        if (terminal.has(state.status) || this.stopping) return;
        // start() synchronously installs its active state before yielding.
        entry.started = true;
        await studio.jobs.start(input, state);
      } catch (error) {
        if (!terminal.has(state.status)) {
          state.status = "failed";
          state.verification = "unavailable";
          state.error =
            "无法启动项目任务：" +
            redact(String(error), [input.settings.apiKey || ""]);
          await this.pool.history.emit(state, "run.status", {
            status: state.status,
            verification: state.verification,
            error: state.error,
          });
        }
      } finally {
        this.pending.delete(state.id);
      }
    })();
    this.tasks.add(task);
    void task
      .catch((error) =>
        console.error(
          "Startup job persistence failed",
          redact(String(error), [input.settings.apiKey || ""]),
        ),
      )
      .finally(() => this.tasks.delete(task));
    return { ...state };
  }

  async cancel(id: string, owner?: { projectId: string; sessionId: string }) {
    // Stopping a live model must remain possible even when admission storage
    // is unavailable. Jobs.cancel aborts before attempting its journal write.
    const activeJobs = this.pool.byRun(id);
    if (activeJobs.active?.state.id === id) {
      const active = activeJobs.active.state;
      if (
        owner &&
        (active.projectId !== owner.projectId ||
          active.sessionId !== owner.sessionId)
      )
        throw Object.assign(new Error("任务不属于当前对话"), {
          statusCode: 409,
        });
      return activeJobs.cancel(id);
    }
    const entry = this.pending.get(id);
    const existing = this.get(id);
    if (
      existing &&
      owner &&
      (existing.projectId !== owner.projectId ||
        existing.sessionId !== owner.sessionId)
    )
      throw Object.assign(new Error("任务不属于当前对话"), { statusCode: 409 });
    if (existing && terminal.has(existing.status)) return existing;
    if (existing && (!entry || entry.started)) {
      const jobs = this.pool.byRun(id);
      if (jobs.active?.state.id === id) return jobs.cancel(id);
    }
    if (!existing && !owner)
      throw Object.assign(new Error("任务不存在"), { statusCode: 404 });
    const state: JobState = entry?.state ||
      this.pool.history.states.get(id) || {
        id,
        projectId: owner!.projectId,
        sessionId: owner!.sessionId,
        status: "queued",
        verification: "pending",
        seq: 0,
        createdAt: now(),
        updatedAt: now(),
      };
    state.status = "cancelled";
    state.verification = "unavailable";
    this.pool.history.states.set(id, state);
    try {
      await this.pool.history.emit(state, "run.status", {
        status: "cancelled",
        verification: "unavailable",
      });
    } catch (error) {
      this.journalFailures.add(id);
      throw error;
    }
    return { ...state };
  }

  async shutdown() {
    this.stopping = true;
    await Promise.allSettled(
      [...this.pending.values()]
        .filter((e) => !e.started)
        .map((e) => this.cancel(e.state.id)),
    );
    // pool.open has its own bounded native startup timeout. The process-level
    // shutdown also waits for that pool, so no orphan task can later execute.
    await Promise.allSettled([...this.tasks]);
  }
}
