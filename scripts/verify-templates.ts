/** Template UX acceptance: real Fastify API + PostgreSQL TCP/pg driver.
 * The Runner below is an explicit protocol fixture. No Blender or inference
 * runs in this suite; templates only prepare a draft until the user sends it.
 * Run after build through scripts/with-postgres.ts.
 */
import assert from "node:assert/strict";
import Fastify from "fastify";
import { chromium, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp } from "../apps/server/app.js";
import { LibraryCatalog } from "../packages/storage/library-catalog.js";
import type { LibraryAsset } from "../packages/blender-bridge/library.js";
import type {
  CreationTemplate,
  TemplateInput,
} from "../packages/contracts/templates.js";
import type {
  PilotEvent,
  Snapshot,
  StartJob,
} from "../packages/contracts/index.js";

const root = process.cwd();
const output = path.resolve(
  process.env.PILOT_TEMPLATE_TEST_DATA || ".data/template-acceptance",
);
await mkdir(output, { recursive: true });
const checks: string[] = [];
const pass = (check: string) => {
  checks.push(check);
  console.log("PASS " + check);
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(
  fn: () => Promise<unknown>,
  label: string,
  timeout = 15000,
) {
  const until = Date.now() + timeout;
  let error: unknown;
  while (Date.now() < until) {
    try {
      if (await fn()) return;
    } catch (e) {
      error = e;
    }
    await delay(80);
  }
  throw new Error("Timed out: " + label + ": " + String(error || ""));
}
let submissions = 0;
let restores = 0;
type FixtureJob = {
  input: StartJob;
  status: string;
  events: PilotEvent[];
  seq: number;
  verification: string;
  updatedAt: string;
};
const jobs = new Map<string, FixtureJob>();
function emit(job: FixtureJob, type: string, payload: Record<string, unknown>) {
  job.updatedAt = new Date().toISOString();
  job.events.push({
    schemaVersion: 1,
    runId: job.input.runId,
    projectId: job.input.projectId,
    sessionId: job.input.sessionId,
    seq: ++job.seq,
    type,
    payload,
    time: job.updatedAt,
  });
}
async function snapshot(
  projectId: string,
  name: string,
  runId?: string,
): Promise<Snapshot> {
  const id = randomUUID();
  const file = path.join(
    output,
    "projects",
    projectId,
    "snapshots",
    id + ".blend",
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "snapshot protocol fixture; not a Blender file");
  return {
    id,
    projectId,
    name,
    path: file,
    createdAt: new Date().toISOString(),
    runId,
  };
}
const runner = Fastify();
runner.get("/health", async () => ({
  ok: true,
  maxStudios: 3,
  studios: [],
  activeRuns: [...jobs.values()]
    .filter((job) => job.status === "running")
    .map((job) => ({
      id: job.input.runId,
      projectId: job.input.projectId,
      sessionId: job.input.sessionId,
    })),
}));
runner.post("/scene", async (req) => {
  const body = req.body as any;
  if (body.action === "restore") {
    restores++;
    return snapshot(body.projectId, "恢复前备份 · Fixture");
  }
  return {
    ok: true,
    objects: [],
    selected: [],
    mode: "OBJECT",
    revision: "template-protocol-fixture",
    version: "protocol-fixture",
  };
});
runner.post("/jobs", async (req) => {
  const input = req.body as StartJob;
  if (jobs.has(input.runId)) return jobs.get(input.runId);
  submissions++;
  const job: FixtureJob = {
    input,
    status: "running",
    events: [],
    seq: 0,
    verification: "fixture",
    updatedAt: new Date().toISOString(),
  };
  jobs.set(input.runId, job);
  emit(job, "run.status", { status: "running" });
  emit(job, "snapshot.created", {
    snapshot: await snapshot(
      input.projectId,
      "AI 操作前 · Fixture",
      input.runId,
    ),
  });
  emit(job, "message.completed", {
    itemId: "fixture-intro",
    text: "这是恢复点与变化回执的协议验收，没有调用真实模型或 Blender。",
  });
  emit(job, "tool.started", {
    callId: "fixture-mutation",
    name: "execute_blender_code",
    args: { code: "# explicit protocol fixture only" },
  });
  emit(job, "scene.receipt", {
    callId: "fixture-mutation",
    receipt: { created: ["Fixture_Chair"], modified: [], deleted: [] },
  });
  return { id: input.runId, status: job.status, seq: job.seq };
});
runner.get("/jobs/:id", async (req, reply) => {
  const job = jobs.get((req.params as any).id);
  if (!job) return reply.code(404).send({ error: "Fixture job missing" });
  return {
    id: job.input.runId,
    status: job.status,
    seq: job.seq,
    verification: job.verification,
    updatedAt: job.updatedAt,
  };
});
runner.get("/jobs/:id/events", async (req) =>
  (jobs.get((req.params as any).id)?.events || []).filter(
    (event) => event.seq > Number((req.query as any).after || 0),
  ),
);
runner.post("/projects/:id/close", async () => ({ ok: true }));
const runnerUrl = await runner.listen({ host: "127.0.0.1", port: 0 });
const { app, store } = await buildApp({
  dataRoot: output,
  password: "template-acceptance-password",
  internalToken: "template-fixture-only-internal-token",
  runnerUrl,
  webRoot: path.join(root, "dist/web"),
});
const base = await app.listen({ host: "127.0.0.1", port: 0 });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let failurePage: Page | undefined;
let cookie = "";
async function response(route: string, body?: unknown, method?: string) {
  const result = await fetch(base + "/api" + route, {
    method: method || (body ? "POST" : "GET"),
    headers: { cookie, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (route === "/auth/login")
    cookie = result.headers.get("set-cookie")!.split(";")[0];
  return { status: result.status, value: (await result.json()) as any };
}
async function api(route: string, body?: unknown, method?: string) {
  const result = await response(route, body, method);
  assert(result.status < 400, route + ": " + JSON.stringify(result.value));
  return result.value;
}
async function openTemplates(page: Page) {
  await page.getByRole("button", { name: "模板中心", exact: true }).click();
  await page.getByRole("heading", { name: "模板中心", exact: true }).waitFor();
}
async function openRecipe(page: Page, name: string) {
  await openTemplates(page);
  await page.getByRole("tab", { name: "我的模板", exact: true }).click();
  await page
    .getByRole("button", { name: "打开模板：" + name, exact: true })
    .click();
  await page
    .locator(".template-detail")
    .getByRole("heading", { name, exact: true })
    .waitFor();
  await page.getByRole("button", { name: "使用模板", exact: true }).waitFor();
}
async function openSession(page: Page, title: string) {
  await page.getByTitle("对话历史", { exact: true }).click();
  await page
    .locator(".session-list button")
    .filter({ hasText: title })
    .first()
    .click();
}
try {
  const unauthorized = await response("/templates");
  assert.equal(unauthorized.status, 401);
  await api("/auth/login", { password: "template-acceptance-password" });
  await api(
    "/settings",
    {
      baseUrl: "https://fixture.invalid",
      model: "explicit-protocol-fixture",
      apiKey: "fixture-only-not-a-real-key",
      effort: "low",
    },
    "PUT",
  );
  const project = await api("/projects", {
    name: "模板交互验收 · API/SQL Fixture",
  });
  const sessionA = await api(`/projects/${project.id}/sessions`, {});
  const sessionB = await api(`/projects/${project.id}/sessions`, {});
  await store.put("session", sessionA.id, { ...sessionA, title: "素材组合 A" });
  await store.put("session", sessionB.id, { ...sessionB, title: "独立创作 B" });
  const catalog = new LibraryCatalog(store.db);
  async function asset(name: string): Promise<LibraryAsset> {
    const id = randomUUID();
    const dir = path.join(output, "library", id);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "asset.blend");
    await writeFile(file, "explicit template fixture; not a Blender file");
    return catalog.create({
      id,
      name,
      category: "prop",
      description: "模板引用协议验收素材，不代表真实 Blender 模型",
      path: file,
      mime: "application/x-blender",
      size: 52,
      sha256: "fixture",
      createdAt: new Date().toISOString(),
      source: "upload",
      objectNames: [],
      tags: ["协议验收"],
      favorite: false,
      sourceUrl: "",
      license: "Test fixture",
      author: "Blender Pilot acceptance",
    });
  }
  const chair = await asset("测试椅 · Fixture");
  const table = await asset("测试茶几 · Fixture");
  const input: TemplateInput = {
    name: "办公室素材组合",
    description: "复用椅子与茶几，增加可编辑的新部件。",
    category: "composition",
    prompt:
      "使用引用素材组合一个 {{goal}}，保留原素材，新增内容放入单独 Collection。",
    variables: [{ key: "goal", label: "创作目标", defaultValue: "安静休息区" }],
    libraryAssetIds: [chair.id, table.id],
  };
  const recipe: CreationTemplate = await api("/templates", input);
  const builtins = await api("/templates?source=builtin");
  assert(builtins.items.length >= 9);
  assert(
    builtins.items.every((item: CreationTemplate) => item.source === "builtin"),
  );
  assert.equal(
    (
      await response(
        "/templates/builtin:prop",
        { ...input, expectedVersion: 1 },
        "PATCH",
      )
    ).status,
    403,
  );
  pass(
    "模板 API 需要登录；九种内置配方（含尺寸化书桌、置物架、办公室）可读取且禁止覆盖",
  );

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
    ({ pid, sid, ref }) => {
      if (!localStorage.getItem("pilot-project")) {
        localStorage.setItem("pilot-project", pid);
        localStorage.setItem("pilot-chat-active:" + pid, sid);
        localStorage.setItem("pilot-theme", "dark");
        localStorage.setItem(
          "pilot-chat-draft:" + sid,
          JSON.stringify({
            text: "请保留这段已有草稿。",
            attachments: [{ id: ref.id, name: ref.name, kind: "library" }],
            uploads: [],
            revision: 0,
          }),
        );
      }
    },
    { pid: project.id, sid: sessionA.id, ref: chair },
  );
  const page = await context.newPage();
  failurePage = page;
  page.setDefaultTimeout(15000);
  const uncaught: string[] = [];
  page.on("pageerror", (error) => uncaught.push(String(error)));
  await page.goto(base);
  await page
    .getByPlaceholder("部署时设置的 PILOT_PASSWORD")
    .fill("template-acceptance-password");
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  const composer = page.locator(".composer textarea");
  await composer.waitFor();
  await wait(async () => !(await composer.isDisabled()), "project activation");
  assert.equal(await composer.inputValue(), "请保留这段已有草稿。");
  await openTemplates(page);
  await page.getByRole("tab", { name: "内置模板", exact: true }).click();
  await page
    .getByRole("button", { name: "打开模板：可复用道具", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "打开模板：尺寸化书桌", exact: true })
    .click();
  const deskWidth = page.getByRole("spinbutton", {
    name: "书桌宽度",
    exact: true,
  });
  await deskWidth.fill("1.53");
  assert.equal(await deskWidth.getAttribute("aria-invalid"), "true");
  assert(
    await page
      .getByRole("button", { name: "使用模板", exact: true })
      .isDisabled(),
  );
  await deskWidth.fill("1.55");
  assert.equal(await deskWidth.getAttribute("aria-invalid"), "false");
  assert(
    (await page.locator(".template-prompt").innerText()).includes(
      "外宽 1.55 米",
    ),
  );
  assert(
    !(await page
      .getByRole("button", { name: "使用模板", exact: true })
      .isDisabled()),
  );
  await page
    .getByRole("button", { name: "打开模板：层数可调置物架", exact: true })
    .click();
  const levels = page.getByRole("spinbutton", {
    name: "搁板层数",
    exact: true,
  });
  await levels.fill("2.5");
  assert(
    await page
      .getByRole("button", { name: "使用模板", exact: true })
      .isDisabled(),
  );
  await levels.fill("5");
  assert(
    (await page.locator(".template-prompt").innerText()).includes(
      "承载搁板共 5 层",
    ),
  );
  pass(
    "数值参数使用专用输入；宽度步长与整数层数校验即时阻止无效套用，合法值展开为米制任务说明",
  );
  await page
    .getByRole("button", { name: "打开模板：尺寸化书桌", exact: true })
    .click();
  assert.equal(await deskWidth.inputValue(), "1.55");
  await page
    .getByRole("button", { name: "另存为我的模板", exact: true })
    .click();
  const numberEditor = page.getByRole("dialog", {
    name: "新建模板",
    exact: true,
  });
  await numberEditor
    .getByLabel("模板名称", { exact: true })
    .fill("数值参数浏览器验收书桌");
  await numberEditor
    .getByLabel("参数类型 1", { exact: true })
    .selectOption("text");
  assert.equal(
    await numberEditor.getByLabel("最小值 1", { exact: true }).count(),
    0,
  );
  await numberEditor
    .getByLabel("参数类型 1", { exact: true })
    .selectOption("number");
  await numberEditor.getByLabel("参数单位 1", { exact: true }).fill("米");
  await numberEditor.getByLabel("最小值 1", { exact: true }).fill("0.6");
  await numberEditor.getByLabel("最大值 1", { exact: true }).fill("2");
  await numberEditor.getByLabel("步长 1", { exact: true }).fill("0.1");
  await numberEditor.getByLabel("默认值 1", { exact: true }).fill("1.6");
  await page.screenshot({
    path: path.join(output, "templates-numeric-editor.png"),
  });
  await numberEditor
    .getByRole("button", { name: "保存模板", exact: true })
    .click();
  await wait(async () => !(await numberEditor.count()), "numeric recipe saved");
  const numericSaved = (
    await api(
      "/templates?source=custom&search=" +
        encodeURIComponent("数值参数浏览器验收书桌"),
    )
  ).items[0] as CreationTemplate;
  assert.deepEqual(numericSaved.variables[0], {
    key: "width",
    label: "书桌宽度",
    defaultValue: "1.6",
    type: "number",
    unit: "米",
    min: 0.6,
    max: 2,
    step: 0.1,
  });
  await page.reload();
  await openRecipe(page, numericSaved.name);
  assert.equal(await deskWidth.inputValue(), "1.6");
  await deskWidth.fill("2.1");
  assert(
    await page
      .getByRole("button", { name: "使用模板", exact: true })
      .isDisabled(),
  );
  await deskWidth.fill("1.7");
  assert(
    (await page.locator(".template-prompt").innerText()).includes(
      "外宽 1.7 米",
    ),
  );
  pass(
    "浏览器可编辑参数类型、单位和范围；保存与刷新后从 PostgreSQL 恢复约束，仍拒绝越界值",
  );
  await page.screenshot({
    path: path.join(output, "templates-numeric-dark.png"),
  });
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await page.screenshot({
    path: path.join(output, "templates-numeric-light-1024.png"),
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.getByRole("button", { name: "编辑模板", exact: true }).click();
  const numericEdit = page.getByRole("dialog", {
    name: "编辑模板",
    exact: true,
  });
  await numericEdit
    .getByLabel("参数单位 1", { exact: true })
    .scrollIntoViewIfNeeded();
  const editorBounds = await numericEdit.evaluate((el) => ({
    width: el.clientWidth,
    content: el.scrollWidth,
  }));
  assert(
    editorBounds.content <= editorBounds.width + 1,
    "numeric editor must not overflow at 1024px",
  );
  await numericEdit
    .getByRole("button", { name: "暂存并关闭", exact: true })
    .click();
  assert.equal(submissions, 0);
  pass(
    "数值模板与参数编辑器在1024px无横向溢出，深浅主题截图均来自真实界面，未发送建模任务",
  );
  await api(
    `/templates/${numericSaved.id}`,
    { expectedVersion: numericSaved.version },
    "DELETE",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.getByRole("tab", { name: "内置模板", exact: true }).click();
  await page
    .getByRole("button", { name: "打开模板：可复用道具", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "搜索创作模板", exact: true })
    .fill("参考图");
  await page
    .getByRole("button", { name: "打开模板：参考图分解建模", exact: true })
    .waitFor();
  await wait(
    async () =>
      (await page
        .getByRole("button", { name: "打开模板：可复用道具", exact: true })
        .count()) === 0,
    "search filter",
  );
  await page
    .getByRole("textbox", { name: "搜索创作模板", exact: true })
    .fill("");
  await page
    .getByRole("button", { name: "打开模板：可复用道具", exact: true })
    .waitFor();
  await page
    .getByLabel("筛选模板分类", { exact: true })
    .selectOption("composition");
  await page
    .getByRole("button", { name: "打开模板：素材组合与再创作", exact: true })
    .waitFor();
  assert.equal(await page.locator(".template-card").count(), 1);
  await page.getByLabel("筛选模板分类", { exact: true }).selectOption("all");
  await page
    .getByRole("button", { name: "打开模板：可复用道具", exact: true })
    .click();
  await page.getByRole("button", { name: "选择素材", exact: true }).click();
  await page.getByLabel("搜索模板素材", { exact: true }).fill("测试茶几");
  const materialOption = page
    .locator(".template-asset-options label")
    .filter({ hasText: table.name });
  await materialOption.getByRole("checkbox").check();
  await page
    .locator(".template-ref-list")
    .getByText(table.name, { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "收起素材选择", exact: true }).click();
  pass("分类筛选与共享素材搜索选择可用，所选素材真实绑定到创作配方");
  pass("模板中心内置分类与搜索呈现真实 API 结果");
  const applyLayoutAudit = [];
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await page.locator(".main-content").evaluate((el) => {
      el.scrollTop = 0;
    });
    const layout = await page
      .getByRole("button", { name: "使用模板", exact: true })
      .evaluate((el) => {
        const bounds = el.getBoundingClientRect();
        const main = document
          .querySelector(".main-content")!
          .getBoundingClientRect();
        const atCenter = document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );
        return {
          width: innerWidth,
          height: innerHeight,
          button: {
            top: bounds.top,
            bottom: bounds.bottom,
            left: bounds.left,
            right: bounds.right,
          },
          main: { top: main.top, bottom: main.bottom },
          hit: !!atCenter && el.contains(atCenter),
        };
      });
    assert(
      layout.button.top >= layout.main.top &&
        layout.button.bottom <= layout.main.bottom + 1,
      "primary template action must be inside visible main viewport",
    );
    assert(
      layout.hit,
      "primary action must not be obscured by another element",
    );
    for (const field of ["道具", "风格", "尺寸"]) {
      const input = page.getByLabel(field, { exact: true });
      await input.scrollIntoViewIfNeeded();
      const hit = await input.evaluate((el) => {
        const bounds = el.getBoundingClientRect();
        const atCenter = document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );
        return !!atCenter && el.contains(atCenter);
      });
      assert(hit, field + " must remain scrollable above the sticky action");
    }
    await page.locator(".template-prompt").scrollIntoViewIfNeeded();
    assert(await page.locator(".template-prompt").isVisible());
    applyLayoutAudit.push(layout);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(".main-content").evaluate((el) => {
    el.scrollTop = 0;
  });
  pass("1440×1000 与1280×800 首屏主操作完整可见，参数与任务预览仍可滚动访问");
  await page.evaluate(() => document.fonts.ready);
  const cdp = await context.newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const dom = await cdp.send("DOM.getDocument");
  const fontNodes = [];
  for (const selector of [
    ".rail-brand>span",
    ".templates-page h1",
    ".template-card strong",
    ".template-prompt",
    ".eyebrow",
  ]) {
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: dom.root.nodeId,
      selector,
    });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    assert(
      fonts.length &&
        !fonts.some((font) => /times|serif/i.test(font.familyName)),
      "actual platform fonts must be sans for " + selector,
    );
    if (
      [
        ".templates-page h1",
        ".template-card strong",
        ".template-prompt",
      ].includes(selector)
    )
      assert(
        fonts.some(
          (font) =>
            font.glyphCount > 0 &&
            /Noto|CJK|YaHei|PingFang|Heiti|WenQuanYi|Droid Sans Fallback|Source Han Sans|JhengHei/i.test(
              font.familyName,
            ),
        ),
        "Chinese screenshot text needs an actual CJK sans font, not missing glyph boxes: " +
          selector +
          ": " +
          JSON.stringify(fonts),
      );
    fontNodes.push({
      selector,
      fonts,
      computed: await page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).font),
    });
  }
  await cdp.detach();
  const fontAudit = {
    method: "Chromium CDP CSS.getPlatformFontsForNode against screenshot DOM",
    env: {
      XDG_DATA_DIRS: process.env.XDG_DATA_DIRS,
      FONTCONFIG_FILE: process.env.FONTCONFIG_FILE,
      FONTCONFIG_PATH: process.env.FONTCONFIG_PATH,
    },
    nodes: fontNodes,
  };
  pass("截图DOM使用真实中文无衬线字库，标题与正文没有缺字方框或 serif 回退");
  await page.screenshot({ path: path.join(output, "templates-dark.png") });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await page.screenshot({ path: path.join(output, "templates-light.png") });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });

  await openRecipe(page, recipe.name);
  await page.getByLabel("创作目标", { exact: true }).fill("浅木色机器人休息区");
  await page.screenshot({ path: path.join(output, "templates-recipe.png") });
  await page.getByRole("button", { name: "使用模板", exact: true }).click();
  await composer.waitFor();
  assert((await composer.inputValue()).startsWith("请保留这段已有草稿。"));
  assert((await composer.inputValue()).includes("浅木色机器人休息区"));
  assert(!(await composer.inputValue()).includes("{{goal}}"));
  assert.equal(await page.locator(".chat-attachment").count(), 2);
  assert.equal(submissions, 0);
  pass("参数展开后追加原草稿；素材引用去重合并；使用模板不会自动发送任务");
  let combined = await composer.inputValue();
  await page.reload();
  await composer.waitFor();
  await wait(
    async () => (await composer.inputValue()) === combined,
    "draft persisted",
  );
  assert.equal(await page.locator(".chat-attachment").count(), 2);
  await openRecipe(page, recipe.name);
  pass("刷新后从 PostgreSQL 恢复自定义模板，聊天草稿与引用仍然保留");

  await page.getByRole("button", { name: "工作台", exact: true }).click();
  const longDraft = "x".repeat(15999);
  await composer.fill(longDraft);
  await openRecipe(page, recipe.name);
  await page.getByRole("button", { name: "使用模板", exact: true }).click();
  await page.locator(".template-use-footer [role='alert']").waitFor();
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  assert.equal(await composer.inputValue(), longDraft);
  assert.equal(await page.locator(".chat-attachment").count(), 2);
  await composer.fill(combined);
  pass("合并超过对话长度上限时明确拒绝，原草稿与引用完整保留");

  let finishUpload!: () => void;
  const uploadGate = new Promise<void>((resolve) => {
    finishUpload = resolve;
  });
  let uploadStarted = false;
  await page.route("**/api/uploads/*", async (route) => {
    if (route.request().method() === "PATCH") {
      uploadStarted = true;
      await uploadGate;
    }
    await route.continue();
  });
  await page.getByLabel("上传对话附件", { exact: true }).setInputFiles({
    name: "arriving-reference.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 原会话上传中的补充说明"),
  });
  await wait(async () => uploadStarted, "inflight upload started");
  await openRecipe(page, recipe.name);
  let finishValidation!: () => void;
  const validationGate = new Promise<void>((resolve) => {
    finishValidation = resolve;
  });
  let validationStarted = false;
  await page.route(`**/api/library/${table.id}`, async (route) => {
    validationStarted = true;
    await validationGate;
    await route.continue();
  });
  await page.getByRole("button", { name: "使用模板", exact: true }).click();
  await wait(
    async () => validationStarted,
    "inflight template validation started",
  );
  finishUpload();
  await wait(
    async () =>
      page.evaluate(
        (sid) =>
          JSON.parse(
            localStorage.getItem("pilot-chat-draft:" + sid) || "null",
          )?.attachments?.some(
            (ref: { name: string }) => ref.name === "arriving-reference.md",
          ),
        sessionA.id,
      ),
    "upload attached during validation",
  );
  finishValidation();
  await composer.waitFor();
  assert.equal(await page.locator(".chat-attachment").count(), 3);
  await page
    .locator(".chat-attachment")
    .getByText("arriving-reference.md", { exact: true })
    .waitFor();
  assert((await composer.inputValue()).startsWith(combined));
  combined = await composer.inputValue();
  await page.unroute("**/api/uploads/*");
  await page.unroute(`**/api/library/${table.id}`);
  await openRecipe(page, recipe.name);
  pass("模板校验期间上传完成，使用最新草稿原子合并，新增附件不会被旧回调覆盖");

  await page.getByRole("button", { name: "编辑模板", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑模板", exact: true });
  await editor.waitFor();
  await editor
    .getByLabel("模板描述", { exact: true })
    .fill("浏览器编辑后的持久化配方");
  await editor.getByRole("button", { name: "保存模板", exact: true }).click();
  await wait(async () => !(await editor.count()), "editor saved");
  const updated = (await api(`/templates/${recipe.id}`))
    .template as CreationTemplate;
  assert.equal(updated.version, 2);
  assert.equal(updated.description, "浏览器编辑后的持久化配方");
  assert.equal(
    (
      await response(
        `/templates/${recipe.id}`,
        { ...input, expectedVersion: 1 },
        "PATCH",
      )
    ).status,
    409,
  );
  assert.equal(
    (await api(`/templates/${recipe.id}`)).template.description,
    updated.description,
  );
  pass("浏览器编辑持久化并递增版本；旧版本更新返回409且不覆盖新内容");

  await openTemplates(page);
  await page.getByRole("button", { name: "新建模板", exact: true }).click();
  const creator = page.getByRole("dialog", { name: "新建模板", exact: true });
  await creator.getByLabel("模板名称", { exact: true }).fill("灯具创作草案");
  await creator
    .getByLabel("模板描述", { exact: true })
    .fill("用户通过浏览器创建的无参数配方");
  await creator
    .getByLabel("任务说明", { exact: true })
    .fill("创建一盏可以复用的柔光落地灯，保留当前场景并截图检查。");
  await creator.getByRole("button", { name: "保存模板", exact: true }).click();
  await wait(async () => !(await creator.count()), "create saved");
  const created = await api(
    "/templates?source=custom&search=" + encodeURIComponent("灯具创作草案"),
  );
  assert.equal(created.total, 1);
  assert.equal(
    created.items[0].prompt,
    "创建一盏可以复用的柔光落地灯，保留当前场景并截图检查。",
  );
  pass("浏览器新建配方真正保存到数据库，可按名称检索");

  // Delay library validation, then change conversation while the recipe is
  // preparing. Neither the original nor the newly selected draft may change.
  await openRecipe(page, recipe.name);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  await page.route(`**/api/library/${table.id}`, async (route) => {
    intercepted = true;
    await blocked;
    await route.continue();
  });
  await page.getByRole("button", { name: "使用模板", exact: true }).click();
  await wait(async () => intercepted, "reference validation delayed");
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await openSession(page, "独立创作 B");
  await composer.fill("B 的独立草稿");
  release();
  await delay(500);
  await page.unroute(`**/api/library/${table.id}`);
  assert.equal(await composer.inputValue(), "B 的独立草稿");
  assert.equal(await page.locator(".chat-attachment").count(), 0);
  await openSession(page, "素材组合 A");
  assert.equal(await composer.inputValue(), combined);
  pass("素材校验未完成时切换会话，迟到的模板结果不会写入任何错误会话");

  await assert.rejects(
    store.db.query(
      `DELETE FROM ${store.db.table("library_assets")} WHERE id=$1`,
      [table.id],
    ),
    (error: any) => error.code === "23503",
  );
  pass("数据库外键阻止删除仍被模板引用的素材");
  // A deliberately inconsistent restore fixture exercises defensive reading;
  // normal deletion is prevented above. Keep the stored JSON reference while
  // removing its join row and asset, as could happen after an incorrect repair.
  await store.db.query(
    `DELETE FROM ${store.db.table("creation_template_assets")} WHERE asset_id=$1`,
    [table.id],
  );
  await store.db.query(
    `DELETE FROM ${store.db.table("library_assets")} WHERE id=$1`,
    [table.id],
  );
  await openRecipe(page, recipe.name);
  const detail = await api(`/templates/${recipe.id}`);
  assert.deepEqual(detail.missingLibraryAssetIds, [table.id]);
  const useWithMissing = page.getByRole("button", {
    name: "使用模板",
    exact: true,
  });
  if (!(await useWithMissing.isDisabled())) {
    await useWithMissing.click();
    await page.locator(".template-use-footer [role='alert']").waitFor();
  }
  assert.equal(
    await page.getByRole("heading", { name: "模板中心", exact: true }).count(),
    1,
  );
  assert.equal(submissions, 0);
  pass("故意构造不一致恢复数据后，API明确报告丢失素材，界面阻止静默遗漏后套用");

  await page.setViewportSize({ width: 1280, height: 900 });
  const layoutAudit = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    template: (() => {
      const el = document.querySelector(".templates-page") as HTMLElement;
      return el
        ? { width: el.clientWidth, scrollWidth: el.scrollWidth }
        : undefined;
    })(),
  }));
  assert(
    layoutAudit.document <= layoutAudit.viewport + 1,
    "template center must not overflow viewport",
  );
  if (layoutAudit.template)
    assert(layoutAudit.template.scrollWidth <= layoutAudit.template.width + 1);
  pass("1280px 桌面视口模板列表、详情与操作无横向页面溢出");
  assert.equal(submissions, 0);
  pass("浏览、编辑、套用模板不会隐式提交任务或修改场景");

  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await openSession(page, "独立创作 B");
  await composer.fill("协议验收：检查聊天中的恢复点和场景变化回执");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await wait(async () => submissions === 1, "explicit fixture submission");
  const recovery = page.locator(".chat-snapshot");
  await recovery.waitFor();
  assert(
    await recovery
      .getByRole("button", { name: "恢复", exact: true })
      .isDisabled(),
  );
  assert.equal((await api(`/projects/${project.id}/snapshots`)).length, 1);
  const download = await fetch(
    base + (await recovery.getByLabel("下载恢复点").getAttribute("href")),
    { headers: { cookie } },
  );
  assert.equal(download.status, 200);
  assert((await download.text()).includes("snapshot protocol fixture"));
  pass("聊天按事件显示可下载的真实磁盘恢复点，活动任务期间禁止恢复");
  const job = [...jobs.values()][0];
  emit(job, "tool.completed", {
    callId: "fixture-mutation",
    name: "execute_blender_code",
    result: { fixture: true },
  });
  emit(job, "message.completed", {
    itemId: "fixture-final",
    text: "变化回执与恢复点已通过协议测试。此夹具没有执行 Blender。",
  });
  job.status = "succeeded";
  emit(job, "run.status", { status: "succeeded", verification: "fixture" });
  await wait(
    async () =>
      !(await recovery
        .getByRole("button", { name: "恢复", exact: true })
        .isDisabled()),
    "terminal restore enabled",
  );
  await page.locator(".chat-tool summary").click();
  await page
    .locator(".chat-change-receipt")
    .getByText("Fixture_Chair", { exact: true })
    .waitFor();
  assert((await page.locator(".chat-tool summary").innerText()).includes("秒"));
  pass("工具完成后展示事件耗时与新增对象回执，回放关联到原工具卡片");
  page.once("dialog", (dialog) => dialog.accept());
  await recovery.getByRole("button", { name: "恢复", exact: true }).click();
  await wait(async () => restores === 1, "snapshot restore dispatched");
  await wait(
    async () => (await api(`/projects/${project.id}/snapshots`)).length === 2,
    "preservation backup persisted",
  );
  assert(
    (await api(`/projects/${project.id}/snapshots`)).some(
      (item: Snapshot) => item.name === "恢复前备份 · Fixture",
    ),
  );
  pass("任务完成后恢复需确认，通过真实API调用恢复并持久化恢复前备份");
  assert.deepEqual(uncaught, []);
  assert.equal(submissions, 1);
  pass("全流程无浏览器未捕获错误，仅显式发送产生一次协议夹具任务");
  const result = {
    passed: true,
    time: new Date().toISOString(),
    environment: {
      api: "real Fastify",
      database:
        process.env.PILOT_TEST_POSTGRES_MODE === "wasm-wire"
          ? "PostgreSQL WASM over real TCP protocol/pg driver (not native PostgreSQL)"
          : "PostgreSQL",
      runner: "explicit protocol fixture; no Blender or live model inference",
      browser: "Chromium/Playwright",
    },
    checks,
    submissions,
    restores,
    uncaughtBrowserErrors: uncaught,
    layoutAudit,
    applyLayoutAudit,
    fontAudit,
    screenshots: [
      "templates-dark.png",
      "templates-light.png",
      "templates-recipe.png",
      "templates-numeric-editor.png",
      "templates-numeric-dark.png",
      "templates-numeric-light-1024.png",
    ],
  };
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await failurePage
    ?.screenshot({ path: path.join(output, "failure.png") })
    .catch(() => {});
  console.error(error);
  throw error;
} finally {
  await browser?.close();
  await app.close();
  await runner.close();
}
