/** Live-model assertions. Uses only synthetic images and a disposable project. */
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { Upstream } from "../packages/blender-bridge/upstream.js";

export type TestApi = (
  route: string,
  body?: any,
  method?: string,
  headers?: Record<string, string>,
) => Promise<any>;

export async function verifyRealModel(options: {
  api: TestApi;
  projectId: string;
  sessionId: string;
  dir: string;
  secret: string;
}) {
  const { api, projectId, sessionId, dir, secret } = options;
  const checks: string[] = [];
  const runIds: string[] = [];
  const waitFor = async (
    fn: () => Promise<any>,
    label: string,
    ms = 240000,
  ) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const value = await fn();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Live acceptance timed out: " + label);
  };
  const journal = async (id: string): Promise<any[]> => {
    const text = await readFile(path.join(dir, "jobs", id + ".ndjson"), "utf8");
    assert(!text.includes(secret), "secret must not enter the event journal");
    return text
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  };
  const terminal = async (id: string) =>
    waitFor(async () => {
      const run = (await api(`/sessions/${sessionId}/runs`)).find(
        (r: any) => r.id === id,
      );
      return (
        ["succeeded", "failed", "cancelled", "interrupted"].includes(
          run?.status,
        ) && run
      );
    }, id);
  const turn = async (text: string, assetIds: string[] = []) => {
    const body = { text, assetIds, clientRequestId: randomUUID() };
    const run = await api(`/sessions/${sessionId}/turns`, body);
    assert.equal((await api(`/sessions/${sessionId}/turns`, body)).id, run.id);
    runIds.push(run.id);
    const done = await terminal(run.id);
    assert.equal(done.status, "succeeded", done.error);
    assert.equal(done.verification, "passed");
    const events = await journal(run.id);
    const report = events
      .filter((e) => e.type === "verification" && e.payload.passed)
      .at(-1);
    assert(
      report?.payload.observations.length > 10,
      "real model must provide visual observations",
    );
    const capture = events.find(
      (e) =>
        e.type === "capture.created" &&
        e.payload.capture.id === report.payload.captureId,
    );
    assert(capture, "visual report must bind to a real capture in this run");
    assert.equal(
      capture.payload.capture.sceneRevision,
      (await api(`/projects/${projectId}/scene`)).revision,
    );
    return { run: done, events, report: report.payload };
  };
  // The prompt never reveals the expected colors. Ground truth remains in the test controller.
  const palette = ["#e12628", "#25bb48", "#264fe0"];
  const left = randomInt(palette.length);
  const right = (left + 1 + randomInt(palette.length - 1)) % palette.length;
  const tile = (color: string) =>
    sharp({
      create: { width: 260, height: 260, channels: 3, background: color },
    })
      .png()
      .toBuffer();
  const image = await sharp({
    create: { width: 640, height: 360, channels: 3, background: "#f7f7f7" },
  })
    .composite([
      { input: await tile(palette[left]), left: 35, top: 50 },
      { input: await tile(palette[right]), left: 345, top: 50 },
    ])
    .png()
    .toBuffer();
  await writeFile(path.join(dir, "visual-reference.png"), image);
  const upload = await api("/uploads", {
    projectId,
    name: "visual-reference.png",
    size: image.length,
  });
  await api(`/uploads/${upload.id}`, image, "PATCH", { "upload-offset": "0" });
  const asset = await api(`/uploads/${upload.id}/complete`, {});
  const first = await turn(
    "请先查看附件中左右两个色块。保留默认 Cube、Camera 和 Light。新增一个 UV 球体，命名 Live_Reference_Sphere，位置 (-3,0,1)，半径 1，材质匹配附件左侧色块；新增一个立方体，命名 Live_Reference_Cube，位置 (3,0,1)，边长 2，材质匹配右侧色块。不要把参考图片导入场景。让视口显示材质颜色并调整视角，使两个新物体和默认立方体都清楚可见。检查自动截图，说明实际看到的两种颜色和物体，并用 report_verification 提交结论。",
    [asset.id],
  );
  assert(first.events.some((e) => e.type === "scene.receipt"));
  assert(first.events.filter((e) => e.type === "capture.created").length >= 2);
  const upstream = new Upstream();
  const inspect = async () =>
    upstream.json(
      `import json\nitems=[]\nfor name in ['Live_Reference_Sphere','Live_Reference_Cube']:\n o=bpy.data.objects.get(name)\n if o is None: continue\n m=o.active_material\n c=list(m.diffuse_color) if m else []\n if m and m.use_nodes:\n  node=next((n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None)\n  if node: c=list(node.inputs['Base Color'].default_value)\n items.append({'name':name,'location':list(o.location),'dimensions':list(o.dimensions),'color':c})\nprint('PILOT_JSON:'+json.dumps(items))`,
    );
  let initial: any[];
  try {
    initial = await inspect();
  } finally {
    await upstream.close();
  }
  const validate = (items: any[], sphereZ: number) => {
    assert.equal(items.length, 2);
    for (const [index, name, x, z] of [
      [left, "Live_Reference_Sphere", -3, sphereZ],
      [right, "Live_Reference_Cube", 3, 1],
    ] as const) {
      const o = items.find((item) => item.name === name);
      assert(o, name);
      assert(
        Math.abs(o.location[0] - x) < 0.01 &&
          Math.abs(o.location[2] - z) < 0.01,
        "object position must match",
      );
      assert(
        o.color[index] > 0.15 &&
          o.color[index] >
            Math.max(
              ...o.color
                .slice(0, 3)
                .filter((_: number, i: number) => i !== index),
            ) *
              1.4,
        "material hue must match the unseen reference image",
      );
    }
  };
  validate(initial!, 1);
  const scene = await api(`/projects/${projectId}/scene`);
  for (const name of ["Cube", "Camera", "Light"])
    assert(scene.objects.some((o: any) => o.name === name));
  const nativeThread = (await api(`/projects/${projectId}/sessions`)).find(
    (s: any) => s.id === sessionId,
  ).nativeThreadId;
  assert(nativeThread);
  checks.push(
    "reference-image colors independently verified in real Blender materials",
    "mutation receipts",
    "current screenshot visual report",
    "request idempotency",
  );
  console.log(
    "PASS real model: reference image → bpy → actual colors/positions → screenshot verification",
  );
  const resumed = await turn(
    "把刚才新增的球体沿 Z 轴再向上移动 1 米，其他对象的位置、尺寸与材质保持不变。保持球体清楚可见，检查最新截图并提交视觉检查结论。",
  );
  const readback = new Upstream();
  let moved: any[];
  try {
    moved = await readback.json(
      `import json\nitems=[]\nfor name in ['Live_Reference_Sphere','Live_Reference_Cube']:\n o=bpy.data.objects[name]\n m=o.active_material\n c=list(m.diffuse_color)\n if m.use_nodes:\n  n=next((n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None)\n  if n: c=list(n.inputs['Base Color'].default_value)\n items.append({'name':name,'location':list(o.location),'dimensions':list(o.dimensions),'color':c})\nprint('PILOT_JSON:'+json.dumps(items))`,
    );
  } finally {
    await readback.close();
  }
  validate(moved!, 2);
  assert.equal(
    (await api(`/projects/${projectId}/sessions`)).find(
      (s: any) => s.id === sessionId,
    ).nativeThreadId,
    nativeThread,
  );
  checks.push("native process restart and conversation resume");
  console.log(
    "PASS real model: native thread resumed and contextual follow-up modified the correct object",
  );
  const cancelled = await api(`/sessions/${sessionId}/turns`, {
    text: "保持场景不变。请分30项详细解释当前场景中每个对象的布局、颜色、光照和可以改进的方向，先开始逐段说明，不要执行任何修改。",
    assetIds: [],
    clientRequestId: randomUUID(),
  });
  runIds.push(cancelled.id);
  await waitFor(
    async () =>
      (await journal(cancelled.id)).some((e) => e.type === "message.delta"),
    "real streamed output before cancellation",
    90000,
  );
  await api(`/runs/${cancelled.id}/cancel`, {});
  assert.equal((await terminal(cancelled.id)).status, "cancelled");
  checks.push("interruption during real streamed model output");
  const afterCancel = await turn(
    "刚才的长篇评审已经取消。现在只简短核对两个新增物体的当前位置与材质，保持场景不变，查看当前截图并提交视觉检查结论。",
  );
  assert.equal(
    (await api(`/projects/${projectId}/sessions`)).find(
      (s: any) => s.id === sessionId,
    ).nativeThreadId,
    nativeThread,
  );
  checks.push("successful continuation after cancellation");
  console.log("PASS real model: streaming cancellation and continuation");
  const allEvents = (await Promise.all(runIds.map(journal))).flat();
  const report = {
    passed: true,
    runIds,
    nativeThreadId: nativeThread,
    referenceGroundTruth: { left: palette[left], right: palette[right] },
    blenderReadback: moved!,
    captures: allEvents.filter((e) => e.type === "capture.created").length,
    toolCalls: allEvents.filter((e) => e.type === "tool.started").length,
    visualReports: [first.report, resumed.report, afterCancel.report],
    checks,
  };
  await writeFile(
    path.join(dir, "live-model-result.json"),
    JSON.stringify(report, null, 2),
  );
  return report;
}
