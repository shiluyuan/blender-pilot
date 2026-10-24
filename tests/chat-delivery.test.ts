import "./database-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../apps/server/app.js";
import { StartupJobs } from "../apps/runner/dispatch.js";
import { Jobs } from "../apps/runner/jobs.js";
import { SceneBridge } from "../packages/blender-bridge/scene.js";
import type { StudioPool } from "../apps/runner/pool.js";

async function fixture(
  handler: (
    url: string,
    body: any,
  ) => { status?: number; data: any } | Promise<{ status?: number; data: any }>,
) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : undefined;
    const result = await handler(req.url!, body);
    res.writeHead(result.status || 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.data));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${(server.address() as any).port}`;
  const dir = await mkdtemp(path.join(os.tmpdir(), "pilot-chat-delivery-"));
  const built = await buildApp({
    dataRoot: dir,
    password: "chat-delivery-password",
    internalToken: "chat-delivery-internal-token",
    runnerUrl: address,
    poll: false,
  });
  const login = await built.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { password: "chat-delivery-password" },
  });
  const headers = { cookie: "pilot_session=" + login.cookies[0].value };
  return {
    ...built,
    headers,
    close: async () => {
      await built.app.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("accepted sends survive an unknown runner acknowledgement; retries are idempotent and reject changed content", async () => {
  let submissions = 0;
  let remote: any;
  const f = await fixture((url, body) => {
    if (url === "/jobs") {
      submissions++;
      remote = {
        id: body.runId,
        status: "running",
        verification: "pending",
        seq: 1,
        updatedAt: new Date().toISOString(),
      };
      // The worker accepted the job, but its HTTP acknowledgement was lost.
      return { status: 502, data: { error: "simulated acknowledgement loss" } };
    }
    if (url.includes("/events?"))
      return {
        data: [
          {
            runId: remote.id,
            seq: 1,
            type: "run.status",
            payload: { status: "running" },
          },
        ],
      };
    return { data: remote };
  });
  try {
    const { app, store, headers } = f;
    await store.put("project", "delivery-p", {
      id: "delivery-p",
      name: "Delivery",
    });
    await store.put("session", "delivery-s", {
      id: "delivery-s",
      projectId: "delivery-p",
      title: "Delivery",
    });
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers,
      payload: {
        baseUrl: "https://example.invalid",
        model: "protocol-test",
        apiKey: "synthetic-test-key",
      },
    });
    const payload = {
      text: "创建蓝色立方体",
      assetIds: [],
      libraryAssetIds: [],
      clientRequestId: "stable-message",
    };
    const send = (body: any) =>
      app.inject({
        method: "POST",
        url: "/api/sessions/delivery-s/turns",
        headers,
        payload: body,
      });
    const first = await send(payload);
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().status, "queued");
    const until = Date.now() + 5000;
    while (
      (await store.get<any>("run", first.json().id)).status !== "interrupted"
    ) {
      if (Date.now() > until)
        throw new Error("Background dispatch did not settle");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(first.json().clientRequestId, payload.clientRequestId);
    const recovered = await app.inject({
      url: "/api/sessions/delivery-s/requests/stable-message",
      headers,
    });
    assert.equal(recovered.json().run.id, first.json().id);
    const [retryA, retryB] = await Promise.all([
      send(payload),
      send({ ...payload, text: "  创建蓝色立方体  " }),
    ]);
    assert.equal(retryA.json().id, first.json().id);
    assert.equal(retryB.json().id, first.json().id);
    assert.equal(submissions, 1);
    const changed = await send({ ...payload, text: "创建红色球体" });
    assert.equal(changed.statusCode, 409);
    const attachmentsChanged = await send({
      ...payload,
      assetIds: ["another-attachment"],
    });
    assert.equal(attachmentsChanged.statusCode, 409);
    assert.equal(submissions, 1);
    assert.equal((await store.list("run", "delivery-p")).length, 1);
    await f.sync();
    assert.equal(
      (await store.get<any>("run", first.json().id)).status,
      "running",
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/sessions/delivery-s/requests/unknown",
          headers,
        })
      ).json().run,
      null,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/sessions/delivery-s/requests/stable-message",
        })
      ).statusCode,
      401,
    );
    // A terminal cancellation retry needs no surviving worker process.
    await store.put("run", remote.id, {
      ...first.json<any>(),
      status: "cancelled",
    });
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/runs/${remote.id}/cancel`,
          headers,
          payload: {},
        })
      ).json().status,
      "cancelled",
    );
  } finally {
    await f.close();
  }
});

