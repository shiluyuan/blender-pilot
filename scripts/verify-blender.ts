/** Real Blender + MCP + Codex app-server smoke test with an explicit model protocol fixture.
 * Run on Linux after installing the desktop dependencies, Blender, MCP and Codex.
 * All services are children of this process, so the test also works in isolated CI hosts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { connect } from "node:net";
import assert from "node:assert/strict";
import sharp from "sharp";
import { SceneBridge } from "../packages/blender-bridge/scene.js";
import { responsesFixture } from "../tests/fixtures/responses.js";
import { modelSettingsSchema } from "../packages/contracts/index.js";
import { verifyLibrary } from "./library-checks.js";
import { verifyRealModel } from "./real-model-checks.js";
import { verifyTemplateRealModel } from "./template-model-checks.js";
const configPath = process.env.PILOT_MODEL_CONFIG_FILE;
const liveSettings = configPath
  ? modelSettingsSchema.parse(JSON.parse(await readFile(configPath, "utf8")))
  : undefined;
if (
  liveSettings &&
  (!liveSettings.apiKey || process.env.PILOT_SKIP_CODEX === "true")
)
  throw new Error("Live acceptance requires a real key and cannot skip Codex");
const root = process.cwd(),
  dir = path.resolve(
    process.env.PILOT_TEST_DATA ||
      (liveSettings ? ".data/live-integration" : ".data/integration"),
  );
await mkdir(dir, { recursive: true });
const children: ChildProcess[] = [];
const logs: string[] = [];
let childFailure: Error | undefined;
const env = {
  ...process.env,
  PILOT_DEBUG: "true",
  PILOT_EXTERNAL_DESKTOP: "true",
  PILOT_DATA: dir,
  PILOT_PASSWORD: "integration-password-only",
  PILOT_INTERNAL_TOKEN: "integration-token-not-for-production",
  DISPLAY: process.env.PILOT_TEST_DISPLAY || "127.0.0.1:98",
  HOST: "127.0.0.1",
  RUNNER_HOST: "127.0.0.1",
  RUNNER_PORT: "18091",
  PORT: "18090",
  PILOT_RUNNER_URL: "http://127.0.0.1:18091",
  PILOT_RUNNER_LOCAL_URL: "http://127.0.0.1:18091",
  RUNNER_URL: "http://127.0.0.1:18091",
  CODEX_BIN:
    process.env.CODEX_BIN || path.join(root, "node_modules/.bin/codex"),
};
const launch = (name: string, bin: string, args: string[], extra = {}) => {
  const log = path.join(dir, name + ".log");
  logs.push(log);
  const stream = createWriteStream(log);
  const child = spawn(bin, args, {
    env: { ...env, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.pipe(stream);
  child.stderr!.pipe(stream);
  child.on("error", (e) => stream.write(String(e)));
  children.push(child);
  child.on("exit", (code) => {
    if (["xvfb", "blender", "runner", "app"].includes(name))
      childFailure = new Error(name + " exited " + code);
  });
  return child;
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(
  check: () => Promise<any>,
  label: string,
  timeout = 90_000,
) {
  const end = Date.now() + timeout;
  let last: any;
  while (Date.now() < end) {
    if (childFailure) throw childFailure;
    try {
      const result = await check();
      if (result) return result;
    } catch (e) {
      last = e;
    }
    await delay(300);
  }
  throw new Error("Timeout " + label + ": " + String(last || ""));
}
async function port(n: number) {
  return new Promise<boolean>((resolve) => {
    const s = connect(n, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}
let fixture: Awaited<ReturnType<typeof responsesFixture>> | undefined;
let bridge: SceneBridge | undefined;
let browser: any;
try {
  const display = Number(env.DISPLAY.split(":").at(-1));
  launch("xvfb", process.env.XVFB_BIN || "Xvfb", [
    `:${display}`,
    "-screen",
    "0",
    "1440x900x24",
    "-ac",
    "-nolisten",
    "unix",
    "-listen",
    "tcp",
  ]);
  await waitFor(() => port(6000 + display), "Xvfb");
  if (process.env.OPENBOX_BIN) launch("openbox", process.env.OPENBOX_BIN, []);
  launch("blender", process.env.BLENDER_BIN || "blender", [
    "--factory-startup",
    "-noaudio",
    "--window-fullscreen",
    "--python",
    path.join(root, "deploy/bootstrap.py"),
  ]);
  await waitFor(() => port(9876), "Blender addon", 120000);
  console.log("PASS Blender GUI and addon started");
  launch("vnc", process.env.X11VNC_BIN || "x11vnc", [
    "-display",
    env.DISPLAY,
    "-forever",
    "-shared",
    "-nopw",
    "-listen",
    "127.0.0.1",
    "-rfbport",
    "5900",
    "-noxdamage",
    "-noshm",
  ]);
  console.log("Starting MCP client");
  bridge = new SceneBridge(dir);
  await bridge.init();
  await bridge.serial(() => bridge!.activate("native-smoke"));
  const before = await bridge.info();
  assert(before.objects.length >= 3);
  const snapshot = await bridge.snapshot("Smoke baseline");
  await bridge.upstream.python(
    "bpy.ops.mesh.primitive_cube_add(location=(4,0,1))\nbpy.context.object.name='Smoke_Cube'",
  );
  assert((await bridge.info()).objects.some((o) => o.name === "Smoke_Cube"));
  const cap = await bridge.capture("native-smoke", "native-test");
  assert((await sharp(cap.capture.path).metadata()).width! > 200);
  assert.equal(
    (await bridge.info()).revision,
    cap.capture.sceneRevision,
    "a capture stays current without scene changes",
  );
  const exported: Record<string, string> = {};
  for (const format of ["glb", "gltf", "blend"] as const) {
    const file = await bridge.export(format);
    exported[format] = file;
    assert((await stat(file)).size > 100);
    if (format === "gltf") {
      const doc = JSON.parse(await readFile(file, "utf8"));
      assert(doc.buffers.every((b: any) => b.uri.startsWith("data:")));
    }
    console.log("PASS export", format);
  }
  await bridge.restore("native-smoke", snapshot.path);
  assert(!(await bridge.info()).objects.some((o) => o.name === "Smoke_Cube"));
  const objectCount = (await bridge.info()).objects.length;
  await bridge.import(exported.glb);
  assert(
    (await bridge.info()).objects.length > objectCount,
    "GLB import modifies the real scene",
  );
  await bridge.restore("native-smoke", snapshot.path);
  const op = await bridge.queryApi("bpy.ops.mesh.primitive_cube_add");
  assert(op.properties.some((x: any) => x.name === "size"));
  const libraryReport = await verifyLibrary(bridge, dir);
  await bridge.upstream.close();
  bridge = undefined;
  console.log("PASS real MCP mutation, screenshot, snapshot, restore and RNA");
  launch("runner", process.execPath, ["dist/server/apps/runner/index.js"]);
  await waitFor(async () => {
    const r = await fetch("http://127.0.0.1:18091/health", {
      headers: { authorization: "Bearer " + env.PILOT_INTERNAL_TOKEN },
    });
    return r.ok && ((await r.json()) as any).ok;
  }, "runner");
  launch("app", process.execPath, ["dist/server/apps/server/index.js"]);
  await waitFor(
    async () => (await fetch("http://127.0.0.1:18090/api/auth/status")).ok,
    "app",
  );
  const base = "http://127.0.0.1:18090";
  let cookie = "";
  async function api(
    route: string,
    body?: any,
    method?: string,
    extraHeaders: Record<string, string> = {},
  ) {
    const binary = Buffer.isBuffer(body);
    const r = await fetch(base + "/api" + route, {
      method: method || (body ? "POST" : "GET"),
      headers: {
        "content-type": binary
          ? "application/octet-stream"
          : "application/json",
        cookie,
        ...extraHeaders,
      },
      body: body
        ? binary
          ? new Uint8Array(body)
          : JSON.stringify(body)
        : undefined,
    });
    if (route === "/auth/login")
      cookie = r.headers.get("set-cookie")!.split(";")[0];
    const j = (await r.json()) as any;
    if (!r.ok)
      throw new Error(route + " " + r.status + " " + JSON.stringify(j));
    return j;
  }
  await api("/auth/login", { password: env.PILOT_PASSWORD });
  if (!liveSettings) fixture = await responsesFixture();
  await api(
    "/settings",
    liveSettings || {
      baseUrl: fixture!.url,
      apiKey: "fixture-key-only",
      model: "gpt-5.1-codex",
      effort: "low",
    },
    "PUT",
  );
  assert((await api("/settings/test", {})).ok);
  const reuseLiveResult = process.env.PILOT_REUSE_LIVE_RESULT === "true";
  if (reuseLiveResult && !liveSettings)
    throw new Error("Reusing live results requires live model configuration");
  const previousLive = reuseLiveResult
    ? JSON.parse(
        await readFile(path.join(dir, "live-model-result.json"), "utf8"),
      )
    : undefined;
  const previousState = previousLive
    ? JSON.parse(
        await readFile(
          path.join(dir, "jobs", previousLive.runIds[0] + ".json"),
          "utf8",
        ),
      )
    : undefined;
  if (previousLive) assert.equal(previousLive.passed, true);
  const project = previousState
    ? (await api("/projects")).find(
        (p: any) => p.id === previousState.projectId,
      )
    : await api("/projects", { name: "光与几何 · 验证项目" });
  assert(project, "previous live project must still exist");
  await api("/projects/" + project.id + "/activate", {});
  const session = previousState
    ? (await api(`/projects/${project.id}/sessions`)).find(
        (s: any) => s.id === previousState.sessionId,
      )
    : await api("/projects/" + project.id + "/sessions", {});
  assert(session, "previous live session must still exist");
  let images = 0;
  let liveReport: Awaited<ReturnType<typeof verifyRealModel>> | undefined;
  let templateReport:
    Awaited<ReturnType<typeof verifyTemplateRealModel>> | undefined;
  const skipCodex = process.env.PILOT_SKIP_CODEX === "true";
  if (previousLive) {
    assert.equal(session.nativeThreadId, previousLive.nativeThreadId);
    const persistedRuns = await api(`/sessions/${session.id}/runs`);
    for (const id of previousLive.runIds) {
      const run = persistedRuns.find((r: any) => r.id === id);
      assert(run && ["succeeded", "cancelled"].includes(run.status));
    }
    liveReport = previousLive;
    console.log(
      "REUSE previously passed live-model assertions; rerun browser checks after service restart",
    );
  } else if (liveSettings) {
    liveReport = await verifyRealModel({
      api,
      projectId: project.id,
      sessionId: session.id,
      dir,
      secret: liveSettings.apiKey!,
    });
    templateReport = await verifyTemplateRealModel({
      api,
      projectId: project.id,
      sessionId: session.id,
      libraryAssetId: libraryReport.assetIds[0],
      dir,
      secret: liveSettings.apiKey!,
    });
  } else if (!skipCodex && fixture) {
    const body = {
      text: "添加一个绿色球体，保留原场景，并检查结果。",
      assetIds: [],
      clientRequestId: "fixture-turn-1",
    };
    const run = await api("/sessions/" + session.id + "/turns", body);
    const duplicate = await api("/sessions/" + session.id + "/turns", body);
    assert.equal(duplicate.id, run.id);
    const finished = await waitFor(
      async () => {
        const runs = await api("/sessions/" + session.id + "/runs");
        const r = runs.find((r: any) => r.id === run.id);
        return ["succeeded", "failed", "cancelled", "interrupted"].includes(
          r?.status,
        )
          ? r
          : false;
      },
      "native Codex turn",
      180000,
    );
    await writeFile(
      path.join(dir, "fixture-requests.json"),
      JSON.stringify(fixture.requests, null, 2),
    );
    console.log("Codex result", JSON.stringify(finished));
    assert.equal(finished.status, "succeeded", finished.error);
    const info = await api("/projects/" + project.id + "/scene");
    assert(info.objects.some((o: any) => o.name === "Pilot_Verified_Sphere"));
    images = fixture.requests.reduce(
      (n, b) =>
        n + (JSON.stringify(b.input).match(/data:image\//g) || []).length,
      0,
    );
    assert(images >= 2, "baseline and post-mutation image must reach provider");
    const journal = await readFile(
      path.join(dir, "jobs", run.id + ".ndjson"),
      "utf8",
    );
    assert(journal.includes("scene.receipt"));
    assert(journal.includes("verification"));
    for (const tool of [
      "save_library_asset",
      "search_library",
      "get_library_asset",
      "import_library_asset",
    ]) {
      assert(
        journal
          .split("\n")
          .filter(Boolean)
          .map((x) => JSON.parse(x))
          .some((e) => e.type === "tool.completed" && e.payload.name === tool),
        `${tool} must complete through native Codex`,
      );
    }
    assert(
      info.objects.some((o: any) => o.name === "Pilot_Verified_Sphere.001"),
    );
    console.log(
      "PASS native Codex library tools: save → search → preview → append",
    );
    assert(!journal.includes("fixture-key-only"));
    console.log(
      "PASS native Codex app-server → MCP → real Blender → images in Responses input",
    );
    const bound = (await api("/projects/" + project.id + "/sessions"))[0]
      .nativeThreadId;
    assert(bound);
    const run2 = await api("/sessions/" + session.id + "/turns", {
      text: "确认当前场景。",
      clientRequestId: "fixture-resume",
      assetIds: [],
    });
    // The fixture's final-only response intentionally cannot assert verification.
    await waitFor(
      async () => {
        const r = (await api("/sessions/" + session.id + "/runs")).find(
          (r: any) => r.id === run2.id,
        );
        return ["succeeded", "failed", "interrupted"].includes(r?.status) && r;
      },
      "resume",
      120000,
    );
    assert.equal(
      (await api("/projects/" + project.id + "/sessions"))[0].nativeThreadId,
      bound,
    );
    console.log(
      "PASS native thread resume; missing visual report does not become success",
    );
    fixture.setHold(true);
    const run3 = await api("/sessions/" + session.id + "/turns", {
      text: "取消测试",
      clientRequestId: "fixture-cancel",
      assetIds: [],
    });
    const count = fixture.requests.length;
    await waitFor(
      async () => fixture!.requests.length > count,
      "request started",
    );
    await api("/runs/" + run3.id + "/cancel", {});
    const cancelled = await waitFor(
      async () => {
        const r = (await api("/sessions/" + session.id + "/runs")).find(
          (r: any) => r.id === run3.id,
        );
        return r?.status === "cancelled" && r;
      },
      "cancel",
      30000,
    );
    assert.equal(cancelled.status, "cancelled");
    fixture.setHold(false);
    console.log("PASS native turn interruption");
  } else console.log("SKIP Codex: desktop/Blender-only validation requested");
  if (process.env.PILOT_BROWSER_BIN) {
    await waitFor(() => port(5900), "VNC", 20000);
    const { chromium } = await import("@playwright/test");
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
    });
    const errors: string[] = [];
    page.on("pageerror", (e: any) => errors.push(e.message));
    await page.goto(base);
    await page
      .getByPlaceholder("部署时设置的 PILOT_PASSWORD")
      .fill(env.PILOT_PASSWORD);
    await page.getByRole("button", { name: "进入工作台" }).click();
    await page
      .getByText("Blender 实时视口", { exact: true })
      .waitFor({ timeout: 30000 });
    await page.locator(".rfb-host canvas").waitFor();
    if (liveSettings) {
      const beforeRuns = new Set(
        (await api(`/sessions/${session.id}/runs`)).map((r: any) => r.id),
      );
      await page
        .locator("textarea")
        .fill(
          "浏览器对话验收：保持场景不变，查看当前截图，简短描述两个新增物体的颜色与相对位置，并提交视觉检查结论。",
        );
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      const browserRun = await waitFor(
        async () => {
          const run = (await api(`/sessions/${session.id}/runs`)).find(
            (r: any) => !beforeRuns.has(r.id),
          );
          return (
            ["succeeded", "failed", "interrupted", "cancelled"].includes(
              run?.status,
            ) && run
          );
        },
        "browser real-model chat",
        180000,
      );
      assert.equal(browserRun.status, "succeeded", browserRun.error);
      assert.equal(browserRun.verification, "passed");
      // The durable API state can lead SSE delivery by one browser tick.
      // Verify the visible completion state before recording the screenshot.
      await page
        .getByRole("button", { name: "发送消息", exact: true })
        .waitFor({ timeout: 10000 });
      const browserJournal = await readFile(
        path.join(dir, "jobs", browserRun.id + ".ndjson"),
        "utf8",
      );
      assert(!browserJournal.includes(liveSettings.apiKey!));
      const browserEvents = browserJournal
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      liveReport!.runIds.push(browserRun.id);
      liveReport!.captures += browserEvents.filter(
        (e) => e.type === "capture.created",
      ).length;
      liveReport!.toolCalls += browserEvents.filter(
        (e) => e.type === "tool.started",
      ).length;
      liveReport!.visualReports.push(
        browserEvents
          .filter((e) => e.type === "verification" && e.payload.passed)
          .at(-1).payload,
      );
      liveReport!.checks.push(
        "browser composer → real model → screenshot report → streamed completion",
      );
      console.log(
        "PASS browser conversation with the real model and screenshot verification",
      );
    }
    await page.screenshot({ path: path.join(dir, "workbench-dark.png") });
    const canvas = await page.locator(".rfb-host canvas").elementHandle();
    await page
      .getByRole("button", { name: "收起助手", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: "展开助手", exact: true }).click();
    assert(
      await canvas!.evaluate((el: Element) => el.isConnected),
      "sidebar must not remount Blender",
    );
    await page.getByRole("button", { name: "切换主题" }).click();
    await page.screenshot({ path: path.join(dir, "workbench-light.png") });
    await page.getByRole("button", { name: "切换主题" }).click();
    await page.getByRole("button", { name: "截图", exact: true }).click();
    await page.locator(".attachments").getByText("当前场景截图").waitFor();
    const reference = await sharp({
      create: { width: 600, height: 400, channels: 3, background: "#7bb8a3" },
    })
      .png()
      .toBuffer();
    // The chat composer has its own picker; use the project-resource picker.
    await page.locator('input[type="file"]').last().setInputFiles({
      name: "场景参考.png",
      mimeType: "image/png",
      buffer: reference,
    });
    await page.getByRole("button", { name: "素材库", exact: true }).click();
    await page.getByRole("button", { name: "物品", exact: true }).click();
    await page.getByText("木质座椅", { exact: true }).waitFor();
    await page.getByLabel("搜索素材").fill("客厅");
    await page.getByText("木质座椅", { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(dir, "library-dark.png"),
      animations: "disabled",
    });
    await page.getByRole("button", { name: "切换主题" }).click();
    await page.screenshot({
      path: path.join(dir, "library-light.png"),
      animations: "disabled",
    });
    await page.getByRole("button", { name: "切换主题" }).click();
    await page
      .getByRole("button", { name: "编辑 木质座椅", exact: true })
      .click();
    await page.getByLabel("描述", { exact: true }).fill("浏览器编辑的复用素材");
    await page.getByRole("button", { name: "保存素材", exact: true }).click();
    await page.getByText("浏览器编辑的复用素材", { exact: true }).waitFor();
    const libCard = page
      .locator(".library-card")
      .filter({ hasText: "木质座椅" });
    await libCard.getByRole("button", { name: "导入", exact: true }).click();
    await page
      .getByText("已作为独立副本导入当前项目", { exact: true })
      .waitFor();
    await libCard
      .getByRole("button", { name: "对话引用", exact: true })
      .click();
    await page
      .locator(".attachments")
      .getByText("木质座椅", { exact: true })
      .waitFor();
    await page.locator("textarea").first().fill("");
    await page.getByRole("button", { name: "素材库", exact: true }).click();
    await page
      .getByRole("button", { name: "从 Blender 保存", exact: true })
      .click();
    await page.getByLabel("素材名称", { exact: true }).fill("浏览器保存场景");
    await page.getByLabel("保存范围", { exact: true }).selectOption("scene");
    await page.getByLabel("分类", { exact: true }).selectOption("scene");
    await page.getByRole("button", { name: "保存素材", exact: true }).click();
    await page.getByText("浏览器保存场景", { exact: true }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "素材库", exact: true }).click();
    await page.getByText("浏览器保存场景", { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(dir, "library-dark.png"),
      animations: "disabled",
    });
    await page.getByRole("button", { name: "切换主题" }).click();
    await page.screenshot({
      path: path.join(dir, "library-light.png"),
      animations: "disabled",
    });
    await page.getByRole("button", { name: "切换主题" }).click();
    await page.setViewportSize({ width: 1280, height: 800 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      "Library fits 1280px",
    );
    await page.setViewportSize({ width: 1600, height: 1000 });
    console.log(
      "PASS library browser categories, search, edit, import, chat reference, save and reload",
    );
    await page.getByRole("button", { name: "资源库", exact: true }).click();
    await page
      .locator(".asset-card")
      .getByText("场景参考.png", { exact: true })
      .waitFor();
    await page.screenshot({ path: path.join(dir, "assets.png") });
    await page
      .locator(".asset-card")
      .filter({ hasText: "场景参考.png" })
      .getByRole("button", { name: "引用", exact: true })
      .click();
    await page.locator(".attachments").getByText("场景参考.png").waitFor();
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    assert.equal(
      await page.getByPlaceholder("已保存 · 留空保留现有 Key").inputValue(),
      "",
    );
    await page
      .getByRole("button", { name: "保存并测试连接", exact: true })
      .click();
    await page
      .getByText(
        "Responses API 连通。视觉与 Blender 工具能力请通过工作台真实任务验证。",
        { exact: true },
      )
      .waitFor();
    await page.screenshot({ path: path.join(dir, "settings.png") });
    await page.getByRole("button", { name: "快照与恢复", exact: true }).click();
    await page.getByRole("button", { name: "建立快照", exact: true }).click();
    await page
      .locator(".snapshot-row")
      .getByText("手动保存点", { exact: true })
      .waitFor();
    page.once("dialog", (dialog: any) => dialog.accept());
    await page
      .locator(".snapshot-row")
      .first()
      .getByRole("button", { name: "恢复", exact: true })
      .click();
    await page.getByText("已恢复，并保留恢复前备份", { exact: true }).waitFor();
    await page.getByRole("button", { name: "工作台", exact: true }).click();
    await page.getByRole("button", { name: "导出", exact: true }).click();
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "GLB 单文件模型，适合网页和游戏" })
      .click();
    assert((await downloaded).suggestedFilename().endsWith(".glb"));
    await page.reload();
    await page.getByText("Blender 实时视口", { exact: true }).waitFor();
    await page.setViewportSize({ width: 1280, height: 800 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    console.log(
      "PASS sidebar continuity, light theme, screenshot reference, upload, asset reference, settings, snapshot restore, export, reload and 1280px layout",
    );
    console.log(
      "PASS browser login + actual Blender over authenticated WebSocket",
    );
    await browser.close();
    browser = undefined;
    assert.deepEqual(errors, []);
  }
  await writeFile(
    path.join(dir, "result.json"),
    JSON.stringify(
      {
        passed: true,
        codex: skipCodex ? "not-tested" : "passed",
        time: new Date().toISOString(),
        blender: before.version,
        model:
          liveSettings?.model ||
          "deterministic Responses fixture (not real inference)",
        provider: liveSettings?.baseUrl,
        databaseValidation:
          process.env.PILOT_TEST_POSTGRES_MODE === "wasm-wire"
            ? "PostgreSQL WASM engine over TCP protocol; native PostgreSQL not exercised"
            : "PostgreSQL server",
        mode: liveSettings ? "live-model" : "protocol-fixture",
        reusedLiveChecks: reuseLiveResult,
        imageInputs: liveSettings ? undefined : images,
        live: liveReport,
        library: libraryReport,
        templates: templateReport,
        checks: [
          "native MCP",
          "snapshots",
          "GLB/glTF/blend exports",
          ...(skipCodex
            ? []
            : [
                "Codex tool calls",
                "image input",
                "idempotency",
                "thread resume",
                "cancel",
              ]),
          "browser VNC",
        ],
      },
      null,
      2,
    ),
  );
  if (liveReport)
    await writeFile(
      path.join(dir, "live-model-result.json"),
      JSON.stringify(liveReport, null, 2),
    );
  console.log(
    skipCodex
      ? "BLENDER / DESKTOP CHECKS PASSED; CODEX NOT TESTED"
      : "ALL NATIVE CHECKS PASSED",
  );
} catch (e) {
  const failurePage = browser?.contexts()[0]?.pages()[0];
  if (failurePage) {
    await failurePage
      .screenshot({ path: path.join(dir, "failure.png") })
      .catch(() => {});
    console.error(
      "Visible dialogs:",
      await failurePage
        .locator("dialog")
        .allTextContents()
        .catch(() => []),
    );
  }
  console.error(e);
  for (const f of logs) {
    try {
      console.error(
        "\n" +
          path.basename(f) +
          "\n" +
          (await readFile(f, "utf8")).slice(-6500),
      );
    } catch {}
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  await bridge?.upstream.close();
  await fixture?.close();
  for (const p of children.reverse()) p.kill("SIGTERM");
  await delay(1000);
  for (const p of children) if (p.exitCode === null) p.kill("SIGKILL");
}
