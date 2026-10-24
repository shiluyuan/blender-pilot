import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { verifyReadiness } from "../scripts/verify-readiness.js";

test("installed-instance readiness preserves settings, scenes and other sessions, and filters credentials", async () => {
  const app = Fastify();
  const calls: string[] = [];
  const password = "private-workspace-password";
  const providerSecret = "provider-secret-not-for-report";
  const health = {
    app: true,
    database: { ok: true, engine: "PostgreSQL", version: "18.6" },
    execution: {
      ok: true,
      studios: [{ status: "ready" }],
      activeRuns: [{ id: "busy-task" }],
    },
    storage: { free: 5 * 1024 ** 3 },
    model: {
      hasKey: true,
      model: "configured-model",
      baseUrl: "https://example.invalid",
      apiKey: providerSecret,
    },
    versions: {
      app: "0.1.0",
      codex: "0.164.0",
      mcp: "2.2.2",
      blender: "5.2.3",
      unexpected: providerSecret,
    },
  };
  app.addHook("onRequest", async (request) => {
    calls.push(`${request.method} ${request.url}`);
  });
  app.get("/api/ready", async () => ({ ok: true }));
  app.post("/api/auth/login", async (request, reply) => {
    assert.equal((request.body as any).password, password);
    reply.header(
      "set-cookie",
      "pilot_session=independent-check-session; HttpOnly",
    );
    return { ok: true };
  });
  app.get("/api/auth/status", async () => ({ authenticated: true }));
  app.get("/api/health", async () => health);
  app.post("/api/auth/logout", async (request) => {
    assert.equal(
      request.headers.cookie,
      "pilot_session=independent-check-session",
    );
    return { ok: true };
  });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const report = await verifyReadiness({ baseUrl, password });
    assert(report.passed);
    assert.equal(report.observed.activeTasks, 1);
    assert.equal(report.observed.readyStudios, 1);
    assert(!JSON.stringify(report).includes(password));
    assert(!JSON.stringify(report).includes(providerSecret));
    assert.deepEqual(
      calls.filter((call) => !call.startsWith("GET ")),
      ["POST /api/auth/login", "POST /api/auth/logout"],
    );
    assert.equal(health.model.apiKey, providerSecret); // No settings replacement to test a live service.
  } finally {
    await app.close();
  }
});

test("readiness fails on missing model, full disk and faulty studios without mutating them", async () => {
  const app = Fastify();
  app.get("/api/ready", async () => ({ ok: true }));
  app.post("/api/auth/login", async (_request, reply) =>
    reply.header("set-cookie", "pilot_session=check").send({ ok: true }),
  );
  app.get("/api/auth/status", async () => ({ authenticated: true }));
  app.get("/api/health", async () => ({
    app: true,
    database: { ok: true, engine: "PostgreSQL" },
    execution: {
      ok: true,
      studios: [
        { status: "failed", error: "private path omitted from report" },
      ],
    },
    storage: { free: 1 },
    model: { hasKey: false },
  }));
  app.post("/api/auth/logout", async () => ({ ok: true }));
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const report = await verifyReadiness({ baseUrl, password: "test" });
    assert(!report.passed);
    assert.deepEqual(
      report.checks.filter((item) => !item.passed).map((item) => item.name),
      ["studio-failures", "free-storage", "model-configured"],
    );
  } finally {
    await app.close();
  }
});
