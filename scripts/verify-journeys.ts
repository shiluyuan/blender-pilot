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
  process.env.PILOT_JOURNEY_TEST_DATA || ".data/release-journeys",
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
// Added release journeys use the real API and SQL with the explicit Runner
// fixture above. They are not model inference or Blender geometry tests.
try {
  await api("/auth/login", { password: "chat-acceptance-password" });
  const projectA = await api("/projects", { name: "发布验收项目 A · Fixture" });
  const projectB = await api("/projects", { name: "发布验收项目 B · Fixture" });
  const sessionA = await api(`/projects/${projectA.id}/sessions`, {});
  const sessionB = await api(`/projects/${projectB.id}/sessions`, {});
  const history = await api(`/projects/${projectA.id}/sessions`, {});
  await store.put("session", history.id, {
    ...history,
    title: "40轮历史 · Fixture",
  });
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
        localStorage.setItem("pilot-panel-width", "580");
      }
    },
    { pid: projectA.id, sid: sessionA.id },
  );
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const uncaught: string[] = [];
  page.on("pageerror", (error) => uncaught.push(String(error)));
  const input = page.locator(".composer textarea");
  async function login() {
    await page
      .getByPlaceholder("部署时设置的 PILOT_PASSWORD")
      .fill("chat-acceptance-password");
    await page.getByRole("button", { name: "进入工作台", exact: true }).click();
    await input.waitFor();
    await wait(
      async () => !(await input.isDisabled()),
      "active project after login",
    );
  }
  async function chooseProject(project: { id: string; name: string }) {
    await page
      .locator(".project-explorer > button")
      .filter({ hasText: project.name })
      .click();
    await wait(
      async () =>
        (await page.evaluate(() => localStorage.getItem("pilot-project"))) ===
          project.id && !(await input.isDisabled()),
      "project switch",
    );
    await page
      .locator(".project-explorer > button.selected")
      .filter({ hasText: project.name })
      .waitFor();
  }
  async function draft(sid: string) {
    return page.evaluate(
      (id) =>
        JSON.parse(localStorage.getItem("pilot-chat-draft:" + id) || "null"),
      sid,
    );
  }
  async function waitDone(sid: string, id: string) {
    await wait(
      async () =>
        (await api(`/sessions/${sid}/runs`)).find((run: any) => run.id === id)
          ?.status === "succeeded",
      "fixture completion",
      30000,
    );
    await wait(
      async () =>
        (await page
          .locator(
            `.conversation-turn[data-run-id="${id}"] .run-badge.succeeded`,
          )
          .count()) > 0,
      "completion visible",
    );
  }
  await page.goto(base);
  await page
    .getByPlaceholder("部署时设置的 PILOT_PASSWORD")
    .fill("incorrect-password");
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await page.locator(".login-box .error").waitFor();
  assert.equal(await input.count(), 0);
  await login();
  pass("首次登录密码错误明确提示，正确登录后项目可操作");

  await input.fill("尚未配置模型时的创作要求");
  await input.press("Enter");
  await page
    .getByTestId("chat-outbox")
    .getByText(/请先在设置中填写模型/)
    .waitFor();
  assert.equal(submissions.length, 0);
  await page.getByRole("button", { name: "移回草稿", exact: true }).click();
  assert.equal(await input.inputValue(), "尚未配置模型时的创作要求");
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
  await page.reload();
  await input.waitFor();
  await wait(
    async () => !(await input.isDisabled()),
    "project restored after reload",
  );
  assert.equal(await input.inputValue(), "尚未配置模型时的创作要求");
  pass("模型未配置时拒绝任务且保留要求；配置后刷新草稿仍在");

  await input.fill("项目 A 的独立草稿");
  await page.getByLabel("上传对话附件", { exact: true }).setInputFiles({
    name: "project-a.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 项目 A\n只属于项目A"),
  });
  await page
    .locator(".attachments")
    .getByText("project-a.md", { exact: true })
    .waitFor();
  await chooseProject(projectB);
  await input.fill("项目 B 的独立草稿");
  await page.getByLabel("上传对话附件", { exact: true }).setInputFiles({
    name: "project-b.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 项目 B\n只属于项目B"),
  });
  await page
    .locator(".attachments")
    .getByText("project-b.md", { exact: true })
    .waitFor();
  for (let i = 0; i < 3; i++) {
    await chooseProject(projectA);
    assert.equal(await input.inputValue(), "项目 A 的独立草稿");
    assert.equal(
      await page
        .locator(".attachments")
        .getByText("project-b.md", { exact: true })
        .count(),
      0,
    );
    await chooseProject(projectB);
    assert.equal(await input.inputValue(), "项目 B 的独立草稿");
    assert.equal(
      await page
        .locator(".attachments")
        .getByText("project-a.md", { exact: true })
        .count(),
      0,
    );
  }
  assert.equal(submissions.length, 0);
  pass("两个项目重复交替切换六次，草稿和文档引用独立且不会隐式提交任务");

  await context.clearCookies();
  await input.fill("登录过期期间提交的要求");
  await input.press("Enter");
  await page
    .getByText("登录已过期，请重新登录。对话草稿、附件和待确认消息已保留。", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    (await draft(sessionB.id)).outbox.text,
    "登录过期期间提交的要求",
  );
  assert.equal(submissions.length, 0);
  await login();
  await page.getByTestId("chat-outbox").waitFor();
  await page.getByRole("button", { name: "重试确认", exact: true }).click();
  await wait(async () => submissions.length === 1, "post-login send");
  await waitDone(sessionB.id, submissions[0].runId);
  assert.equal(submissions[0].assets[0].name, "project-b.md");
  pass("发送遇到真实401会转回登录；重新登录后保留文档并按原消息编号继续发送");

  let loseAcknowledgement = true;
  await page.route("**/api/sessions/*/turns", async (route) => {
    if (!loseAcknowledgement) return route.continue();
    loseAcknowledgement = false;
    await route.fetch();
    await route.abort("failed");
  });
  await input.fill("响应丢失后的待确认消息");
  await input.press("Enter");
  await wait(
    async () => (await draft(sessionB.id))?.outbox?.uncertain === true,
    "uncertain receipt",
  );
  const uncertain = (await draft(sessionB.id)).outbox;
  assert.equal(submissions.length, 2);
  await context.clearCookies();
  await page.getByRole("button", { name: "重试确认", exact: true }).click();
  await page.getByPlaceholder("部署时设置的 PILOT_PASSWORD").waitFor();
  assert.equal(
    (await draft(sessionB.id)).outbox.uncertain,
    true,
    "401 during receipt lookup must not authorize resending as a new task",
  );
  await login();
  await wait(
    async () => !(await draft(sessionB.id)).outbox,
    "accepted receipt reconciled after login",
  );
  assert.equal(submissions.length, 2);
  assert.equal(
    (
      await api(
        `/sessions/${sessionB.id}/requests/${uncertain.clientRequestId}`,
      )
    ).run.id,
    submissions[1].runId,
  );
  await page.unroute("**/api/sessions/*/turns");
  await waitDone(sessionB.id, submissions[1].runId);
  pass(
    "已接收但丢失回执时，401不抹去不确定状态；重新登录只核对原任务，不重复执行",
  );

  let expireUpload = true;
  await page.route("**/api/uploads/*", async (route) => {
    if (expireUpload && route.request().method() === "PATCH") {
      expireUpload = false;
      await context.clearCookies();
    }
    await route.continue();
  });
  await input.fill("上传失败仍保留的草稿");
  await page.getByLabel("上传对话附件", { exact: true }).setInputFiles({
    name: "resume-after-login.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 分片认证恢复\n真实文件正文"),
  });
  await page.getByPlaceholder("部署时设置的 PILOT_PASSWORD").waitFor();
  await wait(
    async () => (await draft(sessionB.id)).uploads[0]?.status === "failed",
    "failed upload saved",
  );
  await login();
  await page
    .getByTestId("chat-upload-row")
    .filter({ hasText: "resume-after-login.md" })
    .waitFor();
  assert.equal(await input.inputValue(), "上传失败仍保留的草稿");
  await page
    .getByRole("button", {
      name: "重试上传 resume-after-login.md",
      exact: true,
    })
    .click();
  await page
    .locator(".attachments")
    .getByText("resume-after-login.md", { exact: true })
    .waitFor();
  await page.unroute("**/api/uploads/*");
  assert.equal((await draft(sessionB.id)).attachments.length, 1);
  assert.equal(submissions.length, 2);
  pass("上传分片遇到401时保留文件与草稿，重新登录后重试完成且引用不重复");

  await input.fill("保持运行，验证服务器撤销登录后重新挂载活动任务");
  await input.press("Enter");
  await wait(async () => submissions.length === 3, "held fixture task");
  const activeId = submissions[2].runId;
  await page
    .locator(`.conversation-turn[data-run-id="${activeId}"] .chat-tool`)
    .waitFor();
  await context.request.post(base + "/api/auth/logout");
  await page
    .getByPlaceholder("部署时设置的 PILOT_PASSWORD")
    .waitFor({ timeout: 20000 });
  await login();
  await page.locator(`.conversation-turn[data-run-id="${activeId}"]`).waitFor();
  complete(jobs.get(activeId)!);
  await waitDone(sessionB.id, activeId);
  assert.equal(submissions.length, 3);
  pass(
    "服务器撤销登录后关闭活动连接，重新登录恢复原任务与事件，任务继续且没有重复创建",
  );

  await chooseProject(projectA);
  for (let index = 0; index < 40; index++) {
    const id = randomUUID();
    const time = new Date(Date.UTC(2026, 9, 24, 1, index)).toISOString();
    const prompt = `History prompt ${index.toString().padStart(2, "0")} · explicit fixture`;
    await store.put("run", id, {
      id,
      projectId: projectA.id,
      sessionId: history.id,
      prompt,
      assetIds: [],
      libraryAssetIds: [],
      status: "succeeded",
      verification: "fixture",
      createdAt: time,
      updatedAt: time,
    });
    const events: Array<[string, Record<string, unknown>]> = [
      [
        "message.completed",
        { itemId: "intro", text: `History intro ${index}` },
      ],
      ["tool.started", { callId: "read", name: "get_scene_info", args: {} }],
      [
        "tool.completed",
        { callId: "read", name: "get_scene_info", result: { fixture: true } },
      ],
      [
        "message.completed",
        {
          itemId: "answer",
          text: `History response ${index.toString().padStart(2, "0")} · explicit fixture`,
        },
      ],
      ["run.status", { status: "succeeded", verification: "fixture" }],
    ];
    for (const [offset, [type, payload]] of events.entries())
      await store.event({
        schemaVersion: 1,
        projectId: projectA.id,
        sessionId: history.id,
        runId: id,
        seq: offset + 1,
        type,
        payload,
        time,
      });
  }
  await openHistory(page, "40轮历史 · Fixture");
  await wait(
    async () =>
      (await page.locator(".conversation-turn").count()) === 40 &&
      (await page.locator(".chat-tool").count()) === 40,
    "long history loaded",
    40000,
  );
  assert.equal(
    await page
      .getByText("History response 39 · explicit fixture", { exact: true })
      .count(),
    1,
  );
  await page.reload();
  await input.waitFor();
  await wait(
    async () => !(await input.isDisabled()),
    "history project after reload",
  );
  await wait(
    async () =>
      (await page.locator(".conversation-turn").count()) === 40 &&
      (await page.locator(".chat-tool").count()) === 40,
    "long history reload",
    40000,
  );
  assert.equal(
    await page
      .getByText("History response 39 · explicit fixture", { exact: true })
      .count(),
    1,
  );
  const ids = await page
    .locator(".conversation-turn")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-run-id")),
    );
  assert.equal(new Set(ids).size, 40);
  pass("40轮已持久化会话加载和刷新后，40个任务与40张工具卡片完整且无重复");
  assert.deepEqual(uncaught, []);
  pass("全部新增用户旅程没有未捕获的浏览器错误");
  await page.screenshot({ path: path.join(output, "journeys.png") });
  const result = {
    passed: true,
    time: new Date().toISOString(),
    environment: {
      api: "real Fastify",
      database:
        process.env.PILOT_TEST_POSTGRES_MODE === "wasm-wire"
          ? "explicit PostgreSQL WASM over TCP/pg driver; not native PostgreSQL"
          : "PostgreSQL server",
      runner:
        "explicit protocol fixture; no real model or Blender in this suite",
      browser: "Chromium/Playwright",
    },
    checks,
    submissions: submissions.length,
    seededHistoryTurns: 40,
    uncaughtBrowserErrors: uncaught,
  };
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await app.close();
  await runner.close();
}
