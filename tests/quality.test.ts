import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { SceneBridge } from "../packages/blender-bridge/scene.js";
import {
  summarizeQuality,
  MAX_QUALITY_ISSUES,
  type RawQualityObject,
  type RawQualityScene,
} from "../packages/blender-bridge/quality.js";

const object = (
  name: string,
  overrides: Partial<RawQualityObject> = {},
): RawQualityObject => ({
  name,
  type: "MESH",
  visible: true,
  parent: null,
  scale: [1, 1, 1],
  finiteTransform: true,
  bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  materialSlots: ["Paint"],
  vertices: 8,
  polygons: 6,
  ...overrides,
});
const raw = (
  objects: RawQualityObject[],
  overrides: Partial<RawQualityScene> = {},
): RawQualityScene => ({
  objectsTotal: objects.length,
  objects,
  lights: 1,
  cameras: 1,
  missingTextures: [],
  worldIllumination: false,
  ...overrides,
});
const metadata = {
  id: "inspection",
  projectId: "project",
  sceneRevision: "revision",
  generation: 4,
  createdAt: new Date(0).toISOString(),
};
const options = { groundZ: 0, overlapCandidates: true };

test("quality findings distinguish structural faults from visual candidates without a beauty pass", () => {
  const report = summarizeQuality(
    raw(
      [
        object("normal"),
        object("overlapping", {
          bounds: { min: [0.5, 0.5, 0.5], max: [1.5, 1.5, 1.5] },
        }),
        object("empty", { vertices: 0, polygons: 0, materialSlots: [] }),
        object("invalid", { finiteTransform: false, bounds: null }),
        object("negative", { scale: [-1, 1, 1] }),
      ],
      { missingTextures: [{ name: "missing.png", users: ["normal"] }] },
    ),
    metadata,
    options,
  );
  assert.equal(report.status, "structural-errors");
  assert.equal(report.summary.errorCount, 1);
  assert(
    report.issues.some(
      (issue) =>
        issue.code === "missing-texture" && issue.severity === "warning",
    ),
  );
  assert(report.issues.some((issue) => issue.code === "empty-mesh"));
  assert(report.issues.some((issue) => issue.code === "negative-scale"));
  const overlap = report.issues.find(
    (issue) => issue.code === "overlap-candidate",
  )!;
  assert.equal(overlap.severity, "info");
  assert.equal(overlap.requiresVisualReview, true);
  assert.match(overlap.message, /不是网格穿模/);
  assert(
    report.issues.some(
      (issue) =>
        issue.code === "floating-candidate" && issue.requiresVisualReview,
    ),
  );
  assert.match(report.limits.limitations.join(" "), /不代表作品视觉质量通过/);
  assert.equal(
    summarizeQuality(raw([object("clean")]), metadata, options).status,
    "no-structural-issues",
  );
});

