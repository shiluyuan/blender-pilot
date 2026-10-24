/** Browser acceptance for the chat contract.
 * Real Fastify app + PostgreSQL driver/TCP; the Runner is an explicit protocol
 * fixture. This checks UI/delivery, not Blender geometry or live model quality.
 * Run through scripts/with-postgres.ts after npm run build.
 */
import assert from "node:assert/strict";
import Fastify from "fastify";
import { chromium, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp } from "../apps/server/app.js";
import type {
  PilotEvent,
  RunStatus,
  StartJob,
} from "../packages/contracts/index.js";

const root = process.cwd();
const output = path.resolve(
  process.env.PILOT_CHAT_TEST_DATA || ".data/chat-acceptance",
);
await mkdir(output, { recursive: true });
const checks: string[] = [];
const pass = (text: string) => {
  checks.push(text);
  console.log("PASS " + text);
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function wait<T>(
  fn: () => Promise<T>,
  label: string,
  timeout = 15000,
): Promise<T> {
  const until = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await delay(80);
  }
  throw new Error("Timed out: " + label + ": " + String(last || ""));
}
type FixtureJob = {
  input: StartJob;
  status: RunStatus;
  seq: number;
  events: PilotEvent[];
  verification: string;
  updatedAt: string;
};
const jobs = new Map<string, FixtureJob>();
const submissions: StartJob[] = [];
const documents: string[] = [];
const runner = Fastify();
function emit(job: FixtureJob, type: string, payload: Record<string, unknown>) {
  job.updatedAt = new Date().toISOString();
  job.events.push({
    schemaVersion: 1,
    runId: job.input.runId,
    sessionId: job.input.sessionId,
    projectId: job.input.projectId,
    seq: ++job.seq,
    time: job.updatedAt,
    type,
    payload,
  });
}
function complete(job: FixtureJob, status: RunStatus = "succeeded") {
  if (job.status !== "running") return;
  if (status === "succeeded") {
    emit(job, "plan.updated", {
      plan: [
        { step: "阅读上传的说明", status: "completed" },
        { step: "检查可复用组件", status: "completed" },
      ],
    });
    emit(job, "tool.completed", {
      callId: "tool-" + job.input.runId,
      name: "get_scene_info",
      result: { fixture: true, objects: [{ name: "Reference_Component" }] },
    });
    emit(job, "message.started", {
      itemId: "result-" + job.input.runId,
      phase: "final_answer",
    });
    emit(job, "message.completed", {
      itemId: "result-" + job.input.runId,
      phase: "final_answer",
      text:
        "### 组合结果\n\n**这是聊天协议测试夹具，没有运行 Blender 或真实模型。**\n\n```python\n# fixture only\ncomponent_name = 'Reference_Component'\n```\n\n| 类型 | 状态 |\n| --- | --- |\n| 文档引用 | 已接收 |\n| 工具事件 | 已完成 |\n\n[查看文档](https://github.com/shiluyuan/blender-pilot)" +
        (job.input.prompt.includes("响应式")
          ? "\n\n### 长内容压力样本\n\n```text\n" +
            "long_resource_path_without_wrapping/".repeat(16) +
            "\n```\n\n|" +
            Array.from({ length: 24 }, (_, i) => "字段" + i).join("|") +
            "|\n|" +
            Array.from({ length: 24 }, () => "---").join("|") +
            "|\n|" +
            Array.from({ length: 24 }, (_, i) => "值" + i).join("|") +
            "|"
          : ""),
    });
  }
  job.status = status;
  job.verification = "fixture";
  emit(job, "run.status", { status, verification: "fixture" });
}
runner.get("/health", async () => ({
  ok: true,
  maxStudios: 3,
  studios: [],
  activeRuns: [...jobs.values()]
    .filter((j) => j.status === "running")
    .map((j) => ({
      id: j.input.runId,
      projectId: j.input.projectId,
      sessionId: j.input.sessionId,
    })),
}));
runner.post("/scene", async () => ({
  ok: true,
  objects: [],
  selected: [],
  mode: "OBJECT",
  revision: "protocol-fixture",
  version: "protocol-fixture",
}));
runner.post("/jobs", async (req) => {
  const input = req.body as StartJob;
  if (jobs.has(input.runId)) return jobs.get(input.runId);
  submissions.push(input);
  for (const asset of input.assets)
    if (/\.(md|txt|json|csv)$/i.test(asset.name))
      documents.push(await readFile(asset.path, "utf8"));
  const job: FixtureJob = {
    input,
    status: "running",
    seq: 0,
    events: [],
    verification: "pending",
    updatedAt: new Date().toISOString(),
  };
  jobs.set(input.runId, job);
  emit(job, "run.status", { status: "running" });
  emit(job, "message.started", {
    itemId: "intro-" + input.runId,
    phase: "commentary",
  });
  emit(job, "message.delta", {
    itemId: "intro-" + input.runId,
    delta: "我先阅读参考说明，再检查可复用组件。",
  });
  emit(job, "message.completed", {
    itemId: "intro-" + input.runId,
    text: "我先阅读参考说明，再检查可复用组件。",
    phase: "commentary",
  });
  emit(job, "plan.updated", {
    plan: [
      { step: "阅读上传的说明", status: "completed" },
      { step: "检查可复用组件", status: "inProgress" },
    ],
  });
  emit(job, "tool.started", {
    callId: "tool-" + input.runId,
    name: "get_scene_info",
    args: {},
  });
  if (!input.prompt.includes("保持运行"))
    setTimeout(() => complete(job), 1100).unref();
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
runner.get("/jobs/:id/events", async (req) => {
  const job = jobs.get((req.params as any).id);
  return (job?.events || []).filter(
    (e) => e.seq > Number((req.query as any).after || 0),
  );
});
runner.post("/jobs/:id/cancel", async (req) => {
  const job = jobs.get((req.params as any).id)!;
  complete(job, "cancelled");
  return { id: job.input.runId, status: job.status };
});
runner.post("/projects/:id/close", async () => ({ ok: true }));

const runnerUrl = await runner.listen({ host: "127.0.0.1", port: 0 });
const { app, store } = await buildApp({
  dataRoot: output,
  password: "chat-acceptance-password",
  internalToken: "chat-fixture-only-internal-token",
  runnerUrl,
  webRoot: path.join(root, "dist/web"),
});
const base = await app.listen({ host: "127.0.0.1", port: 0 });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let cookie = "";
const api = async (route: string, body?: unknown, method?: string) => {
  const r = await fetch(base + "/api" + route, {
    method: method || (body ? "POST" : "GET"),
    headers: { cookie, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (route === "/auth/login")
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  const value: any = await r.json();
  assert(r.ok, route + ": " + JSON.stringify(value));
  return value;
};
async function openHistory(page: Page, name: string) {
  await page.getByTitle("对话历史", { exact: true }).click();
  await page
    .locator(".session-list button")
    .filter({ hasText: name })
    .first()
    .click();
}
try {
  await api("/auth/login", { password: "chat-acceptance-password" });
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
    name: "聊天协议验收 · Runner Fixture",
  });
  const sessionA = await api(`/projects/${project.id}/sessions`, {});
  const sessionB = await api(`/projects/${project.id}/sessions`, {});
  await store.put("session", sessionA.id, { ...sessionA, title: "场景参考 A" });
  await store.put("session", sessionB.id, { ...sessionB, title: "独立草稿 B" });
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--single-process", "--no-zygote"],
    ...(process.env.PILOT_BROWSER_BIN
      ? { executablePath: process.env.PILOT_BROWSER_BIN }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.addInitScript(
    ({ pid, sid }) => {
      if (!localStorage.getItem("pilot-project")) {
        localStorage.setItem("pilot-project", pid);
        localStorage.setItem(
          "pilot-workspace:" + pid,
          JSON.stringify({ sessionId: sid }),
        );
        localStorage.setItem("pilot-theme", "dark");
        localStorage.setItem("pilot-panel-width", "600");
      }
    },
    { pid: project.id, sid: sessionA.id },
  );
  const page = await context.newPage();
  const uncaught: string[] = [];
  page.on("pageerror", (error) => uncaught.push(String(error)));
  await page.goto(base);
  await page
    .getByPlaceholder("部署时设置的 PILOT_PASSWORD")
    .fill("chat-acceptance-password");
  await page.getByRole("button", { name: "进入工作台" }).click();
  const input = page.locator(".composer textarea");
  await input.waitFor();
  await wait(async () => !(await input.isDisabled()), "project activation");
  await input.fill("中文输入法测试");
  await input.dispatchEvent("compositionstart");
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  await delay(200);
  assert.equal(submissions.length, 0);
  await input.dispatchEvent("compositionend");
  await input.fill("第一行");
  await input.press("Shift+Enter");
  await input.press("End");
  assert((await input.inputValue()).includes("\n"));
  pass("中文 IME 回车不误发送，Shift+Enter 保留换行");

  let streamDropped = false;
  await page.route("**/api/runs/*/events*", async (route) => {
    if (streamDropped) return route.continue();
    streamDropped = true;
    await route.abort("failed");
  });
  const md =
    "# 场景规范\n\n复用木桌和沙发，新增蓝色灯具。\n\n- 尺寸：6m × 4m\n- 素材分类：道具、场景\n";
  await page.getByLabel("上传对话附件", { exact: true }).setInputFiles({
    name: "scene-spec.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(md),
  });
  await page
    .locator(".attachments")
    .getByText("scene-spec.md", { exact: true })
    .waitFor();
  await input.fill("根据上传的场景规范组合素材（协议验收）");
  await input.press("Enter");
  await wait(async () => submissions.length === 1, "chat submission");
  assert.equal(submissions[0].assets.length, 1);
  assert.equal(documents[0], md);
  await page
    .locator(".chat-timeline h3")
    .filter({ hasText: "组合结果" })
    .waitFor();
  assert(await page.locator(".chat-timeline pre code").count());
  assert(await page.locator(".chat-timeline table").count());
  const timelineText = await page.locator(".chat-timeline").innerText();
  assert(
    timelineText.indexOf("我先阅读参考说明") < timelineText.indexOf("读取场景"),
  );
  assert(timelineText.indexOf("读取场景") < timelineText.indexOf("组合结果"));
  assert.equal((timelineText.match(/我先阅读参考说明/g) || []).length, 1);
  pass(
    "MD 上传自动引用；真实 API/SQL 保留正文并交给 Runner；Markdown/代码/表格与工具按事件顺序展示",
  );
  assert(streamDropped, "first EventSource connection should have failed");
  await page.unroute("**/api/runs/*/events*");
  pass("SSE 首次断开后自动重连，重放完整有序消息而不重复");

  await wait(
    async () =>
      (await api(`/sessions/${sessionA.id}/runs`))[0]?.status === "succeeded",
    "first completion",
  );
  await page.evaluate(() => document.fonts.ready);
  const cdp = await context.newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const dom = await cdp.send("DOM.getDocument");
  const fontAudit: Array<{
    selector: string;
    family: string;
    fonts: unknown[];
  }> = [];
  for (const selector of [".assistant-label strong", ".chat-markdown p"]) {
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: dom.root.nodeId,
      selector,
    });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    assert(fonts.length > 0, "platform font must be rendered for " + selector);
    assert(
      !fonts.some((font) => /times|serif/i.test(font.familyName)),
      "chat body must render in actual sans fonts",
    );
    fontAudit.push({
      selector,
      family: await page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).fontFamily),
      fonts,
    });
  }
  await cdp.detach();
  pass("Chromium 实际平台字体为 sans，中文有真实字形且无 Times/serif 回退");
  await page.screenshot({ path: path.join(output, "chat-workbench.png") });
  await page
    .locator(".chat-panel")
    .screenshot({ path: path.join(output, "chat-dark.png") });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await page
    .locator(".chat-panel")
    .screenshot({ path: path.join(output, "chat-light.png") });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });

  await input.fill("A 会话独立草稿");
  await openHistory(page, "独立草稿 B");
  await wait(
    async () => (await input.inputValue()) === "",
    "new session empty draft",
  );
  await input.fill("B 会话独立草稿");
  await openHistory(page, "场景参考 A");
  await wait(
    async () => (await input.inputValue()) === "A 会话独立草稿",
    "A session draft restore",
  );
  pass("草稿按 session 隔离，切换不会串到其他对话");

  await page.route("**/api/uploads/*", async (route) => {
    if (route.request().method() === "PATCH") await delay(800);
    return route.continue();
  });
  await page.getByLabel("上传对话附件", { exact: true }).setInputFiles({
    name: "slow-reference.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# A 会话专属附件"),
  });
  await page
    .getByTestId("chat-upload-row")
    .filter({ hasText: "slow-reference.md" })
    .waitFor();
  await openHistory(page, "独立草稿 B");
  await delay(1200);
  assert(
    !(await page.locator(".attachments").count()),
    "upload must not follow the selected session",
  );
  await openHistory(page, "场景参考 A");
  await page
    .locator(".attachments")
    .getByText("slow-reference.md", { exact: true })
    .waitFor();
  await page
    .locator(".attachments")
    .getByRole("button", { name: "移除附件", exact: true })
    .click();
  await page.unroute("**/api/uploads/*");
  pass("上传中切换会话，完成后的附件仍只引用到原会话");

  let dropped = false;
  await page.route("**/api/sessions/*/turns", async (route) => {
    if (dropped) return route.continue();
    dropped = true;
    await route.fetch();
    await delay(500);
    await route.abort("failed");
  });
  await input.fill("测试服务端已接收但回执丢失");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await wait(
    async () => submissions.length === 2,
    "server accepted lost response",
  );
  await input.fill("随后编辑的新草稿应该保留");
  await page.getByTestId("chat-outbox").waitFor();
  await page.getByRole("button", { name: "重试确认", exact: true }).click();
  await wait(
    async () => !(await page.getByTestId("chat-outbox").count()),
    "idempotent response confirmed",
  );
  assert.equal(submissions.length, 2);
  assert.equal(await input.inputValue(), "随后编辑的新草稿应该保留");
  await page.unroute("**/api/sessions/*/turns");
  pass("回执丢失复用 requestId，不重复执行；旧发送回调不会清空新草稿");

  await wait(
    async () =>
      (await api(`/sessions/${sessionA.id}/runs`)).every(
        (r: any) => r.status === "succeeded",
      ),
    "retry run finished",
  );
  await input.fill("保持运行，以验证取消和会话归属");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await wait(async () => submissions.length === 3, "hold run");
  const holdId = submissions[2].runId;
  const scrollable = page.locator(".chat-timeline");
  await scrollable.dispatchEvent("wheel", { deltaY: -1200 });
  await scrollable.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  const scrollBefore = await scrollable.evaluate((el) => ({
    top: el.scrollTop,
    max: el.scrollHeight - el.clientHeight,
  }));
  assert(scrollBefore.max > 100, "fixture transcript should require scrolling");
  emit(jobs.get(holdId)!, "message.completed", {
    itemId: "scroll-intent",
    text: "这是一条在用户回看历史时到达的新消息。",
    phase: "commentary",
  });
  await delay(1100);
  assert(
    (await scrollable.evaluate((el) => el.scrollTop)) < 50,
    "new events must not pull a reader back to the bottom",
  );
  pass("用户向上回看时保持滚动位置，新事件不会强制拉到底部");
  await openHistory(page, "独立草稿 B");
  assert.equal(await input.inputValue(), "B 会话独立草稿");
  emit(jobs.get(holdId)!, "message.completed", {
    itemId: "late-owner",
    text: "只属于 A 的延迟消息",
    phase: "commentary",
  });
  await delay(1000);
  assert(
    !(await page.locator(".chat-timeline").innerText()).includes(
      "只属于 A 的延迟消息",
    ),
  );
  await openHistory(page, "场景参考 A");
  await page.getByText("只属于 A 的延迟消息", { exact: true }).waitFor();
  await page.getByRole("button", { name: "停止任务", exact: true }).click();
  await wait(
    async () =>
      (await api(`/sessions/${sessionA.id}/runs`)).find(
        (r: any) => r.id === holdId,
      )?.status === "cancelled",
    "cancel receipt",
  );
  pass("切换会话后延迟事件仍归原会话；停止任务获得真实取消终态");

  await wait(
    async () =>
      (await page
        .getByRole("button", { name: "发送消息", exact: true })
        .count()) > 0,
    "composer released after cancellation",
  );
  await input.fill("取消后继续组合剩余素材");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await wait(async () => submissions.length === 4, "continuation after cancel");
  await wait(
    async () =>
      (await api(`/sessions/${sessionA.id}/runs`)).filter(
        (r: any) => r.status === "succeeded",
      ).length === 3,
    "continuation completed",
  );
  pass("取消结束后可以继续发送并完成下一轮");

  let secondLostResponse = false;
  await page.route("**/api/sessions/*/turns", async (route) => {
    if (secondLostResponse) return route.continue();
    secondLostResponse = true;
    await route.fetch();
    await route.abort("failed");
  });
  await input.fill("刷新后自动核对未知回执");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.getByRole("button", { name: "重试确认", exact: true }).waitFor();
  await page.unroute("**/api/sessions/*/turns");
  await page.reload();
  await page
    .locator(".chat-timeline .user-message")
    .getByText("刷新后自动核对未知回执", { exact: true })
    .waitFor();
  await wait(
    async () => !(await page.getByTestId("chat-outbox").count()),
    "reload confirms original delivery",
  );
  assert.equal(submissions.length, 5);
  await wait(
    async () =>
      (await api(`/sessions/${sessionA.id}/runs`)).filter(
        (r: any) => r.status === "succeeded",
      ).length === 4,
    "reloaded delivery completed",
  );
  pass("未知回执刷新后自动查询原requestId并恢复，未产生重复执行");

  await page.reload();
  await page.getByText("只属于 A 的延迟消息", { exact: true }).waitFor();
  assert((await page.locator(".chat-timeline h3").count()) >= 2);
  pass("刷新后由 PostgreSQL/SSE 还原历史消息、工具与取消状态");

  await page.getByLabel("上传对话附件", { exact: true }).setInputFiles({
    name: "unsupported.exe",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("invalid"),
  });
  await page
    .getByTestId("chat-upload-row")
    .filter({ hasText: "unsupported.exe" })
    .waitFor();
  await wait(
    async () =>
      (
        await page
          .getByTestId("chat-upload-row")
          .filter({ hasText: "unsupported.exe" })
          .innerText()
      ).includes("不支持"),
    "visible upload rejection",
  );
  await input.fill("失败附件不得静默遗漏");
  assert(
    await page
      .getByRole("button", { name: "发送消息", exact: true })
      .isDisabled(),
  );
  pass("不支持的附件显示失败，阻止发送时静默遗漏");
  await page
    .locator(".chat-panel")
    .screenshot({ path: path.join(output, "chat-errors.png") });

  await page
    .getByRole("button", { name: "取消上传 unsupported.exe", exact: true })
    .click();
  await input.fill("响应式压力样本：验证长代码与宽表格");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await wait(async () => submissions.length === 6, "responsive fixture run");
  await page
    .getByRole("heading", { name: "长内容压力样本", exact: true })
    .waitFor();
  await wait(
    async () =>
      (await api(`/sessions/${sessionA.id}/runs`)).filter(
        (r: any) => r.status === "succeeded",
      ).length === 5,
    "responsive fixture completion",
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  const separator = page.getByRole("separator", {
    name: "调整助手宽度",
    exact: true,
  });
  await separator.focus();
  for (let i = 0; i < 20; i++) await separator.press("ArrowRight");
  await wait(
    async () =>
      Math.abs((await page.locator(".chat-panel").boundingBox())!.width - 340) <
      2,
    "minimum panel width",
  );
  await page.getByLabel("上传对话附件", { exact: true }).setInputFiles({
    name: "long-reference-filename-to-check-attachment-chip-layout-at-340-pixels.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 窄屏附件布局"),
  });
  await page.locator(".chat-attachments .chat-attachment").waitFor();
  await input.fill("收起后应完整保留的未发送草稿");
  const layoutAudit = await page.evaluate(() => {
    const panels = [
      ".chat-panel",
      ".composer-controls",
      ".chat-attachments",
    ].map((selector) => {
      const node = document.querySelector(selector) as HTMLElement;
      return {
        selector,
        width: node.clientWidth,
        scrollWidth: node.scrollWidth,
        overflowX: getComputedStyle(node).overflowX,
      };
    });
    const code = document.querySelectorAll(".chat-code pre");
    const tables = document.querySelectorAll(".chat-markdown table");
    const codeNode = code[code.length - 1] as HTMLElement;
    const tableNode = tables[tables.length - 1] as HTMLElement;
    return {
      viewport: innerWidth,
      panelWidth: document.querySelector(".chat-panel")!.getBoundingClientRect()
        .width,
      panels,
      code: {
        width: codeNode.clientWidth,
        scrollWidth: codeNode.scrollWidth,
        overflowX: getComputedStyle(codeNode).overflowX,
      },
      table: {
        width: tableNode.clientWidth,
        scrollWidth: tableNode.scrollWidth,
        overflowX: getComputedStyle(tableNode).overflowX,
      },
    };
  });
  for (const region of layoutAudit.panels)
    assert(
      region.scrollWidth <= region.width + 1,
      region.selector + " must not overflow horizontally",
    );
  assert(
    layoutAudit.code.scrollWidth > layoutAudit.code.width,
    "long code should scroll in its own block",
  );
  assert(["auto", "scroll"].includes(layoutAudit.code.overflowX));
  assert(
    layoutAudit.table.scrollWidth > layoutAudit.table.width,
    "wide table should scroll in its own block",
  );
  assert(["auto", "scroll"].includes(layoutAudit.table.overflowX));
  pass(
    "1280px 视口、340px 最小侧栏：输入工具栏/附件不溢出，长代码与宽表格只在各自区域横滚",
  );
  await page
    .locator(".topbar-right")
    .getByRole("button", { name: "收起助手", exact: true })
    .click();
  assert.equal(await page.locator(".chat-panel").count(), 0);
  await page
    .locator(".topbar-right")
    .getByRole("button", { name: "展开助手", exact: true })
    .click();
  assert.equal(await input.inputValue(), "收起后应完整保留的未发送草稿");
  assert.equal(await page.locator(".chat-attachment").count(), 1);
  await page
    .getByRole("heading", { name: "长内容压力样本", exact: true })
    .waitFor();
  pass("收起再展开侧栏，历史、草稿和未发送附件完整保留");
  await page
    .locator(".chat-panel")
    .screenshot({ path: path.join(output, "chat-narrow.png") });

  assert.deepEqual(
    uncaught,
    [],
    "browser must not have uncaught application errors",
  );
  const summary = {
    passed: true,
    time: new Date().toISOString(),
    environment: {
      api: "real Fastify",
      database:
        process.env.PILOT_TEST_POSTGRES_MODE === "wasm-wire"
          ? "PostgreSQL WASM over real TCP protocol/pg driver (not native PostgreSQL)"
          : "PostgreSQL",
      runner:
        "explicit deterministic protocol fixture; no Blender or live inference",
      browser: "Chromium/Playwright",
    },
    checks,
    submissions: submissions.length,
    uncaughtBrowserErrors: uncaught,
    fontAudit,
    layoutAudit,
    screenshots: [
      "chat-dark.png",
      "chat-light.png",
      "chat-errors.png",
      "chat-narrow.png",
    ],
  };
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser?.close();
  await app.close();
  await runner.close();
}
