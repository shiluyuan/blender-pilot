/** Real, independent Blender desktop instances + external asset round trip.
 * Model requests use deterministic protocol fixtures, not live inference.
 * PILOT_EXTERNAL_TEST_GLB must point to Khronos' BoxTextured GLB (see docs).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Upstream } from "../packages/blender-bridge/upstream.js";
import { responsesFixture } from "../tests/fixtures/responses.js";
import { chromium } from "@playwright/test";
const root = process.cwd(),
  dir = path.resolve(process.env.PILOT_TEST_DATA || ".data/workspaces");
await mkdir(dir, { recursive: true });
const env = {
  ...process.env,
  PILOT_EXTERNAL_DESKTOP: "false",
  PILOT_MAX_STUDIOS: "2",
  PILOT_DATA: dir,
  PILOT_X11_TCP: process.env.PILOT_X11_TCP || "true",
  PILOT_DISPLAY_BASE: process.env.PILOT_DISPLAY_BASE || "170",
  PILOT_BLENDER_PORT_BASE: "19900",
  PILOT_VNC_PORT_BASE: "60100",
  PILOT_BOOTSTRAP_PATH: path.join(root, "deploy/bootstrap.py"),
  PILOT_PASSWORD: "workspace-test-password",
  PILOT_INTERNAL_TOKEN: "workspace-test-internal-token-only",
  HOST: "127.0.0.1",
  RUNNER_HOST: "127.0.0.1",
  RUNNER_PORT: "18191",
  PORT: "18190",
  PILOT_RUNNER_URL: "http://127.0.0.1:18191",
  PILOT_RUNNER_LOCAL_URL: "http://127.0.0.1:18191",
  CODEX_BIN: path.join(root, "node_modules/.bin/codex"),
};
const children: ChildProcess[] = [],
  upstreams: Upstream[] = [],
  fixtures: Awaited<ReturnType<typeof responsesFixture>>[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
  cookie = "";
const base = "http://127.0.0.1:18190";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function wait(
  check: () => Promise<any>,
  label: string,
  timeout = 180000,
) {
  const until = Date.now() + timeout;
  let last: any;
  while (Date.now() < until) {
    try {
      const value = await check();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await delay(250);
  }
  throw new Error(`Timed out: ${label}: ${last || ""}`);
}
function launch(name: string, args: string[]) {
  const log = createWriteStream(path.join(dir, name + ".log"));
  const c = spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  c.stdout!.pipe(log);
  c.stderr!.pipe(log);
  c.once("exit", () => log.end());
  children.push(c);
  return c;
}
async function api(route: string, body?: any, method?: string, expected = 200) {
  const binary = Buffer.isBuffer(body);
  const res = await fetch(base + "/api" + route, {
    method: method || (body ? "POST" : "GET"),
    headers: {
      cookie,
      "content-type": binary ? "application/octet-stream" : "application/json",
      ...(binary ? { "upload-offset": "0" } : {}),
    },
    body: body
      ? binary
        ? new Uint8Array(body)
        : JSON.stringify(body)
      : undefined,
  });
  if (route === "/auth/login")
    cookie = res.headers.get("set-cookie")!.split(";")[0];
  const value = (await res.json()) as any;
  assert.equal(res.status, expected, route + ": " + JSON.stringify(value));
  return value;
}
const checks: string[] = [];
const pass = (s: string) => {
  checks.push(s);
  console.log("PASS " + s);
};
try {
  launch("runner", ["dist/server/apps/runner/index.js"]);
  launch("app", ["dist/server/apps/server/index.js"]);
  await wait(async () => (await fetch(base + "/api/auth/status")).ok, "web");
  await api("/auth/login", { password: env.PILOT_PASSWORD });
  const [a, b, c] = await Promise.all(
    ["湖畔小屋", "角色工作室", "备用项目"].map((name) =>
      api("/projects", { name }),
    ),
  );
  const activated = await Promise.all([
    api(`/projects/${a.id}/activate`, {}),
    api(`/projects/${b.id}/activate`, {}),
  ]);
  assert.equal(activated.length, 2);
  const h = await api("/health");
  assert.equal(
    h.execution.studios.filter((s: any) => s.status === "ready").length,
    2,
  );
  await api(`/projects/${c.id}/activate`, {}, undefined, 409);
  const ua = new Upstream({ BLENDER_PORT: "19900" }),
    ub = new Upstream({ BLENDER_PORT: "19901" });
  upstreams.push(ua, ub);
  // Startup reserves slots in request arrival order; discover actual ownership.
  const first = await ua.json(
    "import json\nprint('PILOT_JSON:'+json.dumps(bpy.data.filepath))",
  );
  const aa = first.includes(a.id) ? ua : ub,
    bb = aa === ua ? ub : ua;
  await Promise.all([
    aa.python("bpy.data.objects['Cube'].name='Only_A'"),
    bb.python("bpy.data.objects['Cube'].name='Only_B'"),
  ]);
  const info = async (p: any) => api(`/projects/${p.id}/scene`);
  assert((await info(a)).objects.some((o: any) => o.name === "Only_A"));
  assert(!(await info(b)).objects.some((o: any) => o.name === "Only_A"));
  pass(
    "two live Blender processes, independent scenes, capacity refusal without eviction",
  );
  const fixtureFile = process.env.PILOT_EXTERNAL_TEST_GLB;
  if (!fixtureFile)
    throw new Error(
      "Set PILOT_EXTERNAL_TEST_GLB to the downloaded BoxTextured.glb",
    );
  const data = await readFile(fixtureFile);
  const sourceUrl =
    "https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/BoxTextured";
  const up = await api("/uploads", {
    destination: "library",
    name: "外部纹理方块.glb",
    size: data.length,
    library: {
      name: "外部纹理方块",
      category: "prop",
      sourceUrl,
      author: "Cesium",
      license: "CC BY 4.0; Cesium logo trademark notice applies",
    },
  });
  await api(`/uploads/${up.id}`, data, "PATCH");
  const external = await api(`/uploads/${up.id}/complete`, {});
  assert.equal(external.sourceUrl, sourceUrl);
  assert.equal(external.sourceProjectId, undefined);
  assert.equal((await api(`/uploads/${up.id}/complete`, {})).id, external.id);
  const [ia, ib] = await Promise.all([
    api(`/library/${external.id}/import`, { projectId: a.id }),
    api(`/library/${external.id}/import`, { projectId: b.id }),
  ]);
  assert(ia.objects.length && ib.objects.length);
  const imageStats =
    "import json\nprint('PILOT_JSON:'+json.dumps([{'name':i.name,'size':list(i.size),'packed':bool(i.packed_file)} for i in bpy.data.images if i.type=='IMAGE']))";
  const textures = await aa.json(imageStats);
  assert(textures.some((i: any) => i.size[0] > 1 && i.packed));
  await aa.python(
    `bpy.data.objects[${JSON.stringify(ia.objects[0])}].location.x=5`,
  );
  assert.equal(
    (await info(b)).objects.find((o: any) => o.name === ib.objects[0])
      .location[0],
    0,
  );
  pass(
    "external textured GLB uploaded directly to shared library; provenance, texture and independent cross-project copies",
  );
  await aa.python(
    "bpy.ops.mesh.primitive_cube_add(size=1,location=(0,0,0.5))\no=bpy.context.object\no.name='Wood_Chair'\no.scale=(1,1,0.3)\nm=bpy.data.materials.new('Oak')\nm.diffuse_color=(0.36,0.19,0.08,1)\no.data.materials.append(m)",
  );
  const chair = await api(`/projects/${a.id}/library`, {
    name: "木质座椅",
    category: "prop",
    objectNames: ["Wood_Chair"],
    tags: ["木质", "室内"],
  });
  const chairCopy = await api(`/library/${chair.id}/import`, {
    projectId: a.id,
  });
  await aa.python(
    "bpy.ops.mesh.primitive_uv_sphere_add(segments=16,ring_count=8,radius=.3,location=(1,0,1))\nbpy.context.object.name='New_Decoration'\nfor area in bpy.context.screen.areas:\n    if area.type=='VIEW_3D':\n        area.spaces.active.shading.color_type='MATERIAL'",
  );
  const composite = await api(`/projects/${a.id}/library`, {
    name: "阅读角组合",
    category: "scene",
    objectNames: [...ia.objects, ...chairCopy.objects, "New_Decoration"],
    tags: ["组合", "复用"],
    description: "外部模型、已有座椅和新建装饰物组成的场景",
  });
  assert.deepEqual(
    new Set(composite.sourceAssetIds),
    new Set([external.id, chair.id]),
  );
  const copied = await api(`/library/${composite.id}/import`, {
    projectId: b.id,
  });
  assert.equal(copied.objects.length, composite.objectNames.length);
  assert(
    (await bb.json(imageStats)).some((i: any) => i.size[0] > 1 && i.packed),
  );
  pass(
    "existing + external + newly created objects assembled, saved as reusable collection, imported in another project with textures and lineage",
  );
  const [sa, sb] = await Promise.all([
    api(`/projects/${a.id}/sessions`, {}),
    api(`/projects/${b.id}/sessions`, {}),
  ]);
  const fa = await responsesFixture(),
    fb = await responsesFixture("127.0.0.1", {
      referenceAssetId: composite.id,
    });
  fixtures.push(fa, fb);
  fa.setHold(true);
  const settings = (url: string) => ({
    baseUrl: url,
    apiKey: "fixture-only-secret",
    model: "gpt-5.1-codex",
    effort: "low",
  });
  await api("/settings", settings(fa.url), "PUT");
  const ra = await api(`/sessions/${sa.id}/turns`, {
    text: "A 的独立任务",
    assetIds: [],
    libraryAssetIds: [external.id],
    clientRequestId: randomUUID(),
  });
  await wait(async () => fa.requests.length, "A model request");
  await api(`/projects/${a.id}/close`, {}, undefined, 409);
  const bBeforeTurn = (await info(b)).objects.length;
  await api("/settings", settings(fb.url), "PUT");
  const rb = await api(`/sessions/${sb.id}/turns`, {
    text: "B 的独立任务，引用阅读角组合",
    assetIds: [],
    libraryAssetIds: [composite.id],
    clientRequestId: randomUUID(),
  });
  await wait(async () => {
    const r = (await api(`/sessions/${sb.id}/runs`)).find(
      (r: any) => r.id === rb.id,
    );
    if (["failed", "interrupted"].includes(r.status))
      throw new Error(JSON.stringify(r));
    return r.status === "succeeded" && r;
  }, "B Codex completion");
  const alive = (await api(`/sessions/${sa.id}/runs`)).find(
    (r: any) => r.id === ra.id,
  );
  assert(!["succeeded", "failed", "cancelled"].includes(alive.status));
  const hb = await api("/health");
  assert(hb.execution.activeRuns.some((r: any) => r.projectId === a.id));
  assert(
    (await info(b)).objects.some(
      (o: any) => o.name === "Pilot_Verified_Sphere",
    ),
  );
  assert.equal(
    (await info(b)).objects.length,
    bBeforeTurn + 1 + composite.objectNames.length,
    "native Codex imports the explicitly referenced composite alongside the new sphere",
  );
  assert(JSON.stringify(fb.requests).includes(composite.id));
  assert(!JSON.stringify(fb.requests).includes("A 的独立任务"));
  await api(`/runs/${ra.id}/cancel`, {});
  await wait(
    async () =>
      ["cancelled", "interrupted"].includes(
        (await api(`/sessions/${sa.id}/runs`)).find((r: any) => r.id === ra.id)
          .status,
      ),
    "A cancellation",
  );
  assert(
    !(await info(a)).objects.some(
      (o: any) => o.name === "Pilot_Verified_Sphere",
    ),
  );
  pass(
    "concurrent native Codex sessions: B finishes while A waits, project-scoped busy/close guard, separate scene and prompt, cancellation",
  );
  browser = await chromium.launch({
    executablePath: process.env.PILOT_BROWSER_BIN,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      ...(process.env.PILOT_BROWSER_ARGS?.split(",") || []),
    ],
  });
  const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
    }),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page
    .getByPlaceholder("部署时设置的 PILOT_PASSWORD")
    .fill(env.PILOT_PASSWORD);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.getByRole("tab", { name: a.name, exact: true }).waitFor();
  await page
    .locator(".project-viewport:not(.hidden)")
    .getByText("Blender 实时视口", { exact: true })
    .waitFor();
  assert.equal(
    await page.locator(".toast").count(),
    0,
    "login reuses an open project instead of attempting to exceed capacity",
  );
  await page.getByRole("tab", { name: a.name, exact: true }).click();
  await page
    .locator(".project-viewport:not(.hidden) .rfb-host canvas")
    .waitFor();
  await page.locator(".composer textarea").fill("只属于湖畔小屋的草稿");
  await page.getByRole("button", { name: "素材库", exact: true }).click();
  await page.getByLabel("选择 木质座椅", { exact: true }).check();
  await page.getByLabel("选择 外部纹理方块", { exact: true }).check();
  await page.getByRole("button", { name: "引用选中素材" }).click();
  assert.equal(await page.locator(".attachments > div").count(), 2);
  await page.getByRole("tab", { name: b.name, exact: true }).click();
  await wait(
    async () => (await page.locator(".composer textarea").inputValue()) === "",
    "B empty draft",
  );
  assert.equal(await page.locator(".attachments > div").count(), 0);
  await page.locator(".composer textarea").fill("角色项目草稿");
  await page.getByRole("tab", { name: a.name, exact: true }).click();
  await wait(
    async () =>
      (await page.locator(".composer textarea").inputValue()) ===
      "只属于湖畔小屋的草稿",
    "A restored draft",
  );
  assert.equal(await page.locator(".attachments > div").count(), 2);
  await page
    .getByRole("button", { name: "收起助手", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "展开助手", exact: true }).click();
  await page.screenshot({
    path: path.join(dir, "workspaces-dark.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "素材库", exact: true }).click();
  await page.getByRole("button", { name: "上传外部素材" }).click();
  await page.getByLabel("外部素材文件").setInputFiles({
    name: "浏览器外部模型.glb",
    mimeType: "model/gltf-binary",
    buffer: data,
  });
  await page.getByLabel("外部素材分类").selectOption("prop");
  await page.getByRole("button", { name: "上传并入库" }).click();
  await page.getByText("已入库：浏览器外部模型.glb", { exact: true }).waitFor();
  await page.getByLabel("选择 木质座椅", { exact: true }).check();
  await page.getByLabel("选择 外部纹理方块", { exact: true }).check();
  await page.screenshot({
    path: path.join(dir, "library-dark.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "导入选中素材" }).click();
  await page.getByText("已导入：外部纹理方块", { exact: true }).waitFor();
  await page.getByText("已导入：木质座椅", { exact: true }).waitFor();
  await page.getByRole("button", { name: "切换主题" }).click();
  await page.screenshot({
    path: path.join(dir, "library-light.png"),
    animations: "disabled",
  });
  await page.getByRole("tab", { name: b.name, exact: true }).click();
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.screenshot({
    path: path.join(dir, "workspaces-light.png"),
    animations: "disabled",
  });
  await page.reload();
  await page.getByRole("tab", { name: b.name, exact: true }).waitFor();
  await wait(
    async () =>
      (await page.locator(".composer textarea").inputValue()) ===
      "角色项目草稿",
    "draft survives reload",
  );
  await page
    .locator(".project-viewport:not(.hidden)")
    .getByText("Blender 实时视口", { exact: true })
    .waitFor();
  await page.setViewportSize({ width: 1280, height: 800 });
  // RFB's connected event precedes the first framebuffer. Verify visible,
  // non-uniform pixels after resizing, rather than accepting a blank canvas.
  await page.waitForFunction(() => {
    const c = document.querySelector(
      ".project-viewport:not(.hidden) .rfb-host canvas",
    ) as HTMLCanvasElement | null;
    if (
      !c ||
      c.getBoundingClientRect().width < 300 ||
      c.getBoundingClientRect().height < 200
    )
      return false;
    const ctx = c.getContext("2d");
    if (!ctx) return false;
    const data = ctx.getImageData(0, 0, c.width, c.height).data,
      colors = new Set<number>();
    const step = Math.max(4, Math.floor(data.length / 256 / 4) * 4);
    for (let i = 0; i < data.length; i += step)
      colors.add((data[i] << 16) + (data[i + 1] << 8) + data[i + 2]);
    return colors.size > 16;
  });
  await page.screenshot({
    path: path.join(dir, "workspaces-1280.png"),
    animations: "disabled",
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  pass(
    "browser: two live desktops, independent persistent drafts/references, library multiselect, direct external upload, batch import, collapsible assistant, dark/light and 1280px",
  );
  const beforeClose = (await info(a)).objects.length;
  await api(`/projects/${a.id}/close`, {});
  assert.equal((await api("/health")).execution.studios.length, 1);
  await api(`/projects/${a.id}/activate`, {});
  assert.equal((await info(a)).objects.length, beforeClose);
  assert((await info(b)).objects.some((o: any) => o.name === "Only_B"));
  pass(
    "save-and-close releases only its instance; reopen restores scene while other project stays live",
  );
  const probe = new Upstream({ BLENDER_PORT: aa === ua ? "19900" : "19901" });
  upstreams.push(probe);
  const pid = await probe.json(
    "import os,json\nprint('PILOT_JSON:'+json.dumps(os.getpid()))",
  );
  process.kill(pid, "SIGTERM");
  await wait(
    async () =>
      (await api("/health")).execution.studios.find(
        (s: any) => s.projectId === a.id,
      )?.status === "failed",
    "project failure status",
  );
  assert((await info(b)).objects.some((o: any) => o.name === "Only_B"));
  await api(`/projects/${a.id}/close`, {});
  assert.equal((await api("/health")).execution.studios.length, 1);
  pass(
    "injected Blender process failure is reported per project; B remains operational and failed A can be closed",
  );
  await writeFile(
    path.join(dir, "result.json"),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        mode: "real two-process Blender + native Codex protocol fixtures (not AI inference)",
        checks,
        projects: [a.id, b.id],
        sourceUrl,
        textures,
        composite: {
          id: composite.id,
          sourceAssetIds: composite.sourceAssetIds,
          objectCount: composite.objectNames.length,
        },
        screenshots: [
          "workspaces-dark.png",
          "workspaces-light.png",
          "library-dark.png",
          "library-light.png",
          "workspaces-1280.png",
        ],
      },
      null,
      2,
    ),
  );
  console.log("WORKSPACE ACCEPTANCE PASSED");
} catch (e) {
  if (browser)
    await browser
      .contexts()[0]
      ?.pages()[0]
      ?.screenshot({ path: path.join(dir, "failure.png") })
      .catch(() => {});
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await Promise.all(upstreams.map((u) => u.close().catch(() => {})));
  for (const child of children.reverse()) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((r) => child.once("exit", r)),
      delay(20000).then(() => child.kill("SIGKILL")),
    ]);
  }
  for (const f of fixtures) await f.close();
}
