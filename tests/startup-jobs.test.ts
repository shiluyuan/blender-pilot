import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StartupJobs } from "../apps/runner/dispatch.js";
import { Jobs } from "../apps/runner/jobs.js";
import { SceneBridge } from "../packages/blender-bridge/scene.js";
import type { StudioPool } from "../apps/runner/pool.js";
import type { StartJob } from "../packages/contracts/index.js";

const input = (id: string): StartJob => ({
  runId: id,
  projectId: "project",
  sessionId: "session",
  prompt: "创建蓝色立方体",
  assets: [],
  settings: {
    baseUrl: "https://example.invalid",
    model: "fixture",
    apiKey: "synthetic-secret",
    effort: "low",
  },
});

test("queued startup can be cancelled before the desktop opens and never hands the scene to Jobs.start", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pilot-startup-"));
  const history = new Jobs(dir, new SceneBridge(dir));
  await history.init();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let opens = 0,
    starts = 0;
  const pool = {
    history,
    byRun: () => history,
    open: async () => {
      opens++;
      await gate;
      return {
        jobs: {
          start: async () => {
            starts++;
          },
        },
      };
    },
  } as unknown as StudioPool;
  const queue = new StartupJobs(pool);
  try {
    const queued = await queue.submit(input("slow-start"));
    assert.equal(queued.status, "queued");
    assert.equal(queued.seq, 1);
    assert.equal(opens, 1);
    assert.equal(queue.get("slow-start")?.status, "queued");
    const cancelled = await queue.cancel("slow-start", {
      projectId: "project",
      sessionId: "session",
    });
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.seq, 2);
    assert.equal((await queue.submit(input("slow-start"))).status, "cancelled");
    release();
    await queue.shutdown();
    assert.equal(starts, 0);
    const events = history.events.get("slow-start")!;
    assert.deepEqual(
      events.map((e) => e.payload.status),
      ["queued", "cancelled"],
    );
    assert.ok(
      !(
        await readFile(path.join(dir, "jobs/slow-start.json"), "utf8")
      ).includes("synthetic-secret"),
    );
    assert.ok(
      !(
        await readFile(path.join(dir, "jobs/slow-start.ndjson"), "utf8")
      ).includes("synthetic-secret"),
    );
  } finally {
    release();
    await queue.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a cancellation that overtakes submission is a durable tombstone across runner restarts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pilot-cancel-first-"));
  const history = new Jobs(dir, new SceneBridge(dir));
  await history.init();
  let opens = 0;
  const poolFor = (jobs: Jobs) =>
    ({
      history: jobs,
      byRun: () => jobs,
      open: async () => {
        opens++;
        throw new Error("Must not open");
      },
    }) as unknown as StudioPool;
  const queue = new StartupJobs(poolFor(history));
  try {
    await queue.cancel("crossed-http", {
      projectId: "project",
      sessionId: "session",
    });
    assert.equal(
      (await queue.submit(input("crossed-http"))).status,
      "cancelled",
    );
    const restarted = new Jobs(dir, new SceneBridge(dir));
    await restarted.init();
    const restoredQueue = new StartupJobs(poolFor(restarted));
    assert.equal(
      (await restoredQueue.submit(input("crossed-http"))).status,
      "cancelled",
    );
    assert.equal(opens, 0);
    const cancelled = restarted.states.get("crossed-http")!;
    assert.equal(
      (await restarted.start(input("crossed-http"), cancelled)).status,
      "cancelled",
    );
    assert.equal(restarted.active, undefined);
    await assert.rejects(
      restoredQueue.submit({
        ...input("crossed-http"),
        sessionId: "another-session",
      }),
      /其他项目或对话/,
    );
    await restoredQueue.shutdown();
  } finally {
    await queue.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("desktop startup failure is journaled as a visible terminal failure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pilot-start-fail-"));
  const history = new Jobs(dir, new SceneBridge(dir));
  await history.init();
  const pool = {
    history,
    byRun: () => history,
    open: async () => {
      throw new Error("Blender startup failed synthetic-secret");
    },
  } as unknown as StudioPool;
  const queue = new StartupJobs(pool);
  try {
    await queue.submit(input("startup-fail"));
    const until = Date.now() + 3000;
    while (queue.get("startup-fail")?.status !== "failed") {
      if (Date.now() > until) throw new Error("No terminal failure");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await queue.shutdown();
    assert.equal(
      history.events.get("startup-fail")?.at(-1)?.payload.status,
      "failed",
    );
    assert.match(queue.get("startup-fail")?.error || "", /无法启动项目任务/);
    assert.ok(
      !JSON.stringify(history.events.get("startup-fail")).includes(
        "synthetic-secret",
      ),
    );
  } finally {
    await queue.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed queued admission clears ghosts and fails closed until storage is repaired and restarted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pilot-journal-fault-"));
  const history = new Jobs(dir, new SceneBridge(dir));
  await history.init();
  let opens = 0;
  const pool = {
    history,
    byRun: () => history,
    open: async () => {
      opens++;
      throw new Error("Must not start");
    },
  } as unknown as StudioPool;
  const queue = new StartupJobs(pool);
  try {
    await mkdir(path.join(dir, "jobs/write-fault.ndjson"));
    await assert.rejects(queue.submit(input("write-fault")));
    assert.equal(queue.pending.size, 0);
    assert.equal(history.states.has("write-fault"), false);
    assert.ok(history.storageFailure);
    assert.throws(
      () => queue.get("write-fault"),
      (e: any) => e.statusCode === 503,
    );
    await assert.rejects(
      queue.submit(input("another-job")),
      (e: any) => e.statusCode === 503,
    );
    assert.equal(opens, 0);
  } finally {
    await queue.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a partial admission journal recovers as interrupted after restart without replay", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pilot-partial-admit-"));
  const history = new Jobs(dir, new SceneBridge(dir));
  await history.init();
  let opens = 0;
  const poolFor = (jobs: Jobs) =>
    ({
      history: jobs,
      byRun: () => jobs,
      open: async () => {
        opens++;
        throw new Error("Must not start");
      },
    }) as unknown as StudioPool;
  const queue = new StartupJobs(poolFor(history));
  try {
    await mkdir(path.join(dir, "jobs/partial-state.json"));
    await assert.rejects(queue.submit(input("partial-state")));
    assert.ok(
      (
        await readFile(path.join(dir, "jobs/partial-state.ndjson"), "utf8")
      ).includes('"status":"queued"'),
    );
    assert.equal(queue.pending.size, 0);
    assert.ok(history.storageFailure);
    await rm(path.join(dir, "jobs/partial-state.json"), { recursive: true });
    const restored = new Jobs(dir, new SceneBridge(dir));
    await restored.init();
    assert.equal(restored.get("partial-state")?.status, "interrupted");
    assert.deepEqual(
      restored.events.get("partial-state")?.map((event) => event.seq),
      [1, 2],
    );
    const restartedQueue = new StartupJobs(poolFor(restored));
    assert.equal(
      (await restartedQueue.submit(input("partial-state"))).status,
      "interrupted",
    );
    assert.equal(opens, 0);
    await restartedQueue.shutdown();
  } finally {
    await queue.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed cancellation tombstone never advertises an undurable terminal sequence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pilot-cancel-fault-"));
  const history = new Jobs(dir, new SceneBridge(dir));
  await history.init();
  const pool = {
    history,
    byRun: () => history,
    open: async () => {
      throw new Error("Must not start");
    },
  } as unknown as StudioPool;
  const queue = new StartupJobs(pool);
  try {
    await mkdir(path.join(dir, "jobs/cancel-fault.ndjson"));
    await assert.rejects(
      queue.cancel("cancel-fault", {
        projectId: "project",
        sessionId: "session",
      }),
    );
    assert.throws(
      () => queue.get("cancel-fault"),
      (e: any) => e.statusCode === 503,
    );
    await assert.rejects(
      queue.cancel("cancel-fault", {
        projectId: "project",
        sessionId: "session",
      }),
      (e: any) => e.statusCode === 503,
    );
    await assert.rejects(
      queue.submit(input("cancel-fault")),
      (e: any) => e.statusCode === 503,
    );
    assert.equal(history.events.get("cancel-fault")?.length || 0, 0);
  } finally {
    await queue.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a storage fault cannot prevent aborting an already running model", async () => {
  const history = new Jobs("/unused", new SceneBridge("/unused"));
  const activeJobs = new Jobs("/unused", new SceneBridge("/unused"));
  const state = {
    id: "live-stop",
    projectId: "project",
    sessionId: "session",
    status: "running" as const,
    verification: "pending",
    seq: 4,
    createdAt: "now",
    updatedAt: "now",
  };
  activeJobs.states.set(state.id, state);
  activeJobs.active = {
    state,
    input: input(state.id),
    token: "synthetic",
    abort: new AbortController(),
    captures: [],
    mutations: 0,
    calls: 0,
  };
  history.storageFailure = "admission disk unavailable";
  activeJobs.storageFailure = "studio disk unavailable";
  const pool = { history, byRun: () => activeJobs } as unknown as StudioPool;
  const queue = new StartupJobs(pool);
  await assert.rejects(
    queue.cancel(state.id, { projectId: "project", sessionId: "session" }),
    (e: any) => e.statusCode === 503,
  );
  assert.equal(activeJobs.active.abort.signal.aborted, true);
  assert.throws(
    () => queue.get(state.id),
    (e: any) => e.statusCode === 503,
  );
  await queue.shutdown();
});
