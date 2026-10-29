/** Browser regression using real API/SQL; execution is an explicit failure fixture. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { chromium } from "@playwright/test";
import { buildApp } from "../apps/server/app.js";
const out = path.resolve(".data/project-ui");
await mkdir(out, { recursive: true });
const runner = Fastify();
runner.get("/health", async () => ({
  ok: true,
  mode: "native-window",
  studios: [],
  activeRuns: [],
}));
let failActivation = true;
runner.post("/scene", async (_req, reply) =>
  failActivation
    ? reply.code(503).send({ error: "Blender startup fixture failure" })
    : { ok: true },
);
const runnerUrl = await runner.listen({ host: "127.0.0.1", port: 0 });
const { app } = await buildApp({
  dataRoot: out,
  password: "project-ui-password",
  internalToken: "project-ui-internal-token-123456",
  runnerUrl,
  webRoot: path.resolve("dist/web"),
  poll: false,
});
const base = await app.listen({ host: "127.0.0.1", port: 0 });
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--single-process", "--no-zygote"],
    ...(process.env.PILOT_BROWSER_BIN
      ? { executablePath: process.env.PILOT_BROWSER_BIN }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page
    .getByPlaceholder("部署时设置的 PILOT_PASSWORD")
    .fill("project-ui-password");
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page
    .getByRole("button", { name: "新建项目", exact: true })
    .last()
    .click();
  await page.getByPlaceholder("例如：海边工作室").fill("Retry test");
  let releaseCreate!: () => void;
  let intercepted!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const interceptReady = new Promise<void>((resolve) => {
    intercepted = resolve;
  });
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() === "POST") {
      intercepted();
      await createGate;
    }
    await route.continue();
  });
  let creates = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url() === base + "/api/projects") creates++;
  });
  await page.locator(".modal form").evaluate((form: HTMLFormElement) => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await interceptReady;
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("dialog[open]").count(),
    1,
    "Escape must not hide a pending submission",
  );
  assert.equal(
    await page.getByRole("button", { name: "取消", exact: true }).isDisabled(),
    true,
  );
  releaseCreate();
  await page
    .locator(".project-row strong")
    .filter({ hasText: "Retry test" })
    .waitFor();
  await page.getByText(/项目已创建，打开失败/).waitFor();
  assert.equal(creates, 1);
  assert.equal(await page.locator(".project-row").count(), 1);
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  await page.locator(".modal input").fill("Renamed project");
  let rejectRename = true;
  await page.route("**/api/projects/*", async (route) => {
    if (route.request().method() === "PATCH" && rejectRename) {
      rejectRename = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporary rename failure" }),
      });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "temporary rename failure" })
    .waitFor();
  assert.equal(
    await page.locator(".modal input").inputValue(),
    "Renamed project",
  );
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await page
    .locator(".project-row strong")
    .filter({ hasText: "Renamed project" })
    .waitFor();
  await page.reload();
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page
    .locator(".project-row strong")
    .filter({ hasText: "Renamed project" })
    .waitFor();
  assert.equal(await page.locator(".project-row").count(), 1);
  await page.screenshot({
    path: path.join(out, "projects.png"),
    fullPage: true,
  });
  failActivation = false;
  await page.getByRole("button", { name: "打开项目", exact: true }).click();
  await page.getByText("本机 Blender · 独立窗口", { exact: true }).waitFor();
  assert.equal(await page.locator(".rfb-host").count(), 0);
  await page.getByRole("button", { name: "更新截图", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(out, "result.json"),
    JSON.stringify(
      {
        checks: [
          "double submit sends one request",
          "Escape cannot dismiss a pending submit",
          "rename failure retains input and allows retry",
          "activation failure keeps one existing project",
          "rename updates list",
          "rename survives reload",
          "native-window shows screenshot UI without VNC",
        ],
        uncaughtErrors: errors,
        scope: "real API + SQL; fixture runner; no model/Blender calls",
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS project UI: double submit, failed activation, rename, reload",
  );
} finally {
  await browser?.close();
  await app.close();
  await runner.close();
}
