/** Tests an already running deployment. Uses a deterministic model protocol fixture. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { responsesFixture } from "../tests/fixtures/responses.js";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
const base = process.env.PILOT_TEST_URL || "http://127.0.0.1:8090";
const password = process.env.PILOT_PASSWORD;
if (!password) throw new Error("Set PILOT_PASSWORD for the test deployment");
const fixture = await responsesFixture(
  process.env.PILOT_FIXTURE_BIND || "127.0.0.1",
);
let cookie = "";
let browser;
const api = async (route: string, body?: unknown, method?: string) => {
  const r = await fetch(base + "/api" + route, {
    method: method || (body ? "POST" : "GET"),
    headers: { cookie, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (route === "/auth/login")
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  const data = (await r.json()) as any;
  assert(r.ok, route + ": " + JSON.stringify(data));
  return data;
};
const poll = async (fn: () => Promise<any>, ms = 180000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error("Timed out waiting for deployed task");
};
try {
  await api("/auth/login", { password });
  const url = new URL(fixture.url);
  if (process.env.PILOT_FIXTURE_HOST)
    url.hostname = process.env.PILOT_FIXTURE_HOST;
  await api(
    "/settings",
    {
      baseUrl: url.toString().replace(/\/$/, ""),
      model: "gpt-5.1-codex",
      apiKey: "fixture-only-no-real-inference",
      effort: "low",
    },
    "PUT",
  );
  const p = await api("/projects", { name: "Docker integration" });
  await api("/projects/" + p.id + "/activate", {});
  const s = await api("/projects/" + p.id + "/sessions", {});
  const run = await api("/sessions/" + s.id + "/turns", {
    text: "Add a green sphere while preserving the scene.",
    clientRequestId: randomUUID(),
    assetIds: [],
  });
  const done = await poll(async () => {
    const r = (await api("/sessions/" + s.id + "/runs")).find(
      (x: any) => x.id === run.id,
    );
    return (
      ["succeeded", "failed", "interrupted", "cancelled"].includes(r?.status) &&
      r
    );
  });
  assert.equal(done.status, "succeeded", done.error);
  assert(
    (await api("/projects/" + p.id + "/scene")).objects.some(
      (x: any) => x.name === "Pilot_Verified_Sphere",
    ),
  );
  const images = fixture.requests.reduce(
    (n, b) => n + (JSON.stringify(b.input).match(/data:image\//g) || []).length,
    0,
  );
  assert(images >= 2);
  const glb = await api("/projects/" + p.id + "/export", { format: "glb" });
  const download = await fetch(base + "/api/files/artifact/" + glb.id, {
    headers: { cookie },
  });
  assert(download.ok);
  assert((await download.arrayBuffer()).byteLength > 100);
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(process.env.PILOT_BROWSER_BIN
      ? { executablePath: process.env.PILOT_BROWSER_BIN }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
  });
  await page.goto(base);
  await page.getByPlaceholder("部署时设置的 PILOT_PASSWORD").fill(password);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page
    .getByText("Blender 实时视口", { exact: true })
    .waitFor({ timeout: 30000 });
  await page.locator(".rfb-host canvas").waitFor();
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/docker-workbench.png" });
  await writeFile(
    "artifacts/deployment-result.json",
    JSON.stringify(
      {
        passed: true,
        images,
        runId: run.id,
        time: new Date().toISOString(),
        model: "deterministic fixture, not real inference",
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS Docker deployment: native Codex + MCP + Blender mutation + images + export + authenticated browser desktop",
  );
} finally {
  await browser?.close();
  await fixture.close();
}