test("API accepts immediately and a stop that overtakes delayed worker admission prevents all scene execution", async () => {
  const workerDir = await mkdtemp(
    path.join(os.tmpdir(), "pilot-worker-admission-"),
  );
  const history = new Jobs(workerDir, new SceneBridge(workerDir));
  await history.init();
  let release!: () => void;
  const admission = new Promise<void>((resolve) => {
    release = resolve;
  });
  let posts = 0,
    completedPosts = 0,
    opens = 0,
    starts = 0;
  const pool = {
    history,
    byRun: () => history,
    open: async () => {
      opens++;
      return {
        jobs: {
          start: async () => {
            starts++;
          },
        },
      };
    },
  } as unknown as StudioPool;
  const queue = new StartupJobs(pool);
  const f = await fixture(async (url, body) => {
    if (url === "/jobs") {
      posts++;
      await admission;
      const data = await queue.submit(body);
      completedPosts++;
      return { data };
    }
    const parsed = new URL(url, "http://runner");
    const id = parsed.pathname.split("/")[2];
    if (parsed.pathname.endsWith("/cancel"))
      return { data: await queue.cancel(id, body) };
    if (parsed.pathname.endsWith("/events"))
      return {
        data: (history.events.get(id) || []).filter(
          (e) => e.seq > Number(parsed.searchParams.get("after")),
        ),
      };
    const state = queue.get(id);
    return state
      ? { data: state }
      : { status: 404, data: { error: "任务不存在" } };
  });
  try {
    await f.store.put("project", "admit-p", {
      id: "admit-p",
      name: "Admission",
    });
    await f.store.put("session", "admit-s", {
      id: "admit-s",
      projectId: "admit-p",
      title: "Admission",
    });
    await f.app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: f.headers,
      payload: {
        baseUrl: "https://example.invalid",
        model: "fixture",
        apiKey: "synthetic-key",
      },
    });
    const accepted = await Promise.race([
      f.app.inject({
        method: "POST",
        url: "/api/sessions/admit-s/turns",
        headers: f.headers,
        payload: { text: "创建场景", clientRequestId: "admit-message" },
      }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Admission waited for worker startup")),
          3000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().status, "queued");
    const runId = accepted.json().id;
    const cancelled = await f.app.inject({
      method: "POST",
      url: `/api/runs/${runId}/cancel`,
      headers: f.headers,
      payload: {},
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().status, "cancelling");
    await f.sync();
    assert.equal((await f.store.get<any>("run", runId)).status, "cancelled");
    assert.ok((await f.store.get<any>("run", runId)).cancelRequestedAt);
    release();
    const until = Date.now() + 3000;
    while (!completedPosts) {
      if (Date.now() > until) throw new Error("Worker dispatch never arrived");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await queue.shutdown();
    assert.equal(opens, 0);
    assert.equal(starts, 0);
    assert.equal(queue.get(runId)?.status, "cancelled");
    const retry = await f.app.inject({
      method: "POST",
      url: "/api/sessions/admit-s/turns",
      headers: f.headers,
      payload: { text: "创建场景", clientRequestId: "admit-message" },
    });
    assert.equal(retry.json().id, runId);
    assert.equal(retry.json().status, "cancelled");
  } finally {
    release();
    await f.close();
    await queue.shutdown();
    await rm(workerDir, { recursive: true, force: true });
  }
});

test("paginated event synchronization waits for every final event and SSE resumes through more than 500 events", async () => {
  const runId = "history-run";
  const allEvents = Array.from({ length: 1207 }, (_, i) => ({
    schemaVersion: 1,
    runId,
    seq: i + 1,
    type: i === 1206 ? "run.status" : "message.delta",
    payload:
      i === 1206 ? { status: "succeeded" } : { itemId: "m", delta: String(i) },
    time: new Date().toISOString(),
  }));
  let available = 1200;
  const requestedCursors: number[] = [];
  const f = await fixture((url) => {
    if (url.includes("/events?")) {
      const query = new URL(url, "http://runner").searchParams;
      const after = Number(query.get("after"));
      requestedCursors.push(after);
      return {
        data: allEvents.slice(
          after,
          Math.min(available, after + Number(query.get("limit"))),
        ),
      };
    }
    return {
      data: {
        id: runId,
        status: "succeeded",
        verification: "passed",
        seq: allEvents.length,
        updatedAt: new Date().toISOString(),
      },
    };
  });
  try {
    const { app, store, headers } = f;
    await store.put("project", "history-p", {
      id: "history-p",
      name: "History",
    });
    await store.put("session", "history-s", {
      id: "history-s",
      projectId: "history-p",
      title: "History",
    });
    await store.put("run", runId, {
      id: runId,
      projectId: "history-p",
      sessionId: "history-s",
      status: "running",
    });
    await f.sync();
    assert.equal(
      (await store.get<any>("run", runId)).status,
      "running",
      "terminal state must wait for advertised tail",
    );
    assert.equal(await store.latestSequence(runId), 1200);
    available = allEvents.length;
    await f.sync();
    assert.equal((await store.get<any>("run", runId)).status, "succeeded");
    assert.equal((await store.events(runId)).length, allEvents.length);
    assert.deepEqual(requestedCursors, [0, 500, 1000, 1200, 1200]);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(address + `/api/runs/${runId}/events`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    const seqs = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    assert.deepEqual(
      seqs,
      allEvents.map((e) => e.seq),
    );
    assert.ok(text.indexOf("id: 1207") < text.indexOf("event: done"));
    const resume = await fetch(address + `/api/runs/${runId}/events?after=0`, {
      headers: { ...headers, "Last-Event-ID": "750" },
      signal: AbortSignal.timeout(15000),
    });
    const resumed = await resume.text();
    assert.deepEqual(
      [...resumed.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])),
      allEvents.slice(750).map((e) => e.seq),
    );
  } finally {
    await f.close();
  }
});
