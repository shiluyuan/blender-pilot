/** Runs the real Jobs lifecycle with local deterministic scene/runtime doubles.
 * These regressions cover finalization, not real inference or Blender quality. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Jobs, type JobState } from "../apps/runner/jobs.js";
import { SceneBridge } from "../packages/blender-bridge/scene.js";
import { CodexRuntime } from "../packages/runtime-adapters/codex.js";
import type { Capture, StartJob } from "../packages/contracts/index.js";
import type { QualityView } from "../packages/contracts/quality.js";

type Scenario =
  | "pending"
  | "blocked"
  | "late-edit"
  | "save-time-edit"
  | "unchanged"
  | "cancel-before-review"
  | "cancel-after-capture";
async function completeFixture(scenario: Scenario) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-finalize-"));
  const scene = new SceneBridge(root);
  scene.activeProject = "project";
  let revision = 1,
    sequence = 0,
    turns = 0,
    saveCalls = 0,
    acceptedReports = 0;
  scene.activate = async () => {};
  scene.info = async () => ({
    objects: [
      {
        name: "Desk",
        type: "MESH",
        location: [0, 0, 0],
        dimensions: [1, 1, 1],
        materials: ["Wood"],
      },
    ],
    selected: [],
    active: null,
    mode: "OBJECT",
    frame: 1,
    version: "fixture",
    filepath: "scene.blend",
    revision: "r" + revision,
  });
  scene.snapshot = async (name, runId) => ({
    id: "snapshot-" + ++sequence,
    projectId: "project",
    name,
    runId,
    path: "fixture.blend",
    createdAt: new Date().toISOString(),
  });
  scene.save = async () => {
    saveCalls++;
    // Native desktop edits are outside the Node scene queue. A durable save
    // can finish with different scene content than the pre-save inspection.
    if (scenario === "save-time-edit") revision++;
    return "/fixture/scene.blend";
  };
  const capture = (phase: string) => ({
    capture: {
      id: "capture-" + ++sequence,
      projectId: "project",
      runId: "run",
      path: "fixture.jpg",
      mime: "image/jpeg",
      sceneRevision: "r" + revision,
      generation: 1,
      mode: "viewport",
      phase,
      createdAt: new Date().toISOString(),
    } satisfies Capture,
    image: { type: "image", data: "fixture", mimeType: "image/jpeg" },
  });
  scene.capture = async (_projectId, phase) => capture(phase);
  scene.captureViews = async (_projectId, phase) =>
    (["front", "right", "top"] as QualityView[]).map((view) => ({
      ...capture(phase),
      view,
    }));
  scene.inspectQuality = async () => ({
    schemaVersion: 1,
    id: "inspection-" + sequence,
    projectId: "project",
    createdAt: new Date().toISOString(),
    sceneRevision: "r" + revision,
    generation: 1,
    status: "no-structural-issues",
    summary: {
      objectsTotal: 1,
      objectsInspected: 1,
      meshObjects: 1,
      vertices: 8,
      polygons: 6,
      lights: 1,
      cameras: 1,
      warningCount: 0,
      errorCount: 0,
    },
    bounds: null,
    issues: [],
    limits: {
      maxObjects: 100,
      objectsTruncated: false,
      issuesTruncated: false,
      overlapCandidatesTruncated: false,
      groundZ: 0,
      limitations: [],
    },
  });
  const jobs = new Jobs(root, scene);
  await jobs.init();
  const now = new Date().toISOString();
  const input: StartJob = {
    runId: "run",
    projectId: "project",
    sessionId: "session",
    prompt: "fixture",
    assets: [],
    qualityMode: "multi-view",
    settings: {
      baseUrl: "http://127.0.0.1:1",
      model: "fixture",
      effort: "low",
    },
  };
  const state: JobState = {
    id: "run",
    projectId: "project",
    sessionId: "session",
    status: "running",
    verification: "pending",
    seq: 0,
    createdAt: now,
    updatedAt: now,
  };
  jobs.states.set(state.id, state);
  jobs.active = {
    state,
    input,
    token: "fixture",
    abort: new AbortController(),
    captures: [],
    mutations: 0,
    calls: 0,
  };
  const original = {
    start: CodexRuntime.prototype.start,
    turn: CodexRuntime.prototype.turn,
    close: CodexRuntime.prototype.close,
  };
  CodexRuntime.prototype.start = async () => "fixture-thread";
  CodexRuntime.prototype.close = async () => {};
  CodexRuntime.prototype.turn = async () => {
    turns++;
    if (
      scenario === "cancel-before-review" ||
      scenario === "cancel-after-capture"
    ) {
      if (scenario === "cancel-after-capture") await jobs.tool("capture", {});
      jobs.active!.abort.abort();
      return;
    }
    if (scenario === "late-edit" && turns === 1) return;
    if ((scenario === "pending" || scenario === "blocked") && turns > 1) return;
    if (!jobs.active!.inspection) {
      await jobs.tool("inspect_scene_quality", {});
      await jobs.tool("capture_views", {});
    }
    const active = jobs.active!;
    const ids = active.viewCaptures!.map((c) => c.id);
    const report = await jobs.tool("report_verification", {
      captureId: ids[0],
      captureIds: ids,
      inspectionId: active.inspection!.id,
      passed: true,
      observations: "Fixture visual verification; not model inference.",
    });
    assert.equal(report.isError, undefined, JSON.stringify(report));
    acceptedReports++;
    if (scenario === "pending" || scenario === "blocked") {
      const result = await jobs.tool("update_work_plan", {
        title: "Remaining work",
        steps: [
          { id: "desk", step: "Desk still needs revision", status: scenario },
        ],
      });
      assert.equal(result.isError, undefined, JSON.stringify(result));
    } else if (scenario === "late-edit") {
      // Simulate an independent native desktop edit after the model reports.
      // It does not use the MCP mutation handler that normally clears report.
      revision++;
    }
  };
  try {
    await (jobs as unknown as { execute(): Promise<void> }).execute();
    const events = jobs.events.get(state.id)!;
    return {
      state: { ...state },
      summary: events.findLast((e) => e.type === "work.summary")!.payload,
      final: events.findLast((e) => e.type === "run.status")!.payload,
      turns,
      saveCalls,
      acceptedReports,
      active: jobs.active,
    };
  } finally {
    Object.assign(CodexRuntime.prototype, original);
    await rm(root, { recursive: true, force: true });
  }
}

test("an accepted report followed by a pending or blocked stage cannot finalize as passed", async () => {
  for (const status of ["pending", "blocked"] as const) {
    const result = await completeFixture(status);
    assert.equal(
      result.acceptedReports,
      1,
      "the report passed before the plan regressed",
    );
    assert.equal(result.state.status, "interrupted");
    assert.notEqual(result.state.verification, "passed");
    assert.notEqual(result.summary.verification, "passed");
    assert.equal(
      (result.summary.remainingSteps as Array<{ status: string }>)[0].status,
      status,
    );
    assert.equal(
      result.summary.saved,
      true,
      "partial work is still saved for the next request",
    );
    assert.equal(result.final.status, "interrupted");
    assert.equal(result.saveCalls, 1);
    assert.equal(result.active, undefined);
  }
});

test("cancelled baseline-only work has no after image, while a later actual capture remains available", async () => {
  const cancelled = await completeFixture("cancel-before-review");
  assert.equal(cancelled.state.status, "cancelled");
  assert.equal(cancelled.summary.sceneChanged, false);
  assert.equal(cancelled.summary.saved, false);
  assert.equal((cancelled.summary.beforeCapture as Capture).phase, "before");
  assert.deepEqual(cancelled.summary.afterCaptures, []);
  assert.equal(cancelled.saveCalls, 0);
  assert.equal(cancelled.active, undefined);
  const inspected = await completeFixture("cancel-after-capture");
  assert.equal(inspected.state.status, "cancelled");
  assert.equal(inspected.summary.sceneChanged, false);
  const after = inspected.summary.afterCaptures as Capture[];
  assert.equal(after.length, 1);
  assert.equal(after[0].phase, "inspection");
  assert.notEqual(after[0].id, (inspected.summary.beforeCapture as Capture).id);
});

test("finalization rechecks revisions after review and saving while unchanged evidence can succeed", async () => {
  const control = await completeFixture("unchanged");
  assert.equal(control.state.status, "succeeded");
  assert.equal(control.state.verification, "passed");
  assert.equal(control.summary.verification, "passed");
  assert.equal((control.summary.afterCaptures as Capture[]).length, 3);
  assert.equal(control.saveCalls, 1);
  const edited = await completeFixture("late-edit");
  assert.equal(
    edited.acceptedReports,
    3,
    "each bounded review accepted its then-current evidence",
  );
  assert.equal(
    edited.turns,
    4,
    "one creation and three review turns, with no unbounded replay",
  );
  assert.equal(edited.state.status, "interrupted");
  assert.notEqual(edited.state.verification, "passed");
  assert.notEqual(edited.summary.verification, "passed");
  assert.equal(edited.final.status, "interrupted");
  assert.equal(edited.summary.saved, true);
  assert.equal(edited.saveCalls, 1);
  assert.equal(edited.active, undefined);
  const duringSave = await completeFixture("save-time-edit");
  assert.equal(
    duringSave.acceptedReports,
    1,
    "evidence passed before the save began",
  );
  assert.equal(
    duringSave.turns,
    1,
    "a save-time change must not trigger implicit model replay",
  );
  assert.equal(duringSave.state.status, "interrupted");
  assert.notEqual(duringSave.state.verification, "passed");
  assert.notEqual(duringSave.summary.verification, "passed");
  assert.equal(duringSave.final.status, "interrupted");
  assert.equal(
    duringSave.summary.saved,
    true,
    "the saved result remains available for review",
  );
  assert.equal(duringSave.saveCalls, 1);
  assert.equal(duringSave.active, undefined);
});
