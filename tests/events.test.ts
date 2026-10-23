import "./database-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../apps/server/app.js";
import { Jobs } from "../apps/runner/jobs.js";
import { SceneBridge } from "../packages/blender-bridge/scene.js";

test("SSE streams persisted events and resumes without duplicate sequences", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pilot-events-"));
  const { app, store } = await buildApp({
    dataRoot: dir,
    password: "event-test-password",
    internalToken: "test-internal-token-123456789",
    runnerUrl: "http://127.0.0.1:1",
    poll: false,
  });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "event-test-password" },
    });
    const headers = { cookie: "pilot_session=" + login.cookies[0].value };
    const run = {
      id: "run-test",
      projectId: "p",
      sessionId: "s",
      status: "running",
    };
    await store.put("project", "p", { id: "p", name: "Event project" });
    await store.put("session", "s", {
      id: "s",
      projectId: "p",
      title: "Events",
    });
    await store.put("run", run.id, run);
    await store.event({
      runId: run.id,
      seq: 1,
      type: "message.delta",
      payload: { delta: "hello" },
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(address + "/api/runs/run-test/events", {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    const reader = response.body!.getReader();
    let content = "";
    content += new TextDecoder().decode((await reader.read()).value);
    await store.event({
      runId: run.id,
      seq: 2,
      type: "run.status",
      payload: { status: "succeeded" },
    });
    await store.put("run", run.id, { ...run, status: "succeeded" });
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      content += new TextDecoder().decode(r.value);
    }
    assert(content.includes("id: 1"));
    assert(content.includes("id: 2"));
    assert(content.includes("event: done"));
    const resumed = await fetch(address + "/api/runs/run-test/events", {
      headers: { ...headers, "Last-Event-ID": "1" },
      signal: AbortSignal.timeout(5000),
    });
    const text = await resumed.text();
    assert(!text.includes("id: 1"));
    assert(text.includes("id: 2"));
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runner restart marks unfinished tasks interrupted without executing them", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pilot-restart-"));
  await mkdir(path.join(dir, "jobs"));
  await writeFile(
    path.join(dir, "jobs", "lost.json"),
    JSON.stringify({
      id: "lost",
      projectId: "p",
      sessionId: "s",
      status: "running",
      verification: "pending",
      seq: 2,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    }),
  );
  await writeFile(
    path.join(dir, "jobs", "lost.ndjson"),
    '{"runId":"lost","seq":2,"type":"run.status","payload":{"status":"running"}}\n{partial',
  );
  try {
    const jobs = new Jobs(dir, new SceneBridge(dir));
    await jobs.init();
    assert.equal(jobs.states.get("lost")?.status, "interrupted");
    assert.equal(jobs.active, undefined);
    assert.equal(jobs.events.get("lost")?.at(-1)?.seq, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("completion remains running until final events are durable; late cancel cannot strand state", async () => {
  const jobs = new Jobs("/unused", new SceneBridge("/unused"));
  const state = {
    id: "finishing",
    projectId: "p",
    sessionId: "s",
    status: "succeeded" as const,
    verification: "passed",
    seq: 5,
    createdAt: "now",
    updatedAt: "now",
  };
  jobs.states.set(state.id, state);
  jobs.active = {
    state,
    input: {} as any,
    token: "test",
    abort: new AbortController(),
    captures: [],
    mutations: 1,
    calls: 1,
  };
  assert.equal(jobs.get(state.id)?.status, "running");
  await jobs.cancel(state.id);
  assert.equal(state.status, "succeeded");
  assert.equal(jobs.active.abort.signal.aborted, false);
  jobs.active = undefined;
  assert.equal(jobs.get(state.id)?.status, "succeeded");
});
