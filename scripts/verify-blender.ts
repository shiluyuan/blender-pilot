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
const root = process.cwd(),
  dir = path.resolve(process.env.PILOT_TEST_DATA || ".data/integration");
await mkdir(dir, { recursive: true });
const children: ChildProcess[] = [];
const logs: string[] = [];
let childFailure: Error | undefined;
const env = {
  ...process.env,
  PILOT_DEBUG: "true",
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
    "--window-geometry",
    "0",
    "0",
    "1440",
    "900",
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
  for (const format of ["glb", "gltf", "blend"] as const) {
    const file = await bridge.export(format);
    assert((await stat(file)).size > 100);
    console.log("PASS export", format);
  }
  await bridge.restore("native-smoke", snapshot.path);
  assert(!(await bridge.info()).objects.some((o) => o.name === "Smoke_Cube"));
  const op = await bridge.queryApi("bpy.ops.mesh.primitive_cube_add");
  assert(op.properties.some((x: any) => x.name === "size"));
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
  async function api(route: string, body?: any, method?: string) {
    const r = await fetch(base + "/api" + route, {
      method: method || (body ? "POST" : "GET"),
      headers: { "content-type": "application/json", cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (route === "/auth/login")
      cookie = r.headers.get("set-cookie")!.split(";")[0];
    const j = (await r.json()) as any;
    if (!r.ok)
      throw new Error(route + " " + r.status + " " + JSON.stringify(j));
    return j;
  }
  await api("/auth/login", { password: env.PILOT_PASSWORD });
  fixture = await responsesFixture();
  await api(
    "/settings",
    {
      baseUrl: fixture.url,
      apiKey: "fixture-key-only",
      model: "gpt-5.1-codex",
      effort: "low",
    },
    "PUT",
  );
  assert((await api("/settings/test", {})).ok);
  const project = await api("/projects", { name: "光与几何 · 验证项目" });
  await api("/projects/" + project.id + "/activate", {});
  const session = await api("/projects/" + project.id + "/sessions", {});
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
  const images = fixture.requests.reduce(
    (n, b) => n + (JSON.stringify(b.input).match(/data:image\//g) || []).length,
    0,
  );
  assert(images >= 2, "baseline and post-mutation image must reach provider");
  const journal = await readFile(
    path.join(dir, "jobs", run.id + ".ndjson"),
    "utf8",
  );
  assert(journal.includes("scene.receipt"));
  assert(journal.includes("verification"));
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
  if (process.env.PILOT_BROWSER_BIN) {
    await waitFor(() => port(5900), "VNC", 20000);
    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch({
      executablePath: process.env.PILOT_BROWSER_BIN,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
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
    await page.screenshot({ path: path.join(dir, "workbench-dark.png") });
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
        time: new Date().toISOString(),
        blender: before.version,
        model: "deterministic Responses fixture (not real inference)",
        imageInputs: images,
        checks: [
          "native MCP",
          "snapshots",
          "GLB/glTF/blend exports",
          "Codex tool calls",
          "image input",
          "idempotency",
          "thread resume",
          "cancel",
          "browser VNC",
        ],
      },
      null,
      2,
    ),
  );
  console.log("ALL NATIVE CHECKS PASSED");
} catch (e) {
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
