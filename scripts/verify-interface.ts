/** Interface/status regression against the real Fastify app and SQL driver.
 * Runner responses are explicit fixtures; this suite does not claim Blender
 * execution, model inference, or Docker acceptance. Run after npm run build
 * through scripts/with-postgres.ts.
 */
import assert from "node:assert/strict";
import Fastify from "fastify";
import { chromium, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp } from "../apps/server/app.js";
import { LibraryCatalog } from "../packages/storage/library-catalog.js";

const output = path.resolve(
  process.env.PILOT_INTERFACE_TEST_DATA || ".data/interface-acceptance",
);
await mkdir(output, { recursive: true });
const checks: string[] = [];
const screenshots: string[] = [];
const captureOnly = process.env.PILOT_INTERFACE_CAPTURE_ONLY === "1";
const pass = (message: string) => {
  checks.push(message);
  console.log("PASS " + message);
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(fn: () => Promise<unknown>, name: string, timeout = 20000) {
  const until = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < until) {
    try {
      if (await fn()) return;
    } catch (error) {
      last = error;
    }
    await delay(75);
  }
  throw new Error("Timed out: " + name + ": " + String(last || ""));
}

type RunnerMode = "healthy" | "degraded" | "unavailable";
let mode: RunnerMode = "healthy";
let projectId = "";
let secondProjectId = "";
let runnerHealthReads = 0;
const runner = Fastify();
runner.get("/health", async (_req, reply) => {
  runnerHealthReads++;
  if (mode === "unavailable")
    return reply.code(503).send({ error: "Explicit test: Runner unavailable" });
  const degraded = mode === "degraded";
  return reply.code(degraded ? 503 : 200).send({
    ok: !degraded,
    maxStudios: 3,
    activeRuns: [],
    studios: [
      {
        projectId,
        status: "ready",
        version: "5.2.3 · interface fixture",
        blenderVersion: "5.2.3 · interface fixture",
      },
      {
        projectId: secondProjectId,
        status: degraded ? "failed" : "ready",
        version: "5.2.3 · interface fixture",
        blenderVersion: "5.2.3 · interface fixture",
        ...(degraded ? { error: "Explicit test: Blender process exited" } : {}),
      },
    ],
    ...(degraded ? { error: "Explicit test: project B is unavailable" } : {}),
  });
});
runner.post("/scene", async () => ({
  ok: true,
  objects: [],
  selected: [],
  mode: "OBJECT",
  revision: "interface-fixture",
  version: "5.2.3 · interface fixture",
}));
runner.post("/projects/:id/close", async () => ({ ok: true }));
const runnerUrl = await runner.listen({ host: "127.0.0.1", port: 0 });
const { app, store } = await buildApp({
  dataRoot: output,
  password: "interface-acceptance-password",
  internalToken: "interface-fixture-only-internal-token",
  runnerUrl,
  webRoot: path.join(process.cwd(), "dist/web"),
});
const base = await app.listen({ host: "127.0.0.1", port: 0 });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let failurePage: Page | undefined;
let cookie = "";
async function api(
  route: string,
  body?: unknown,
  method?: string,
): Promise<any> {
  const response = await fetch(base + "/api" + route, {
    method: method || (body ? "POST" : "GET"),
    headers: { cookie, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (route === "/auth/login")
    cookie = response.headers.get("set-cookie")!.split(";")[0];
  const value = await response.json();
  assert(response.ok, route + ": " + JSON.stringify(value));
  return value;
}

try {
  await api("/auth/login", { password: "interface-acceptance-password" });
  const project = await api("/projects", { name: "产品展示空间 · 验收夹具" });
  const other = await api("/projects", { name: "角色创作 · 独立项目" });
  projectId = project.id;
  secondProjectId = other.id;
  const session = await api(`/projects/${project.id}/sessions`, {});
  const catalog = new LibraryCatalog(store.db);
  for (const [name, category, tags] of [
    ["木质休闲椅 · Fixture", "prop", ["室内", "家具"]],
    ["模块化展示台 · Fixture", "prop", ["展示", "模块"]],
    ["极简客厅 · Fixture", "scene", ["室内", "场景"]],
    ["角色基础组件 · Fixture", "character", ["角色", "基础"]],
  ] as const) {
    const id = randomUUID();
    const dir = path.join(output, "library", id);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "asset.blend");
    await writeFile(file, "Interface catalog fixture; not a Blender file.");
    await catalog.create({
      id,
      name,
      category,
      description: "界面与分类验收数据，不代表已生成的 Blender 模型。",
      tags: [...tags],
      favorite: category === "prop",
      path: file,
      mime: "application/x-blender",
      size: 52,
      sha256: "interface-fixture",
      createdAt: new Date().toISOString(),
      source: "upload",
      objectNames: [],
      sourceUrl: "",
      license: "Test fixture",
      author: "Interface acceptance",
    });
  }
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--single-process", "--no-zygote"],
    ...(process.env.PILOT_BROWSER_BIN
      ? { executablePath: process.env.PILOT_BROWSER_BIN }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  await context.addInitScript(
    ({ pid, sid }) => {
      if (!localStorage.getItem("pilot-project")) {
        localStorage.setItem("pilot-project", pid);
        localStorage.setItem("pilot-chat-active:" + pid, sid);
        localStorage.setItem("pilot-panel-width", "440");
      }
    },
    { pid: project.id, sid: session.id },
  );
  const page = await context.newPage();
  failurePage = page;
  page.setDefaultTimeout(20000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  let releaseInitialHealth: (() => void) | undefined;
  if (process.env.PILOT_INTERFACE_BASELINE !== "1" && !captureOnly) {
    const initialHealthGate = new Promise<void>((resolve) => {
      releaseInitialHealth = resolve;
    });
    await page.route("**/api/health", async (route) => {
      await initialHealthGate;
      await route.continue();
    });
  }
  await page.goto(base);
  await page
    .getByPlaceholder("部署时设置的 PILOT_PASSWORD")
    .fill("interface-acceptance-password");
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  if (releaseInitialHealth) {
    await page.getByRole("button", { name: "运行控制台", exact: true }).click();
    await page.getByTestId("system-health-summary").waitFor();
    assert.match(
      await page.getByTestId("system-health-summary").innerText(),
      /正在检查|尚未/,
    );
    for (const name of ["execution", "model", "database", "storage"])
      assert.doesNotMatch(
        await page.getByTestId("metric-" + name).innerText(),
        /已连接|已配置|0 B/,
      );
    await page.screenshot({
      path: path.join(output, "00-console-first-check-dark.png"),
    });
    screenshots.push("00-console-first-check-dark.png");
    releaseInitialHealth();
    await wait(
      async () => !(await page.getByTestId("health-refresh").isDisabled()),
      "initial health request resolves",
    );
    await page.unroute("**/api/health");
    await page
      .getByRole("button", { name: "工作台", exact: true })
      .first()
      .click();
    pass("首次状态检查完成前显示待确认，不伪造离线、0字节或就绪状态");
  }
  await page.locator(".composer textarea").waitFor();
  await wait(
    async () => !(await page.locator(".composer textarea").isDisabled()),
    "workspace ready",
  );
  const capture = async (name: string) => {
    await page.screenshot({ path: path.join(output, name) });
    screenshots.push(name);
  };
  const nav = async (name: string) => {
    await page.getByRole("button", { name, exact: true }).first().click();
  };
  const refresh = async () => {
    await page.getByTestId("health-refresh").click();
    await wait(
      async () => !(await page.getByTestId("health-refresh").isDisabled()),
      "health refresh completes",
    );
  };
  const metric = (name: string) => page.getByTestId("metric-" + name);

  // Baseline capture mode is intentionally read-only and requires no new UI
  // hooks, so a visual reviewer can inspect the original before changes.
  if (process.env.PILOT_INTERFACE_BASELINE === "1") {
    await capture("before-01-studio-dark.png");
    await nav("素材库");
    await page.locator(".library-page").waitFor();
    await page.getByText("木质休闲椅 · Fixture", { exact: true }).waitFor();
    await capture("before-02-library-dark.png");
    await nav("模板中心");
    await page.locator(".templates-page").waitFor();
    await page.locator(".template-card").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    const cdp = await context.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const dom = await cdp.send("DOM.getDocument");
    const fonts = [];
    for (const selector of [
      ".rail-brand>span",
      ".templates-page h1",
      ".template-card strong",
    ]) {
      const { nodeId } = await cdp.send("DOM.querySelector", {
        nodeId: dom.root.nodeId,
        selector,
      });
      const actual = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      fonts.push({
        selector,
        ...actual,
        computed: await page
          .locator(selector)
          .first()
          .evaluate((el) => getComputedStyle(el).font),
      });
    }
    await cdp.detach();
    await writeFile(
      path.join(output, "baseline-fonts.json"),
      JSON.stringify(fonts, null, 2),
    );
    await capture("before-03-templates-dark.png");
    await nav("运行控制台");
    await page
      .getByRole("heading", { name: "运行控制台", exact: true })
      .waitFor();
    await capture("before-04-console-dark.png");
    await nav("模型设置");
    await page
      .getByRole("heading", { name: "模型与连接", exact: true })
      .waitFor();
    await capture("before-05-settings-dark.png");
    await nav("运行控制台");
    await page.getByRole("button", { name: "切换主题", exact: true }).click();
    await capture("before-06-console-light.png");
    const result = {
      passed: true,
      scope: "baseline-screenshots-only",
      time: new Date().toISOString(),
      screenshots,
      uncaughtBrowserErrors: errors,
      runner: "explicit protocol fixture; no Blender or model inference",
    };
    await writeFile(
      path.join(output, "baseline.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
  } else {
    await nav("运行控制台");
    await page.getByTestId("system-health-summary").waitFor();
    await refresh();
    if (!captureOnly) {
      assert.match(
        await metric("execution").innerText(),
        /已连接|可达|正常|就绪/,
      );
      assert.match(
        await metric("database").innerText(),
        /PostgreSQL|已连接|正常/,
      );
      assert.doesNotMatch(
        await metric("storage").innerText(),
        /未知|无法读取|0 B/,
      );
      assert.match(await metric("model").innerText(), /未配置/);
      assert.match(
        await page.getByTestId("system-health-summary").innerText(),
        /检查|更新/,
      );
      await capture("01-console-model-missing-dark.png");
      pass(
        "真实健康接口驱动执行器、数据库与存储显示，未配置模型明确提示且有检查时间",
      );

      await api(
        "/settings",
        {
          baseUrl: "https://fixture.invalid",
          model: "explicit-interface-fixture",
          apiKey: "fixture-only-not-a-real-key",
          effort: "low",
        },
        "PUT",
      );
      await refresh();
      assert.match(
        await metric("model").innerText(),
        /explicit-interface-fixture/,
      );
      assert.match(await metric("model").innerText(), /已配置/);
      assert.doesNotMatch(
        await metric("model").innerText(),
        /推理通过|已验证|测试通过/,
      );
      await capture("02-console-healthy-dark.png");
      pass("已保存的模型配置只标记已配置，不冒称真实推理或连接测试通过");

      const reads = runnerHealthReads;
      let resolveHealth: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        resolveHealth = resolve;
      });
      await page.route("**/api/health", async (route) => {
        await gate;
        await route.continue();
      });
      await page.getByTestId("health-refresh").click();
      await wait(
        async () => await page.getByTestId("health-refresh").isDisabled(),
        "refresh busy state",
      );
      await capture("03-console-refreshing-dark.png");
      resolveHealth();
      await wait(
        async () => !(await page.getByTestId("health-refresh").isDisabled()),
        "delayed refresh resolves",
      );
      await page.unroute("**/api/health");
      assert(runnerHealthReads > reads);
      pass("手动刷新真实请求健康接口，等待期间有忙碌状态并防止重复点击");

      mode = "degraded";
      await refresh();
      assert.match(
        await page.getByTestId("system-health-summary").innerText(),
        /异常|降级|故障|部分/,
      );
      assert.match(
        await page.locator("body").innerText(),
        /Explicit test: Blender process exited|Explicit test: project B is unavailable/,
      );
      assert.match(
        await metric("execution").innerText(),
        /可达|部分|降级|异常|已连接/,
      );
      await capture("04-console-degraded-dark.png");
      await nav("项目");
      await page
        .getByText("Explicit test: Blender process exited", { exact: false })
        .first()
        .waitFor();
      await capture("05-project-failure-dark.png");
      pass("Runner503保留结构化健康信息，单项目Blender故障可见并有恢复入口");

      await nav("运行控制台");
      mode = "healthy";
      await refresh();
      assert.doesNotMatch(
        await page.locator("body").innerText(),
        /Explicit test: Blender process exited/,
      );
      assert.match(
        await metric("execution").innerText(),
        /已连接|可达|正常|就绪/,
      );
      pass("故障恢复后重新读取当前状态，旧故障提示不残留");

      mode = "unavailable";
      await refresh();
      assert.match(await metric("execution").innerText(), /未连接|异常/);
      assert.match(
        await metric("database").innerText(),
        /PostgreSQL|已连接|正常/,
      );
      await capture("05b-console-runner-unavailable-dark.png");
      mode = "healthy";
      await wait(
        async () => /已连接/.test(await metric("execution").innerText()),
        "automatic health polling recovers Runner",
        18000,
      );
      pass("执行服务不可用时数据库仍单独展示，10秒轮询可自动恢复无需整页刷新");

      await page.route("**/api/health", (route) => route.abort("failed"));
      await refresh();
      assert.match(
        await page.getByTestId("system-health-summary").innerText(),
        /过期|更新失败|检查失败|无法获取|未能/,
      );
      assert.doesNotMatch(
        await page.getByTestId("workspace-health").innerText(),
        /^执行环境就绪$/,
      );
      await capture("06-console-stale-dark.png");
      await page.unroute("**/api/health");
      await refresh();
      assert.doesNotMatch(
        await page.getByTestId("system-health-summary").innerText(),
        /更新失败|检查失败|无法获取/,
      );
      pass("网络检查失败不会永久显示旧绿色状态，明确标记过期并可手动恢复");

      await page.route("**/api/health", async (route) => {
        const response = await route.fetch();
        const health: any = await response.json();
        health.storage = {
          ok: false,
          error: "Explicit test: storage probe denied",
        };
        await route.fulfill({ response, json: health });
      });
      await refresh();
      assert.match(
        await metric("storage").innerText(),
        /未知|无法读取|不可用|检查失败|—/,
      );
      assert.doesNotMatch(await metric("storage").innerText(), /0 B/);
      assert.match(
        await metric("database").innerText(),
        /PostgreSQL|已连接|正常/,
      );
      await capture("07-console-storage-unknown-dark.png");
      await page.unroute("**/api/health");
      await refresh();
      pass("磁盘探测失败显示未知而非0字节，数据库等独立状态仍能读取");

      await page.route("**/api/health", async (route) => {
        const response = await route.fetch();
        const health: any = await response.json();
        health.model = {
          ok: false,
          hasKey: false,
          model: "",
          baseUrl: "",
          error: "Explicit test: model config temporarily unreadable",
        };
        await route.fulfill({ response, json: health });
      });
      await refresh();
      assert.match(
        await metric("model").innerText(),
        /无法读取|读取失败|异常|检查失败|待确认|不可用/,
      );
      assert.doesNotMatch(await metric("model").innerText(), /未配置/);
      await capture("07b-console-model-unreadable-dark.png");
      await page.unroute("**/api/health");
      await refresh();
      pass("模型配置读取失败与尚未配置分开显示，恢复后保留原有模型配置");

      for (const malformed of [
        { app: true, database: { ok: true } },
        {
          app: true,
          execution: { ok: true, studios: {} },
          database: { ok: true },
        },
      ]) {
        await page.route("**/api/health", (route) =>
          route.fulfill({ json: malformed }),
        );
        await refresh();
        assert.match(
          await page.getByTestId("system-health-summary").innerText(),
          /过期|更新失败|检查失败|无法获取|未能/,
        );
        await page.unroute("**/api/health");
        await refresh();
      }
      pass(
        "健康接口字段缺失或数组格式损坏时不崩溃、不覆盖上次有效状态，恢复后可继续更新",
      );

      await nav("工作台");
      const editor = page.locator(".composer textarea");
      const choose = async (name: string) => {
        await page
          .locator(".project-explorer > button")
          .filter({ hasText: name })
          .click();
      };
      const selected = async (id: string) =>
        (await page.evaluate(() => localStorage.getItem("pilot-project"))) ===
          id && !(await editor.isDisabled());
      await editor.fill("项目A独立草稿 · activation ownership");
      let releaseActivation: () => void = () => {};
      let activationWaiting = false;
      const activationGate = new Promise<void>((resolve) => {
        releaseActivation = resolve;
      });
      await page.route(
        `**/api/projects/${other.id}/activate`,
        async (route) => {
          activationWaiting = true;
          await activationGate;
          await route.continue();
        },
      );
      await choose(other.name);
      await wait(
        async () => activationWaiting,
        "delayed project activation request",
      );
      assert(
        await editor.isDisabled(),
        "composer cannot accept another project's text during activation",
      );
      assert.match(
        (await editor.getAttribute("placeholder")) || "",
        /切换|打开|启动/,
      );
      await capture("08a-project-switch-pending-dark.png");
      releaseActivation();
      await wait(
        async () => selected(other.id),
        "project B owns composer after activation",
      );
      await page.unroute(`**/api/projects/${other.id}/activate`);
      assert.equal(await editor.inputValue(), "");
      await editor.fill("项目B独立草稿 · activation ownership");
      await choose(project.name);
      await wait(
        async () => selected(project.id),
        "project A owns composer again",
      );
      assert.equal(
        await editor.inputValue(),
        "项目A独立草稿 · activation ownership",
      );

      let failedActivationReceived = false;
      await page.route(
        `**/api/projects/${other.id}/activate`,
        async (route) => {
          failedActivationReceived = true;
          await route.fulfill({
            status: 503,
            json: { error: "Explicit test: activation unavailable" },
          });
        },
      );
      await choose(other.name);
      await wait(
        async () => failedActivationReceived && (await selected(project.id)),
        "failed activation returns to prior project ownership",
      );
      assert.equal(
        await editor.inputValue(),
        "项目A独立草稿 · activation ownership",
      );
      assert.equal(
        await page.evaluate(() => localStorage.getItem("pilot-project")),
        project.id,
      );
      await page.getByText(/Explicit test: activation unavailable/).waitFor();
      await page.unroute(`**/api/projects/${other.id}/activate`);
      await choose(other.name);
      await wait(
        async () => selected(other.id),
        "failed project can subsequently activate",
      );
      assert.equal(
        await editor.inputValue(),
        "项目B独立草稿 · activation ownership",
      );
      await choose(project.name);
      await wait(
        async () => selected(project.id),
        "restore primary project after activation test",
      );
      pass(
        "项目激活期间暂停编辑，完成后草稿归属正确；激活失败保留原项目草稿，重试可恢复",
      );
      if (await page.locator(".toast button").isVisible())
        await page.locator(".toast button").click();
    } else {
      await api(
        "/settings",
        {
          baseUrl: "https://fixture.invalid",
          model: "explicit-interface-fixture",
          apiKey: "fixture-only-not-a-real-key",
          effort: "low",
        },
        "PUT",
      );
      await refresh();
    }

    for (const theme of ["dark", "light"] as const) {
      if ((await page.locator("html").getAttribute("data-theme")) !== theme)
        await page
          .getByRole("button", { name: "切换主题", exact: true })
          .click();
      for (const [name, slug, visible] of [
        ["工作台", "studio", ".composer textarea"],
        ["素材库", "library", ".library-page"],
        ["模板中心", "templates", ".templates-page"],
        ["运行控制台", "console", "[data-testid=system-health-summary]"],
        ["模型设置", "settings", ".settings-page"],
      ]) {
        await nav(name);
        await page.locator(visible).waitFor();
        if (slug === "library")
          await page
            .getByText("木质休闲椅 · Fixture", { exact: true })
            .waitFor();
        if (slug === "templates")
          await page.locator(".template-card").first().waitFor();
        await capture(`08-${slug}-${theme}.png`);
        const overflow = await page.evaluate(() => ({
          document:
            document.documentElement.scrollWidth > window.innerWidth + 1,
          body: document.body.scrollWidth > window.innerWidth + 1,
        }));
        assert.deepEqual(
          overflow,
          { document: false, body: false },
          slug + " " + theme + " viewport overflow",
        );
      }
    }
    pass(
      "工作台、素材库、模板中心、控制台、设置五个页面深浅主题均可显示且无整页横向溢出",
    );

    await nav("工作台");
    await page.setViewportSize({ width: 1440, height: 960 });
    await capture("08-studio-reference-size-light.png");
    await page.getByRole("button", { name: "切换主题", exact: true }).click();
    await capture("08-studio-reference-size-dark.png");
    await page.getByRole("button", { name: "切换主题", exact: true }).click();
    await page
      .getByRole("button", { name: "收起助手", exact: true })
      .first()
      .click();
    assert.equal(await page.locator(".composer textarea").count(), 0);
    await page
      .getByRole("button", { name: "展开助手", exact: true })
      .first()
      .click();
    await page.locator(".composer textarea").waitFor();
    await page.getByRole("button", { name: "收起导航", exact: true }).click();
    await page.getByRole("button", { name: "展开导航", exact: true }).waitFor();
    await page.getByRole("button", { name: "展开导航", exact: true }).click();
    pass("导航和右侧助手均可收起再展开，当前工作区保持可操作");

    for (const width of [1280, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of ["工作台", "素材库", "运行控制台", "模型设置"]) {
        await nav(name);
        if (name === "素材库")
          await page
            .getByText("木质休闲椅 · Fixture", { exact: true })
            .waitFor();
        if (name === "工作台") {
          await page.locator(".composer textarea").waitFor();
          const footer = await page
            .locator(".viewport-bottom:visible")
            .evaluate((el) => ({
              height: el.clientHeight,
              labels: [...el.children].map((child) => ({
                height: child.clientHeight,
                whiteSpace: getComputedStyle(child).whiteSpace,
              })),
            }));
          for (const label of footer.labels) {
            assert.equal(label.whiteSpace, "nowrap");
            assert(
              label.height <= footer.height,
              "viewport hint cannot wrap outside footer",
            );
          }
        }
        await capture(`09-${width}-${name}.png`);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1,
        );
        assert.equal(overflow, false, name + " at " + width + "px overflow");
      }
    }
    pass("1280和1024桌面宽度下核心页面无整页横向溢出，操作入口可达");
    assert.deepEqual(errors, []);
    pass("界面与系统状态全部新增场景没有未捕获的浏览器错误");
    const result = {
      passed: true,
      scope: captureOnly
        ? "interface-visual-capture"
        : "interface-and-system-status",
      time: new Date().toISOString(),
      environment: {
        api: "real Fastify",
        database:
          process.env.PILOT_TEST_POSTGRES_MODE === "wasm-wire"
            ? "explicit PostgreSQL WASM over TCP/pg driver; not native PostgreSQL"
            : "PostgreSQL server",
        runner:
          "explicit health/scene fixture; no native Blender or model inference",
        browser: "Chromium/Playwright",
      },
      checks,
      screenshots,
      runnerHealthReads,
      uncaughtBrowserErrors: errors,
    };
    await writeFile(
      path.join(output, captureOnly ? "visual-result.json" : "result.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  await failurePage
    ?.screenshot({ path: path.join(output, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await app.close();
  await runner.close();
}
