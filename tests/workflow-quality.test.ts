import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Jobs } from "../apps/runner/jobs.js";
import { SceneBridge } from "../packages/blender-bridge/scene.js";
import { workPlanSchema } from "../packages/contracts/workflow.js";
import type { Capture, SceneInfo } from "../packages/contracts/index.js";

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-workflow-"));
  const scene = new SceneBridge(root);
  scene.activeProject = "project";
  let revision = "r1",
    snapshots = 0;
  scene.info = async () =>
    ({
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
      revision,
    }) satisfies SceneInfo;
  scene.snapshot = async (name, runId) => ({
    id: "checkpoint-" + ++snapshots,
    projectId: "project",
    name,
    runId,
    path: "fixture.blend",
    createdAt: new Date().toISOString(),
  });
  const jobs = new Jobs(root, scene);
  await jobs.init();
  const now = new Date().toISOString();
  const capture = (id: string): Capture => ({
    id: id + "-" + revision,
    projectId: "project",
    runId: "run",
    path: "fixture.jpg",
    mime: "image/jpeg",
    sceneRevision: revision,
    generation: 1,
    mode: "viewport",
    phase: "inspection",
    createdAt: now,
  });
  scene.inspectQuality = async () => ({
    schemaVersion: 1,
    id: "inspection",
    projectId: "project",
    createdAt: now,
    sceneRevision: revision,
    generation: 1,
    status: "review-needed",
    summary: {
      objectsTotal: 1,
      objectsInspected: 1,
      meshObjects: 1,
      vertices: 8,
      polygons: 6,
      lights: 0,
      cameras: 0,
      warningCount: 1,
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
  scene.captureViews = async () =>
    ["front", "right", "top"].map((view: any) => ({
      capture: capture(view),
      image: { type: "image", data: "fixture", mimeType: "image/jpeg" },
      view,
    }));
  jobs.active = {
    state: {
      id: "run",
      projectId: "project",
      sessionId: "session",
      status: "running",
      verification: "pending",
      seq: 0,
      createdAt: now,
      updatedAt: now,
    },
    input: {
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
    },
    token: "fixture",
    abort: new AbortController(),
    captures: [],
    mutations: 0,
    calls: 0,
  };
  return {
    jobs,
    scene,
    root,
    get report() {
      return {
        captureId: "front-" + revision,
        captureIds: ["front", "right", "top"].map((v) => v + "-" + revision),
        inspectionId: "inspection",
        passed: true,
        observations: "Synthetic protocol assertion, not visual evaluation.",
      };
    },
    get snapshots() {
      return snapshots;
    },
    setRevision: (r: string) => (revision = r),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("multi-view acceptance rejects missing/stale/partial evidence and structural errors", async () => {
  const f = await setup();
  try {
    assert.equal(
      (await f.jobs.tool("report_verification", f.report)).isError,
      true,
    );
    await f.jobs.tool("inspect_scene_quality", {});
    await f.jobs.tool("capture_views", {});
    assert.equal(
      (
        await f.jobs.tool("report_verification", {
          ...f.report,
          captureIds: ["front"],
        })
      ).isError,
      true,
    );
    assert.equal(
      (await f.jobs.tool("report_verification", f.report)).isError,
      undefined,
    );
    assert.equal(f.jobs.active!.report?.captureIds?.length, 3);
    f.setRevision("r2");
    assert.equal(
      (await f.jobs.tool("report_verification", f.report)).isError,
      true,
    );
    await f.jobs.tool("inspect_scene_quality", {});
    await f.jobs.tool("capture_views", {});
    f.jobs.active!.inspection!.status = "structural-errors";
    assert.match(
      (await f.jobs.tool("report_verification", f.report)).content[0].text,
      /结构检查有阻断项/,
    );
    assert.equal(
      (await f.jobs.tool("report_verification", { ...f.report, passed: false }))
        .isError,
      undefined,
    );
  } finally {
    await f.cleanup();
  }
});

test("stage checkpoints require real object names and incomplete plans cannot pass", async () => {
  const f = await setup();
  try {
    const plan = {
      title: "Office",
      steps: [
        {
          id: "desk",
          step: "Build desk",
          status: "completed",
          objectNames: ["Missing"],
        },
      ],
    };
    assert.equal((await f.jobs.tool("update_work_plan", plan)).isError, true);
    assert.equal(f.snapshots, 0);
    plan.steps[0].objectNames = ["Desk"];
    plan.steps[0].status = "in_progress";
    assert.equal(
      (await f.jobs.tool("update_work_plan", plan)).isError,
      undefined,
    );
    await f.jobs.tool("inspect_scene_quality", {});
    await f.jobs.tool("capture_views", {});
    assert.match(
      (await f.jobs.tool("report_verification", f.report)).content[0].text,
      /阶段尚未完成/,
    );
    plan.steps[0].status = "completed";
    await f.jobs.tool("update_work_plan", plan);
    assert.equal(f.snapshots, 1);
    await f.jobs.tool("update_work_plan", plan);
    assert.equal(f.snapshots, 1, "same checkpoint is not replayed");
    assert.equal(
      (await f.jobs.tool("report_verification", f.report)).isError,
      undefined,
    );
    const restored = new Jobs(f.root, f.scene);
    await restored.init();
    assert.equal(
      restored.events
        .get("run")
        ?.filter((e) => e.type === "work.plan")
        .at(-1)?.payload.plan && true,
      true,
    );
    assert.equal(restored.get("run")?.status, "interrupted");
    assert.equal(f.snapshots, 1, "restart never replays stage");
  } finally {
    await f.cleanup();
  }
});

test("capture set budget and stage shape are bounded before scene access", async () => {
  const f = await setup();
  try {
    let calls = 0;
    f.scene.captureViews = async () => {
      calls++;
      return [];
    };
    f.jobs.active!.captures = new Array(18).fill({});
    assert.match(
      (await f.jobs.tool("capture_views", {})).content[0].text,
      /预算不足/,
    );
    assert.equal(calls, 0);
    assert.equal(
      workPlanSchema.safeParse({
        title: "x",
        steps: [
          { id: "a", step: "a", status: "in_progress" },
          { id: "a", step: "b", status: "in_progress" },
        ],
      }).success,
      false,
    );
  } finally {
    await f.cleanup();
  }
});