test("quality limits are explicit and overlap candidates exclude containment, hidden objects, and parents", () => {
  const clean = summarizeQuality(
    raw([
      object("room", { bounds: { min: [-10, -10, -10], max: [10, 10, 10] } }),
      object("parent"),
      object("child", {
        parent: "parent",
        bounds: { min: [0.5, 0, 0], max: [1.5, 1, 1] },
      }),
      object("hidden", {
        visible: false,
        bounds: { min: [0.5, 0, 0], max: [1.5, 1, 1] },
      }),
    ]),
    metadata,
    options,
  );
  assert.equal(
    clean.issues.filter((issue) => issue.code === "overlap-candidate").length,
    0,
  );
  const bounded = summarizeQuality(
    raw(
      Array.from({ length: 600 }, (_, i) =>
        object("mesh" + i, { materialSlots: [], finiteTransform: false }),
      ),
    ),
    metadata,
    options,
  );
  assert.equal(bounded.summary.objectsTotal, 600);
  assert.equal(bounded.summary.objectsInspected, 500);
  assert.equal(bounded.summary.errorCount, 500);
  assert.equal(bounded.issues.length, MAX_QUALITY_ISSUES);
  assert.equal(bounded.limits.objectsTruncated, true);
  assert.equal(bounded.limits.issuesTruncated, true);
  const zeroArea = summarizeQuality(
    raw([object("plane", { bounds: { min: [0, 0, 0], max: [1, 1, 0] } })]),
    metadata,
    options,
  );
  assert.equal(
    zeroArea.issues.some((issue) => issue.code === "degenerate-bounds"),
    false,
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-quality-"));
  const scene = new SceneBridge(root);
  scene.activeProject = "project";
  scene.generation = 2;
  await mkdir(path.join(scene.projectRoot("project"), "captures"), {
    recursive: true,
  });
  let revision = "current";
  const python: string[] = [];
  let captures = 0;
  let rejectCaptureAt = 0;
  const captureArgs: unknown[] = [];
  const files: string[] = [];
  scene.info = async () => ({
    objects: [],
    revision,
    active: null,
    selected: [],
    mode: "OBJECT",
    frame: 1,
    version: "fixture",
    filepath: "scene.blend",
  });
  scene.upstream.json = async (code) => {
    python.push(code);
    return code.includes("objectsTotal")
      ? raw([object("mesh")])
      : { viewports: 1 };
  };
  scene.upstream.python = async (code) => {
    python.push(code);
    return "ok";
  };
  scene.capture = async (projectId, phase, runId, args) => {
    captureArgs.push(args);
    captures++;
    if (captures === rejectCaptureAt) throw new Error("capture fixture error");
    const file = path.join(root, `${captures}.jpg`);
    const count = Array.isArray(args?.views) ? args.views.length : 1;
    const columns = count === 1 ? 1 : 2,
      rows = Math.ceil(count / columns);
    const bytes = await sharp({
      create: {
        width: 8 * columns + (columns - 1) * 4,
        height: 8 * rows + (rows - 1) * 4,
        channels: 3,
        background: "red",
      },
    })
      .jpeg()
      .toBuffer();
    await writeFile(file, bytes);
    files.push(file);
    return {
      capture: {
        id: String(captures),
        projectId,
        phase,
        runId,
        path: file,
        mime: "image/jpeg",
        sceneRevision: revision,
        generation: scene.generation,
        mode: "viewport",
        createdAt: new Date().toISOString(),
      },
      image: {
        type: "image",
        data: bytes.toString("base64"),
        mimeType: "image/jpeg",
      },
    };
  };
  return {
    root,
    scene,
    python,
    files,
    captureArgs,
    setRevision: (value: string) => {
      revision = value;
    },
    failCapture: (value: number) => {
      rejectCaptureAt = value;
    },
  };
}

test("multi-view captures preserve ownership, use offscreen upstream angles, and reject invalid sets before touching Blender", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.scene.captureViews("other", "quality"), /场景绑定/);
    await assert.rejects(
      f.scene.captureViews("project", "quality", undefined, ["front", "front"]),
    );
    await assert.rejects(
      f.scene.captureViews("project", "quality", undefined, [
        "front",
        "right",
        "top",
        "isometric",
      ]),
    );
    assert.equal(f.python.length, 0);
    const captures = await f.scene.captureViews("project", "quality", "run", [
      "front",
      "right",
      "top",
    ]);
    assert.deepEqual(
      captures.map((v) => v.view),
      ["front", "right", "top"],
    );
    assert.deepEqual(
      captures.map((v) => v.capture.phase),
      ["quality:front", "quality:right", "quality:top"],
    );
    assert(
      captures.every(
        (v) =>
          v.capture.sceneRevision === "current" && v.capture.runId === "run",
      ),
    );
    assert.deepEqual(f.captureArgs, [
      { mode: "angles", views: ["front", "right", "top"] },
    ]);
    assert.equal(new Set(captures.map((v) => v.capture.id)).size, 3);
    for (const image of captures)
      assert.equal((await sharp(image.capture.path).metadata()).width, 8);
    assert.equal(
      f.python.length,
      0,
      "no user viewport or scene mutation script is issued",
    );
    assert.equal(
      f.python.some((code) =>
        /bpy\.ops\.|bpy\.data\.(objects|cameras)\.(new|remove)/.test(code),
      ),
      false,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("failed or stale multi-view evidence is removed without claiming a partial set", async () => {
  const f = await fixture();
  try {
    f.failCapture(1);
    await assert.rejects(
      f.scene.captureViews("project", "quality"),
      /capture fixture error/,
    );
    assert.equal(f.files.length, 0);
    f.failCapture(0);
    const original = f.scene.capture;
    f.scene.capture = async (...args) => {
      const result = await original(...args);
      result.capture.sceneRevision = "changed";
      return result;
    };
    await assert.rejects(
      f.scene.captureViews("project", "quality"),
      /场景发生变化/,
    );
    for (const file of f.files) await assert.rejects(stat(file), /ENOENT/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("inspection is bound to a current scene revision and rejects concurrent changes", async () => {
  const f = await fixture();
  try {
    const report = await f.scene.inspectQuality();
    assert.equal(report.projectId, "project");
    assert.equal(report.sceneRevision, "current");
    assert.equal(report.generation, 2);
    const original = f.scene.upstream.json;
    f.scene.upstream.json = async (code) => {
      const value = await original(code);
      f.setRevision("changed");
      return value;
    };
    await assert.rejects(f.scene.inspectQuality(), /结构检查期间场景发生变化/);
    await assert.rejects(f.scene.inspectQuality({ groundZ: Infinity }));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("multi-view capture rejects upstream plain-viewport fallback and wrong angle captions", async () => {
  const f = await fixture();
  try {
    const bytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    let caption =
      'look(mode="angles") is not available, so this is the plain viewport.';
    f.scene.upstream.call = async () => [
      { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
      { type: "text", text: caption },
    ];
    f.scene.capture = SceneBridge.prototype.capture;
    await assert.rejects(
      f.scene.capture("project", "quality:front", undefined, {
        mode: "angles",
        views: ["front"],
      }),
      /未返回所请求的检查视角/,
    );
    caption = "Tiles left to right, top to bottom: right.";
    await assert.rejects(
      f.scene.capture("project", "quality:front", undefined, {
        mode: "angles",
        views: ["front"],
      }),
      /未返回所请求的检查视角/,
    );
    caption = "Tiles left to right, top to bottom: front.";
    const image = await f.scene.capture("project", "quality:front", undefined, {
      mode: "angles",
      views: ["front"],
    });
    assert.equal(image.capture.mode, "angles");
    assert.equal(image.capture.sceneRevision, "current");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
