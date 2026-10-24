/** Skills UX against real Fastify, persisted skill files and SQL/pg/TCP.
 * Runner and npx downloads are explicit local fixtures in this browser suite;
 * it does not claim native Blender, public-package installation or inference.
 * Run after build via scripts/with-postgres.ts.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import Fastify from "fastify";
import { chromium, type Page } from "@playwright/test";
import { buildApp } from "../apps/server/app.js";
import type {
  Capture,
  PilotEvent,
  Run,
  Snapshot,
} from "../packages/contracts/index.js";

const output = path.resolve(
  process.env.PILOT_SKILLS_TEST_DATA || ".data/skills-browser",
);
await mkdir(output, { recursive: true });
const checks: string[] = [];
const screenshots: string[] = [];
const pass = (label: string) => {
  checks.push(label);
  console.log("PASS " + label);
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(fn: () => Promise<unknown>, label: string) {
  const end = Date.now() + 20000;
  let error: unknown;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch (e) {
      error = e;
    }
    await delay(70);
  }
  throw new Error("Timed out: " + label + ": " + String(error || ""));
}
const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# ${description}\n\n用于界面验收的明确技能夹具。\n\n## 操作步骤\n\n1. 读取当前场景，确认对象和尺寸。\n2. 通过 Blender MCP 完成操作。\n3. 检查多角度画面，记录仍需修改的部分。\n\n请保留原始素材，通过独立副本完成组合。\n`;

// Minimal uncompressed ZIP fixture writer; production reads through its own
// separately tested bounded parser. No shell command or package installation.
function zip(files: Record<string, string>) {
  let offset = 0;
  const locals: Buffer[] = [],
    centrals: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name),
      content = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, filename, content);
    centrals.push(central, filename);
    offset += local.length + filename.length + content.length;
  }
  const directory = Buffer.concat(centrals),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

type WorkflowJob = { run: Run; events: PilotEvent[] };
const workflowJobs = new Map<string, WorkflowJob>();
let restores = 0;
const runner = Fastify();
runner.get("/health", async () => ({
  ok: true,
  maxStudios: 3,
  studios: [],
  activeRuns: [...workflowJobs.values()]
    .filter((j) => j.run.status === "running")
    .map((j) => ({
      id: j.run.id,
      projectId: j.run.projectId,
      sessionId: j.run.sessionId,
    })),
}));
runner.get("/jobs/:id", async (req, reply) => {
  const job = workflowJobs.get((req.params as any).id);
  if (!job)
    return reply.code(404).send({ error: "Explicit fixture job absent" });
  return {
    id: job.run.id,
    status: job.run.status,
    verification: job.run.verification,
    seq: job.events.length,
    updatedAt: job.run.updatedAt,
  };
});
runner.get("/jobs/:id/events", async (req) =>
  (workflowJobs.get((req.params as any).id)?.events || []).filter(
    (e) => e.seq > Number((req.query as any).after || 0),
  ),
);
runner.post("/scene", async (req) => {
  const input = req.body as any;
  if (input.action === "restore") {
    restores++;
    const id = randomUUID(),
      file = path.join(
        output,
        "projects",
        input.projectId,
        "snapshots",
        id + ".blend",
      );
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      "Explicit restore receipt fixture, not a Blender scene",
    );
    return {
      id,
      projectId: input.projectId,
      name: "恢复前备份 · 协议夹具",
      path: file,
      createdAt: new Date().toISOString(),
    };
  }
  return {
    ok: true,
    objects: [],
    selected: [],
    mode: "OBJECT",
    revision: "skills-browser-fixture",
  };
});
runner.post("/projects/:id/close", async () => ({ ok: true }));
const runnerUrl = await runner.listen({ host: "127.0.0.1", port: 0 });
const { app, store } = await buildApp({
  dataRoot: output,
  password: "skills-browser-fixture-password",
  internalToken: "skills-browser-fixture-internal",
  runnerUrl,
  webRoot: path.join(process.cwd(), "dist/web"),
});
const base = await app.listen({ host: "127.0.0.1", port: 0 });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Page | undefined;
let cookie = "";
async function api(
  route: string,
  body?: unknown,
  method?: string,
): Promise<any> {
  const r = await fetch(base + "/api" + route, {
    method: method || (body ? "POST" : "GET"),
    headers: {
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (route === "/auth/login")
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  const data = await r.json();
  assert(r.ok, route + ": " + JSON.stringify(data));
  return data;
}

try {
  await api("/auth/login", { password: "skills-browser-fixture-password" });
  const projectA = await api("/projects", { name: "室内创作 · 技能验收" });
  const projectB = await api("/projects", { name: "角色研究 · 独立技能" });
  const session = await api(`/projects/${projectA.id}/sessions`, {});
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--single-process", "--no-zygote"],
    ...(process.env.PILOT_BROWSER_BIN
      ? { executablePath: process.env.PILOT_BROWSER_BIN }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
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
    { pid: projectA.id, sid: session.id },
  );
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const capture = async (name: string) => {
    await page!.screenshot({ path: path.join(output, name) });
    screenshots.push(name);
  };
  const closeToast = async () => {
    const buttons = page!.locator(".toast button");
    if (await buttons.count()) await buttons.first().click();
  };
  const nav = async () => {
    await page!.getByRole("button", { name: "技能中心", exact: true }).click();
    await page!.getByTestId("skills-page").waitFor();
  };
  await page.goto(base);
  await page
    .getByPlaceholder("部署时设置的 PILOT_PASSWORD")
    .fill("skills-browser-fixture-password");
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await page.locator(".composer textarea").waitFor();
  await wait(
    async () => !(await page!.locator(".composer textarea").isDisabled()),
    "project opens",
  );
  await nav();
  await page.getByText("让好用的创作方法，成为技能").waitFor();
  const cdp = await context.newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const domDocument = await cdp.send("DOM.getDocument");
  const heading = await cdp.send("DOM.querySelector", {
    nodeId: domDocument.root.nodeId,
    selector: ".skills-page h1",
  });
  const actualFonts = await cdp.send("CSS.getPlatformFontsForNode", {
    nodeId: heading.nodeId,
  });
  assert(
    actualFonts.fonts.some(
      (font: { familyName: string; glyphCount: number }) =>
        /Noto.*(?:CJK|Sans SC)/.test(font.familyName) && font.glyphCount > 0,
    ),
    "Chinese heading must use actual installed CJK font, not fallback tofu",
  );
  await cdp.detach();
  await capture("01-skills-empty-dark.png");
  pass("首次空技能库展示上传与 npx 入口，不虚构预装技能");

  await page.getByRole("button", { name: "上传技能", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("技能文件").setInputFiles({
    name: "SKILL.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Missing front matter"),
  });
  await dialog.getByRole("button", { name: "上传并安装" }).click();
  await dialog.getByRole("alert").waitFor();
  assert.match(
    await dialog.innerText(),
    /name|description|frontmatter|头部|名称|YAML|格式/i,
  );
  assert.equal((await api("/skills")).items.length, 0);
  pass("错误 SKILL.md 经真实后端拒绝，错误留在窗口且目录未出现假成功");
  await dialog.getByLabel("技能文件").setInputFiles({
    name: "SKILL.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(skill("studio-lighting", "产品灯光与多角度检查")),
  });
  await capture("02-skills-upload-dark.png");
  await dialog.getByRole("button", { name: "上传并安装" }).click();
  await page.getByTestId("skill-instructions").waitFor();
  await page
    .getByRole("heading", { name: "studio-lighting", exact: true })
    .waitFor();
  let installed = (await api("/skills")).items;
  const lighting = installed.find((x: any) => x.name === "studio-lighting");
  assert(lighting?.enabled);
  assert.match(
    await page.getByTestId("skill-instructions").innerText(),
    /多角度/,
  );
  pass(
    "SKILL.md 上传真实落盘并进入 PostgreSQL 目录，详情说明、内容版本和资源列表可见",
  );

  await page.getByTestId("skill-project-toggle").click();
  await wait(
    async () =>
      (await page!
        .getByTestId("skill-project-toggle")
        .getAttribute("aria-pressed")) === "true",
    "project selects skill",
  );
  assert.deepEqual((await api(`/projects/${projectA.id}/skills`)).skillIds, [
    lighting.id,
  ]);
  await page.reload();
  await page.locator(".composer textarea").waitFor();
  await nav();
  await wait(
    async () =>
      (await page!
        .getByTestId("skill-project-toggle")
        .getAttribute("aria-pressed")) === "true",
    "selection persisted",
  );
  pass("项目选择持久化，刷新页面后恢复；安装和选用是两个明确步骤");

  await page.getByRole("button", { name: "上传技能", exact: true }).click();
  await dialog.getByLabel("技能文件").setInputFiles({
    name: "SKILL.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(skill("studio-lighting", "冲突版本")),
  });
  await dialog.getByRole("button", { name: "上传并安装" }).click();
  await dialog.getByRole("alert").waitFor();
  assert.equal((await api("/skills")).items.length, 1);
  assert.equal(
    (await api(`/skills/${lighting.id}`)).skill.sha256,
    lighting.sha256,
  );
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  pass("同名技能冲突不会覆盖已安装内容或项目选择");

  await page.getByRole("button", { name: "上传技能", exact: true }).click();
  await dialog.getByLabel("技能文件").setInputFiles({
    name: "modular-room.zip",
    mimeType: "application/zip",
    buffer: zip({
      "modular-room/SKILL.md": skill(
        "modular-room",
        "模块化场景布局与素材组合",
      ),
      "modular-room/references/dimensions.md":
        "# 尺寸规范\n1 Blender unit = 1 meter.\n",
      "modular-room/assets/palette.json": '{"wall":"warm white"}',
    }),
  });
  await dialog.getByRole("button", { name: "上传并安装" }).click();
  await page
    .getByRole("heading", { name: "modular-room", exact: true })
    .waitFor();
  await page.getByTestId("skill-instructions").waitFor();
  await page.locator(".skill-files summary").click();
  await page.getByText("references/dimensions.md", { exact: true }).waitFor();
  installed = (await api("/skills")).items;
  const room = installed.find((x: any) => x.name === "modular-room");
  assert.equal(room.fileCount, 3);
  pass("ZIP 技能包连同参考资料和素材一起安装，详情可展开相对文件清单");

  let releaseOld: () => void = () => {};
  let oldStarted = false;
  const gate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  await page.route(`**/api/projects/${projectA.id}/skills`, async (route) => {
    if (route.request().method() === "GET") {
      oldStarted = true;
      await gate;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "刷新技能库", exact: true }).click();
  await wait(async () => oldStarted, "old project request held");
  await page.getByLabel("当前项目", { exact: true }).selectOption(projectB.id);
  await wait(
    async () =>
      (await page!.getByTestId("skills-project-context").innerText()).includes(
        "角色研究",
      ) &&
      (await page!.getByTestId("skills-project-context").innerText()).includes(
        "已选择 0",
      ),
    "new project zero selected",
  );
  releaseOld();
  await delay(200);
  await page.unroute(`**/api/projects/${projectA.id}/skills`);
  assert.match(
    await page.getByTestId("skills-project-context").innerText(),
    /已选择 0/,
  );
  await page.getByLabel("当前项目", { exact: true }).selectOption(projectA.id);
  await wait(
    async () =>
      (await page!.getByTestId("skills-project-context").innerText()).includes(
        "已选择 1",
      ),
    "A selection recovered",
  );
  pass("切换项目时迟到的技能响应不能污染新项目，两个项目选择互不串联");

  await page
    .getByTestId("skill-card")
    .filter({ hasText: "studio-lighting" })
    .click();
  await page.getByRole("switch", { name: "启用 studio-lighting" }).click();
  await wait(
    async () =>
      (await page!
        .getByRole("switch", { name: "启用 studio-lighting" })
        .getAttribute("aria-checked")) === "false",
    "skill disabled",
  );
  assert.deepEqual((await api(`/projects/${projectA.id}/skills`)).skillIds, []);
  assert(await page.getByTestId("skill-project-toggle").isDisabled());
  await page.getByRole("switch", { name: "启用 studio-lighting" }).click();
  await wait(
    async () =>
      (await page!
        .getByRole("switch", { name: "启用 studio-lighting" })
        .getAttribute("aria-checked")) === "true",
    "skill reenabled",
  );
  await wait(
    async () => !(await page!.getByTestId("skill-project-toggle").isDisabled()),
    "project setting loaded",
  );
  await page.getByTestId("skill-project-toggle").click();
  await wait(
    async () =>
      (await page!
        .getByTestId("skill-project-toggle")
        .getAttribute("aria-pressed")) === "true",
    "reselect enabled skill",
  );
  pass("停用立即清除项目选择，重新启用后需要明确重新选用");

  let installerCalls = 0;
  await page.route("**/api/skills/install", async (route) => {
    installerCalls++;
    const request = route.request().postDataJSON();
    assert.equal(request.source, "fixture/blender-skills");
    assert.deepEqual(request.skillNames, ["material-workflow"]);
    if (installerCalls === 1)
      return route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({
          error: "明确安装器夹具：仓库下载失败，请检查来源",
        }),
      });
    await delay(250);
    const result = await api("/skills/upload", {
      name: "SKILL.md",
      dataBase64: Buffer.from(
        skill("material-workflow", "材质层次与可复用表面处理"),
      ).toString("base64"),
    });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(result),
    });
  });
  await page.getByRole("button", { name: "npx 安装", exact: true }).click();
  await dialog
    .getByLabel("GitHub 仓库", { exact: true })
    .fill("npx arbitrary-package && echo nope");
  await dialog.getByRole("button", { name: "安装技能", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(installerCalls, 0);
  await dialog
    .getByLabel("GitHub 仓库", { exact: true })
    .fill("fixture/blender-skills");
  await dialog
    .getByLabel("技能名称", { exact: false })
    .fill("material-workflow");
  await dialog.getByRole("button", { name: "安装技能", exact: true }).click();
  await wait(
    async () =>
      (await dialog.getByRole("alert").innerText()).includes("明确安装器夹具"),
    "npx failure visible",
  );
  assert.equal(installerCalls, 1);
  assert(
    !(await api("/skills")).items.some(
      (x: any) => x.name === "material-workflow",
    ),
  );
  await dialog.getByRole("button", { name: "安装技能", exact: true }).click();
  await dialog.getByRole("status").waitFor();
  assert(await dialog.getByRole("button", { name: "处理中…" }).isDisabled());
  await page
    .getByRole("heading", { name: "material-workflow", exact: true })
    .waitFor();
  await page.unroute("**/api/skills/install");
  pass(
    "npx UI 只接受仓库参数；下载失败和重试显示正确，等待期间禁重复提交（安装器为明确夹具）",
  );

  await page.getByLabel("搜索技能").fill("不存在的技能");
  await page.getByText("没有匹配的技能", { exact: true }).waitFor();
  await page.getByLabel("搜索技能").fill("");
  await page.getByRole("tab", { name: /项目已选/ }).click();
  assert.equal(await page.getByTestId("skill-card").count(), 1);
  await page.getByRole("tab", { name: /全部技能/ }).click();
  pass("技能搜索和项目已选筛选保持目录与项目归属一致");

  await page.route("**/api/skills", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "明确夹具：目录暂时不可用" }),
        })
      : route.continue(),
  );
  await page.getByRole("button", { name: "刷新技能库", exact: true }).click();
  await wait(
    async () =>
      (await page!.getByTestId("skills-page").innerText()).includes(
        "已有列表可能已过期",
      ),
    "stale catalog shown",
  );
  assert.equal(await page.getByTestId("skill-card").count(), 3);
  assert(
    await page
      .getByRole("switch", { name: "启用 material-workflow" })
      .isDisabled(),
  );
  await page.unroute("**/api/skills");
  await page.getByRole("button", { name: "刷新技能库", exact: true }).click();
  await wait(
    async () =>
      !(await page!
        .getByRole("button", { name: "刷新技能库", exact: true })
        .isDisabled()),
    "catalog recovery",
  );
  assert.doesNotMatch(
    await page.getByTestId("skills-page").innerText(),
    /已有列表可能已过期/,
  );
  pass("目录故障保留可见内容并标记过期，禁止依赖过期状态的操作，恢复后重读");

  let releaseStalled: () => void = () => {};
  const stalled = new Promise<void>((resolve) => {
    releaseStalled = resolve;
  });
  await page.route("**/api/skills", async (route) => {
    await stalled;
    await route.abort().catch(() => {});
  });
  await page.getByRole("button", { name: "刷新技能库", exact: true }).click();
  await wait(
    async () =>
      (await page!.getByTestId("skills-page").innerText()).includes("请求超时"),
    "stalled catalog bounded timeout",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "刷新技能库", exact: true })
      .isDisabled(),
    false,
  );
  releaseStalled();
  await page.unroute("**/api/skills");
  await page.getByRole("button", { name: "刷新技能库", exact: true }).click();
  await wait(
    async () =>
      !(await page!
        .getByRole("button", { name: "刷新技能库", exact: true })
        .isDisabled()),
    "retry after timeout",
  );
  assert.doesNotMatch(
    await page.getByTestId("skills-page").innerText(),
    /请求超时/,
  );
  pass(
    "请求无响应时 15 秒内结束等待并显示超时，重试恢复后不会一直停留在加载状态",
  );

  await page
    .getByRole("button", { name: "卸载 material-workflow", exact: true })
    .click();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal((await api("/skills")).items.length, 3);
  const materialSkill = (await api("/skills")).items.find(
    (item: any) => item.name === "material-workflow",
  );
  await page.route(`**/api/skills/${materialSkill.id}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    const deleted = await api(
      `/skills/${materialSkill.id}`,
      undefined,
      "DELETE",
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...deleted,
        warning:
          "明确清理回执夹具：技能已卸载，但旧文件清理失败，请检查本地磁盘权限",
      }),
    });
  });
  await page
    .getByRole("button", { name: "卸载 material-workflow", exact: true })
    .click();
  await dialog.getByRole("button", { name: "确认卸载", exact: true }).click();
  await wait(
    async () => (await page!.getByTestId("skill-card").count()) === 2,
    "uninstalled card removed",
  );
  assert.equal((await api("/skills")).items.length, 2);
  assert.match(await page.locator(".toast").innerText(), /旧文件清理失败/);
  await page.unroute(`**/api/skills/${materialSkill.id}`);
  pass(
    "卸载需要明确确认，取消保留技能，完成后目录同步；清理失败警告回执不会被成功提示覆盖",
  );

  await page
    .getByTestId("skill-card")
    .filter({ hasText: "modular-room" })
    .click();
  await page.getByTestId("skill-instructions").waitFor();
  await closeToast();
  if (await page.getByRole("button", { name: "关闭安装提示" }).count())
    await page.getByRole("button", { name: "关闭安装提示" }).click();
  for (const theme of ["dark", "light"]) {
    const current: string = await page.evaluate(
      () => document.documentElement.dataset.theme || "dark",
    );
    if (current !== theme)
      await page.getByRole("button", { name: "切换主题", exact: true }).click();
    for (const width of [1440, 1280, 1024]) {
      await page.setViewportSize({ width, height: 960 });
      await capture(`skills-${theme}-${width}.png`);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1,
        ),
        false,
        `${theme} ${width} document overflow`,
      );
      for (const selector of [
        ".skills-toolbar",
        ".skill-detail",
        ".skills-project-context",
      ]) {
        const box = await page.locator(selector).boundingBox();
        assert(
          box && box.x >= 0 && box.x + box.width <= width + 1,
          selector + " outsideviewport",
        );
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "npx 安装", exact: true }).click();
  await capture("skills-install-light.png");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  pass(
    "VoiceStudio 共用配色下深浅主题和 1440/1280/1024 桌面布局均无横向溢出，安装窗口入口可达",
  );

  // Drive the new work result card with the actual persisted event contract.
  // These marked image/scene files are UI fixtures, not generated Blender work.
  const runId = randomUUID(),
    createdAt = new Date().toISOString();
  const run: Run = {
    id: runId,
    projectId: projectA.id,
    sessionId: session.id,
    prompt: "界面协议验收：组合展示场景，检查阶段、结果和恢复入口。",
    assetIds: [],
    status: "running",
    verification: "pending",
    qualityMode: "multi-view",
    createdAt,
    updatedAt: createdAt,
    skillRefs: [
      { id: lighting.id, name: lighting.name, sha256: lighting.sha256 },
    ],
  };
  const job: WorkflowJob = { run, events: [] };
  workflowJobs.set(runId, job);
  await store.put("run", runId, run);
  const emit = async (type: string, payload: Record<string, unknown>) => {
    const event: PilotEvent = {
      schemaVersion: 1,
      runId,
      projectId: projectA.id,
      sessionId: session.id,
      seq: job.events.length + 1,
      type,
      payload,
      time: new Date().toISOString(),
    };
    job.events.push(event);
    await store.event(event);
  };
  await emit("run.status", { status: "running" });
  await emit("work.phase", { phase: "preparing" });
  await page.reload();
  await page.locator(".composer textarea").waitFor();
  const turn = page.locator(`[data-run-id="${runId}"]`);
  await turn.waitFor();
  for (const [phase, label] of [
    ["preparing", "准备场景与恢复点"],
    ["waiting_model", "等待模型响应"],
    ["modeling", "正在操作 Blender"],
    ["inspecting", "检查结构与多角度画面"],
    ["saving", "保存场景与结果"],
  ]) {
    if (phase !== "preparing") await emit("work.phase", { phase });
    await wait(
      async () =>
        (await turn.locator(".chat-working").innerText()).includes(label),
      "work phase " + phase,
    );
  }
  await turn
    .getByLabel("本轮技能")
    .getByText("技能 · studio-lighting")
    .waitFor();
  pass(
    "对话通过实际事件协议显示准备、等待模型、Blender 操作、检查、保存五个阶段及本轮技能版本",
  );
  const plan = {
    title: "展示场景 · 明确协议夹具",
    steps: [
      {
        id: "layout",
        step: "摆放可复用组件",
        status: "completed",
        objectNames: ["Display_Stand"],
        note: "",
      },
      {
        id: "light",
        step: "调整柔光与材质",
        status: "blocked",
        objectNames: ["Key_Light"],
        note: "等待用户确认光线方向",
      },
    ],
  };
  await emit("plan.updated", {
    itemId: "work-plan",
    explanation: plan.title,
    steps: plan.steps,
  });
  const captures: Capture[] = [];
  for (const [index, phase] of [
    "before",
    "final:front",
    "final:right",
    "final:top",
  ].entries()) {
    const id = randomUUID(),
      file = path.join(
        output,
        "projects",
        projectA.id,
        "captures",
        id + ".png",
      );
    await mkdir(path.dirname(file), { recursive: true });
    await sharp(
      Buffer.from(
        `<svg width="640" height="400"><rect width="640" height="400" fill="${index ? "#403049" : "#302637"}"/><rect x="90" y="105" width="460" height="190" rx="15" fill="#281f2c" stroke="#f09bb8" stroke-width="2"/><text x="320" y="180" fill="#f1eaf4" text-anchor="middle" font-size="23" font-family="sans-serif">UI protocol fixture</text><text x="320" y="225" fill="#c6b8ce" text-anchor="middle" font-size="18" font-family="sans-serif">${phase} - no Blender inference</text></svg>`,
      ),
    )
      .png()
      .toFile(file);
    const capture: Capture = {
      id,
      projectId: projectA.id,
      runId,
      path: file,
      mime: "image/png",
      sceneRevision: "workflow-fixture",
      generation: 1,
      mode: "fixture",
      phase,
      createdAt,
    };
    captures.push(capture);
    await store.put("capture", id, capture);
  }
  const snapshotId = randomUUID(),
    snapshotPath = path.join(
      output,
      "projects",
      projectA.id,
      "snapshots",
      snapshotId + ".blend",
    );
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(
    snapshotPath,
    "Explicit UI snapshot fixture, not a Blender file",
  );
  const snapshot: Snapshot = {
    id: snapshotId,
    projectId: projectA.id,
    runId,
    path: snapshotPath,
    name: "操作前 · 协议夹具",
    createdAt,
  };
  await store.put("snapshot", snapshotId, snapshot);
  await emit("message.completed", {
    itemId: "workflow-result",
    phase: "final_answer",
    text: "**这是界面协议夹具，没有运行 Blender 或真实模型。** 场景组合阶段已完成，灯光仍需确认。",
  });
  await emit("work.summary", {
    verification: "failed",
    saved: true,
    savedFile: "scene.blend",
    beforeCapture: captures[0],
    afterCaptures: captures.slice(1),
    beforeSnapshot: snapshot,
    changes: {
      created: ["Display_Stand"],
      modified: [{ name: "Key_Light" }],
      deleted: ["Draft_Cube"],
    },
    inspection: {
      summary: { errorCount: 0, warningCount: 1 },
      issues: [
        {
          severity: "warning",
          objects: ["Display_Stand"],
          message: "可能悬空，请结合画面确认。",
          requiresVisualReview: true,
        },
      ],
      limits: { objectsTruncated: false },
    },
    remainingSteps: plan.steps.filter((step) => step.status !== "completed"),
  });
  run.status = "failed";
  run.verification = "failed";
  run.updatedAt = new Date().toISOString();
  await store.put("run", runId, run);
  await emit("run.status", { status: "failed", verification: "failed" });
  const summary = turn.getByTestId("work-summary");
  await summary.waitFor();
  for (const label of [
    "新增 1",
    "修改 1",
    "移除 1",
    "Display_Stand",
    "Key_Light",
    "Draft_Cube",
    "仍需检查",
    "已保存：scene.blend",
    "未完成阶段：调整柔光与材质",
  ])
    assert(
      (await summary.innerText()).includes(label),
      "summary must show " + label,
    );
  await summary.locator(".work-inspection summary").click();
  await summary.getByText("可能悬空，请结合画面确认。").waitFor();
  const summaryImages = summary.locator("img");
  assert.equal(await summaryImages.count(), 2);
  await summary
    .getByRole("img", { name: "结果检查 · 正面", exact: true })
    .waitFor();
  assert.doesNotMatch(await summary.innerText(), /操作后 · 多角度检查/);
  await wait(
    async () =>
      await summaryImages.evaluateAll((images) =>
        images.every((img) => (img as HTMLImageElement).naturalWidth === 640),
      ),
    "comparison real local images loaded",
  );
  const comparisonLayout = await summary
    .locator(".work-comparison button")
    .evaluateAll((buttons) =>
      buttons.map((button) => {
        const image = button.querySelector("img")!.getBoundingClientRect();
        const caption = button.querySelector("span")!.getBoundingClientRect();
        const frame = button.getBoundingClientRect();
        return {
          imageBottom: image.bottom,
          captionTop: caption.top,
          captionRight: caption.right,
          frameRight: frame.right,
        };
      }),
    );
  for (const layout of comparisonLayout) {
    assert(
      layout.imageBottom <= layout.captionTop + 1,
      "comparison caption must sit below image",
    );
    assert(
      layout.captionRight <= layout.frameRight + 1,
      "comparison caption cannot be clipped",
    );
  }
  await summary
    .getByRole("button", { name: /操作前/ })
    .first()
    .click();
  await page.locator(".lightbox-image").waitFor();
  await page.keyboard.press("Escape");
  page.once("dialog", (dialog) => dialog.dismiss());
  await summary
    .getByRole("button", { name: "恢复到操作前", exact: true })
    .click();
  assert.equal(restores, 0);
  page.once("dialog", (dialog) => dialog.accept());
  await summary
    .getByRole("button", { name: "恢复到操作前", exact: true })
    .click();
  await wait(
    async () => restores === 1,
    "restore dispatched once after explicit confirm",
  );
  await wait(
    async () => (await page!.locator(".toast").innerText()).includes("已恢复"),
    "restore success UI receipt",
  );
  await closeToast();
  pass(
    "结果卡显示真实 receipt 字段、前后本地图片、待确认问题、保存位置和未完成阶段；恢复取消不执行，确认只提交一次（场景为夹具）",
  );

  const cancelledSummaryIds: string[] = [];
  for (const hasLaterCapture of [false, true]) {
    const id = randomUUID(),
      time = new Date().toISOString();
    const cancelled: Run = {
      id,
      projectId: projectA.id,
      sessionId: session.id,
      prompt: hasLaterCapture
        ? "协议夹具：取消任务保留一张普通结果截图。"
        : "协议夹具：在开始操作前取消任务，只有操作前截图。",
      assetIds: [],
      status: "cancelled",
      verification: "unavailable",
      createdAt: time,
      updatedAt: time,
    };
    const beforeOnly: Capture = { ...captures[0], id: randomUUID(), runId: id };
    const laterCapture: Capture = {
      ...captures[1],
      id: randomUUID(),
      runId: id,
      phase: "after-operation",
    };
    await store.put("run", id, cancelled);
    await store.put("capture", beforeOnly.id, beforeOnly);
    if (hasLaterCapture)
      await store.put("capture", laterCapture.id, laterCapture);
    await store.event({
      schemaVersion: 1,
      runId: id,
      projectId: projectA.id,
      sessionId: session.id,
      seq: 1,
      type: "work.summary",
      time,
      payload: {
        verification: "unavailable",
        saved: false,
        beforeCapture: beforeOnly,
        // Retain the old backend's erroneous fallback in this UI regression:
        // filtering must work even when a stored historical event repeats it.
        afterCaptures: hasLaterCapture
          ? [laterCapture]
          : [beforeOnly, { ...beforeOnly, phase: "final:front" }],
        changes: { created: [], modified: [], deleted: [] },
      },
    });
    await store.event({
      schemaVersion: 1,
      runId: id,
      projectId: projectA.id,
      sessionId: session.id,
      seq: 2,
      type: "run.status",
      payload: { status: "cancelled", verification: "unavailable" },
      time,
    });
    cancelledSummaryIds.push(id);
  }
  await page.reload();
  await page.locator(".composer textarea").waitFor();
  const cancelledSummary = page
    .locator(`[data-run-id="${cancelledSummaryIds[0]}"]`)
    .getByTestId("work-summary");
  await cancelledSummary.waitFor();
  assert.equal(await cancelledSummary.locator(".work-comparison").count(), 0);
  assert.equal(await cancelledSummary.locator("img").count(), 0);
  assert.match(await cancelledSummary.innerText(), /未取得操作后截图/);
  assert.doesNotMatch(
    await cancelledSummary.innerText(),
    /多角度检查|最新画面|检查通过/,
  );
  const partialSummary = page
    .locator(`[data-run-id="${cancelledSummaryIds[1]}"]`)
    .getByTestId("work-summary");
  await partialSummary
    .getByRole("img", { name: "最新画面", exact: true })
    .waitFor();
  assert.equal(await partialSummary.locator("img").count(), 2);
  assert.doesNotMatch(await partialSummary.innerText(), /多角度检查|检查通过/);
  pass(
    "取消前只有操作前截图时不伪造前后对比；普通单张截图只标为最新画面，视角标签由实际 phase 决定",
  );
  await summary.waitFor();
  await summary.locator(".work-inspection summary").click();
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await summary.scrollIntoViewIfNeeded();
  await capture("workflow-summary-dark.png");
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await capture("workflow-summary-light.png");
  assert.deepEqual(errors, []);
  pass("技能管理全部场景无未捕获的浏览器异常");

  const result = {
    passed: true,
    time: new Date().toISOString(),
    scope: "skills-and-workflow-ui-real-api-persistence",
    environment: {
      api: "real Fastify",
      database:
        process.env.PILOT_TEST_POSTGRES_MODE === "wasm-wire"
          ? "explicit PostgreSQL WASM over TCP/pg; not native PostgreSQL"
          : "PostgreSQL server",
      runner: "explicit local scene fixture; no Blender or inference",
      installer:
        "explicit browser protocol fixture; real upload/catalog/files, no public npx execution",
      browser: "Chromium/Playwright",
    },
    checks,
    screenshots,
    uncaughtBrowserErrors: errors,
    actualChineseHeadingFonts: actualFonts.fonts,
  };
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  await page
    ?.screenshot({ path: path.join(output, "failure.png") })
    .catch(() => {});
  throw e;
} finally {
  await browser?.close();
  await app.close();
  await runner.close();
}
