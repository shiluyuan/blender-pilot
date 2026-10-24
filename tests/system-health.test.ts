import "./database-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../apps/server/app.js";
import { probeExecution } from "../apps/server/health.js";
import { collectRunnerHealth } from "../apps/runner/health.js";
import type { StudioPool } from "../apps/runner/pool.js";

async function serverFixture() {
  let status = 200;
  let response = JSON.stringify({ ok: true, studios: [], activeRuns: [] });
  const server = createServer((request, reply) => {
    assert.equal(
      request.headers.authorization,
      "Bearer private-internal-token",
    );
    reply.writeHead(status, { "content-type": "application/json" });
    reply.end(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    set: (code: number, body: unknown, raw = false) => {
      status = code;
      response = raw ? String(body) : JSON.stringify(body);
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("health keeps degraded Runner receipts and distinguishes transport loss from malformed responses", async () => {
  const fixture = await serverFixture();
  const probe = () =>
    probeExecution({
      runnerUrl: fixture.url,
      internalToken: "private-internal-token",
      signal: new AbortController().signal,
      timeoutMs: 300,
    });
  try {
    const studios = [{ projectId: "broken-project", status: "failed" }];
    const activeRuns = [
      { id: "task", projectId: "other-project", sessionId: "session" },
    ];
    fixture.set(503, {
      ok: false,
      studios,
      activeRuns,
      storage: { ok: false, error: "journal unavailable" },
    });
    const degraded = await probe();
    assert.equal(degraded.ok, false);
    assert.equal(degraded.reachable, true);
    assert.equal(degraded.httpStatus, 503);
    assert.deepEqual(degraded.studios, studios);
    assert.deepEqual(degraded.activeRuns, activeRuns);
    assert.equal(degraded.storage?.ok, false);
    fixture.set(200, "not json", true);
    const malformed = await probe();
    assert.equal(malformed.ok, false);
    assert.equal(malformed.reachable, true);
    fixture.set(200, { connected: true });
    assert.equal((await probe()).ok, false);
    for (const invalid of [
      { studios: {} },
      { activeRuns: "bad" },
      { studios: [null] },
      { studios: [{ projectId: "p", status: "unexpected" }] },
      { studios: [{ projectId: "p", status: "failed", error: {} }] },
      { activeRuns: [{ id: "task", projectId: "p" }] },
      { maxStudios: 1.5 },
      { maxStudios: null },
    ]) {
      fixture.set(200, { ok: true, ...invalid });
      const rejected = await probe();
      assert.equal(rejected.ok, false);
      assert.equal(rejected.reachable, true);
    }
    fixture.set(200, { ok: true });
    const legacy = await probe();
    assert.equal(legacy.ok, true);
    assert.deepEqual(legacy.studios, []);
    assert.deepEqual(legacy.activeRuns, []);
    fixture.set(503, {
      ok: false,
      error: "Bearer private-internal-token",
      unexpectedSecret: "discard-me",
      studios: [
        { projectId: "p", status: "failed", error: "private-internal-token" },
      ],
    });
    const sanitized = JSON.stringify(await probe());
    assert(!sanitized.includes("private-internal-token"));
    assert(!sanitized.includes("discard-me"));
  } finally {
    await fixture.close();
  }
  const missing = await probe();
  assert.equal(missing.ok, false);
  assert.equal(missing.reachable, false);
  assert(!JSON.stringify(missing).includes("private-internal-token"));
});

test("health returns the remaining component statuses when the data mount or model lookup fails", async () => {
  const fixture = await serverFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-health-"));
  const built = await buildApp({
    dataRoot: root,
    password: "health-test-password",
    internalToken: "private-internal-token",
    runnerUrl: fixture.url,
    poll: false,
  });
  let moved = false;
  const configuredBlender = process.env.BLENDER_VERSION;
  const login = await built.app.inject({
    url: "/api/auth/login",
    method: "POST",
    payload: { password: "health-test-password" },
  });
  const headers = { cookie: `pilot_session=${login.cookies[0].value}` };
  try {
    process.env.BLENDER_VERSION = "configured-version";
    fixture.set(200, {
      ok: true,
      studios: [
        { projectId: "old", status: "failed", blenderVersion: "old-version" },
        {
          projectId: "live",
          status: "ready",
          blenderVersion: "observed-version",
        },
      ],
      activeRuns: [],
    });
    const originalGet = built.store.get.bind(built.store);
    built.store.get = async (kind: string, id: string) => {
      if (kind === "config") throw new Error("private database diagnostic");
      return originalGet(kind, id);
    };
    await rename(root, root + "-unmounted");
    moved = true;
    const response = await built.app.inject({ url: "/api/health", headers });
    assert.equal(response.statusCode, 200);
    const health = response.json();
    assert.equal(health.app, true);
    assert.equal(health.database.ok, true);
    assert.equal(health.execution.ok, true);
    assert.equal(health.storage.ok, false);
    assert.equal(health.storage.free, undefined);
    assert.equal(health.model.ok, false);
    assert.equal(health.versions.blender, "observed-version");
    assert.equal(health.versionSources.blender, "runtime");
    assert.equal(health.versionSources.codex, "pinned");
    assert(Number.isFinite(Date.parse(health.checkedAt)));
    assert(!response.body.includes("private database diagnostic"));
    built.store.get = originalGet;
    await rename(root + "-unmounted", root);
    moved = false;
    const recovered = (
      await built.app.inject({ url: "/api/health", headers })
    ).json();
    assert.equal(recovered.storage.ok, true);
    assert(recovered.storage.total > 0);
    assert.equal(recovered.model.ok, true);
    fixture.set(200, { ok: true, studios: {}, activeRuns: "bad" });
    const invalidRunnerResponse = await built.app.inject({
      url: "/api/health",
      headers,
    });
    assert.equal(invalidRunnerResponse.statusCode, 200);
    assert.equal(invalidRunnerResponse.json().execution.ok, false);
    assert.equal(invalidRunnerResponse.json().execution.reachable, true);
    assert.equal(invalidRunnerResponse.json().database.ok, true);
  } finally {
    if (configuredBlender === undefined) delete process.env.BLENDER_VERSION;
    else process.env.BLENDER_VERSION = configuredBlender;
    if (moved) await rename(root + "-unmounted", root);
    await built.app.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Runner readiness checks PostgreSQL and preserves project isolation and active receipts during faults", async () => {
  let storageFailure = "";
  let databaseAvailable = true;
  const studios = [
    { projectId: "healthy-project", status: "ready" },
    { projectId: "failed-project", status: "failed" },
  ];
  const pool = {
    stopping: false,
    external: false,
    max: 3,
    history: {
      get storageFailure() {
        return storageFailure;
      },
    },
    studios: new Map(),
    status: () => studios,
  } as unknown as StudioPool;
  const database = {
    health: async () => {
      if (!databaseAvailable) throw new Error("private database URL");
      return {
        ok: true,
        engine: "PostgreSQL",
        version: "18.6",
        schema: "public",
      };
    },
  };
  const probe = () =>
    collectRunnerHealth(pool, database, [
      {
        id: "running",
        projectId: "healthy-project",
        sessionId: "session",
        status: "running",
      },
      {
        id: "complete",
        projectId: "failed-project",
        sessionId: "session",
        status: "succeeded",
      },
    ]);
  const healthy = await probe();
  assert.equal(healthy.ok, true); // One faulty studio does not disable the others.
  assert.equal(healthy.blender, true);
  assert.equal(healthy.activeRuns.length, 1);
  databaseAvailable = false;
  const lostDatabase = await probe();
  assert.equal(lostDatabase.ok, false);
  assert.equal(lostDatabase.database.ok, false);
  assert.equal(lostDatabase.error, "执行服务无法连接 PostgreSQL");
  assert.deepEqual(lostDatabase.studios, studios);
  assert.equal(lostDatabase.activeRuns[0].id, "running");
  assert(!JSON.stringify(lostDatabase).includes("private database URL"));
  databaseAvailable = true;
  storageFailure = "journal unavailable";
  const storageFault = await probe();
  assert.equal(storageFault.ok, false);
  assert(storageFault.error?.includes("执行事件存储不可用"));
  storageFailure = "";
  assert.equal((await probe()).ok, true);
  pool.stopping = true;
  assert.equal((await probe()).ok, false);
});
