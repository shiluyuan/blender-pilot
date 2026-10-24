import "./database-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildApp } from "../apps/server/app.js";
import { StartupJobs } from "../apps/runner/dispatch.js";
import { Jobs } from "../apps/runner/jobs.js";
import { SceneBridge } from "../packages/blender-bridge/scene.js";
import type { StudioPool } from "../apps/runner/pool.js";
import type { PilotEvent, StartJob } from "../packages/contracts/index.js";

type Response = { status?: number; data: unknown };
async function wait(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5000,
) {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(label);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture(
  handler: (url: string, body: any) => Response | Promise<Response>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-release-"));
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : undefined;
      try {
        const result = await handler(req.url!, body);
        if (!res.destroyed) {
          res.writeHead(result.status || 200, {
            "content-type": "application/json",
          });
          res.end(JSON.stringify(result.data));
        }
      } catch (error: any) {
        if (!res.destroyed) {
          res.writeHead(error.statusCode || 500, {
            "content-type": "application/json",
          });
          res.end(JSON.stringify({ error: String(error) }));
        }
      }
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const options = {
    dataRoot: root,
    databaseSchema: "pilot_release_" + randomUUID().replaceAll("-", ""),
    runnerUrl: `http://127.0.0.1:${(server.address() as any).port}`,
    password: "release-scenario-password",
    internalToken: "release-scenario-token",
    poll: false,
  };
  let built = await buildApp(options);
  const login = await built.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { password: options.password },
  });
  const headers = { cookie: "pilot_session=" + login.cookies[0].value };
  return {
    root,
    headers,
    get app() {
      return built.app;
    },
    get store() {
      return built.store;
    },
    sync: () => built.sync(),
    restart: async () => {
      await built.app.close();
      built = await buildApp(options);
    },
    seed: async () => {
      const project = (
        await built.app.inject({
          method: "POST",
          url: "/api/projects",
          headers,
          payload: { name: "release-" + randomUUID() },
        })
      ).json();
      const session = (
        await built.app.inject({
          method: "POST",
          url: `/api/projects/${project.id}/sessions`,
          headers,
          payload: {},
        })
      ).json();
      await built.app.inject({
        method: "PUT",
        url: "/api/settings",
        headers,
        payload: {
          baseUrl: "https://fixture.invalid",
          model: "protocol-fixture",
          apiKey: "fixture-key-not-a-real-secret",
        },
      });
      return { project, session };
    },
    close: async () => {
      await built.app.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("unknown worker acknowledgement keeps a project reserved while another project proceeds independently", async () => {
  const jobs = new Map<string, any>();
  let posts = 0;
  const f = await fixture((url, body) => {
    if (url === "/jobs") {
      posts++;
      const remote = {
        id: body.runId,
        projectId: body.projectId,
        sessionId: body.sessionId,
        status: "running",
        seq: 1,
        verification: "pending",
        updatedAt: new Date().toISOString(),
      };
      jobs.set(remote.id, remote);
      return { status: 502, data: { error: "accepted, acknowledgement lost" } };
    }
    const id = url.split("/")[2]?.split("?")[0];
    const remote = jobs.get(id);
    if (!remote) return { status: 404, data: { error: "missing fixture job" } };
    if (url.includes("/events?")) {
      const after = Number(
        new URL(url, "http://worker").searchParams.get("after"),
      );
      return {
        data: Array.from({ length: remote.seq }, (_, index) => ({
          schemaVersion: 1,
          runId: id,
          projectId: remote.projectId,
          sessionId: remote.sessionId,
          seq: index + 1,
          type: "run.status",
          payload: {
            status: index + 1 === remote.seq ? remote.status : "running",
          },
          time: remote.updatedAt,
        })).filter((event) => event.seq > after),
      };
    }
    return { data: remote };
  });
  try {
    const a = await f.seed(),
      b = await f.seed();
    const send = (sid: string, clientRequestId: string) =>
      f.app.inject({
        method: "POST",
        url: `/api/sessions/${sid}/turns`,
        headers: f.headers,
        payload: { text: "检查场景", clientRequestId },
      });
    const [ra, rb] = await Promise.all([
      send(a.session.id, "first-a"),
      send(b.session.id, "first-b"),
    ]);
    assert.equal(ra.statusCode, 200);
    assert.equal(rb.statusCode, 200);
    await wait(
      async () =>
        (await f.store.get<any>("run", ra.json().id))?.error?.includes(
          "提交未能确认",
        ),
      "dispatch error must be durable",
    );
    assert.equal(
      (await f.store.get<any>("run", ra.json().id)).status,
      "queued",
    );
    const otherSession = (
      await f.app.inject({
        method: "POST",
        url: `/api/projects/${a.project.id}/sessions`,
        headers: f.headers,
        payload: {},
      })
    ).json();
    assert.equal(
      (await send(otherSession.id, "new-while-unknown")).statusCode,
      409,
      "same project cannot overtake an uncertain write, even in another session",
    );
    const retry = await send(a.session.id, "first-a");
    assert.equal(retry.json().id, ra.json().id);
    assert.equal(posts, 2);
    await f.sync();
    assert.equal(
      (await f.store.get<any>("run", ra.json().id)).status,
      "running",
    );
    const remote = jobs.get(rb.json().id);
    remote.status = "succeeded";
    remote.seq = 2;
    remote.verification = "passed";
    await f.sync();
    assert.equal(
      (await f.store.get<any>("run", rb.json().id)).status,
      "succeeded",
    );
    assert.equal(
      (await send(b.session.id, "second-b")).statusCode,
      200,
      "a different project's terminal result frees only its own reservation",
    );
    assert.equal((await send(a.session.id, "still-active-a")).statusCode, 409);
  } finally {
    await f.close();
  }
});

test("gateway restart fences a delayed unrecorded worker request before freeing its project", async () => {
  const workerRoot = await mkdtemp(
    path.join(os.tmpdir(), "pilot-release-worker-"),
  );
  const history = new Jobs(workerRoot, new SceneBridge(workerRoot));
  await history.init();
  let starts = 0,
    arrivals = 0,
    completed = 0,
    cancelled = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pool = {
    history,
    byRun: () => history,
    open: async () => ({
      jobs: {
        start: async (_input: StartJob, state: any) => {
          starts++;
          state.status = "running";
          await history.emit(state, "run.status", { status: "running" });
          return state;
        },
      },
    }),
  } as unknown as StudioPool;
  const queue = new StartupJobs(pool);
  const f = await fixture(async (url, body) => {
    if (url === "/jobs") {
      arrivals++;
      if (arrivals === 1) await gate;
      const data = await queue.submit(body);
      completed++;
      return { data };
    }
    const parsed = new URL(url, "http://worker"),
      id = parsed.pathname.split("/")[2];
    if (parsed.pathname.endsWith("/cancel")) {
      cancelled++;
      return { data: await queue.cancel(id, body) };
    }
    if (parsed.pathname.endsWith("/events"))
      return {
        data: (history.events.get(id) || []).filter(
          (event) => event.seq > Number(parsed.searchParams.get("after")),
        ),
      };
    const state = queue.get(id);
    return state
      ? { data: state }
      : {
          status: 404,
          data: { error: "worker has not admitted delayed request" },
        };
  });
  try {
    const { project, session } = await f.seed();
    const send = (request: string) =>
      f.app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/turns`,
        headers: f.headers,
        payload: { text: "创建组件", clientRequestId: request },
      });
    const accepted = await send("delayed-before-gateway-restart");
    assert.equal(accepted.statusCode, 200);
    await wait(() => arrivals === 1, "delayed handler reached worker");
    await f.restart();
    assert.equal(
      (await f.store.get<any>("run", accepted.json().id)).status,
      "queued",
    );
    await f.sync();
    const recovered = await f.store.get<any>("run", accepted.json().id);
    assert.equal(recovered.status, "interrupted");
    assert.match(recovered.error, /已阻止迟到提交/);
    assert.equal(queue.get(accepted.json().id)?.status, "cancelled");
    assert.equal(cancelled, 1);
    assert.equal(starts, 0);
    const finalEvents = await f.store.events(accepted.json().id);
    assert.equal(
      finalEvents.length,
      1,
      "durable tombstone event imported before terminal state",
    );
    release();
    await wait(() => completed >= 1, "old HTTP handler resumes");
    assert.equal(starts, 0, "late original request cannot mutate the scene");
    assert.equal((await send("new-after-confirmed-fence")).statusCode, 200);
    await wait(() => starts === 1, "a deliberate new message starts once");
    assert.equal((await f.store.list<any>("run", project.id)).length, 2);
  } finally {
    release();
    await f.close();
    await queue.shutdown();
    await rm(workerRoot, { recursive: true, force: true });
  }
});

test("cross-project event envelopes and resource payloads are rejected without starving a healthy project", async () => {
  const remotes = new Map<string, { input: any; events: PilotEvent[] }>();
  const f = await fixture((url, body) => {
    if (url === "/jobs") {
      remotes.set(body.runId, { input: body, events: [] });
      return { data: { id: body.runId } };
    }
    const parsed = new URL(url, "http://worker"),
      id = parsed.pathname.split("/")[2],
      remote = remotes.get(id)!;
    if (parsed.pathname.endsWith("/events"))
      return {
        data: remote.events.filter(
          (event) => event.seq > Number(parsed.searchParams.get("after")),
        ),
      };
    return {
      data: {
        id,
        projectId: remote.input.projectId,
        sessionId: remote.input.sessionId,
        status: "succeeded",
        seq: remote.events.length,
        verification: "passed",
        updatedAt: new Date().toISOString(),
      },
    };
  });
  try {
    const a = await f.seed(),
      b = await f.seed();
    const send = (sid: string) =>
      f.app.inject({
        method: "POST",
        url: `/api/sessions/${sid}/turns`,
        headers: f.headers,
        payload: { text: "检查场景", clientRequestId: randomUUID() },
      });
    const ra = (await send(a.session.id)).json(),
      rb = (await send(b.session.id)).json();
    await wait(() => remotes.size === 2, "worker receives both projects");
    const frame = (
      run: any,
      projectId: string,
      sessionId: string,
    ): PilotEvent => ({
      schemaVersion: 1,
      runId: run.id,
      projectId,
      sessionId,
      seq: 1,
      type: "run.status",
      payload: { status: "succeeded" },
      time: new Date().toISOString(),
    });
    remotes.get(ra.id)!.events = [frame(ra, b.project.id, b.session.id)];
    remotes.get(rb.id)!.events = [frame(rb, b.project.id, b.session.id)];
    await f.sync();
    assert.equal((await f.store.get<any>("run", ra.id)).status, "queued");
    assert.equal((await f.store.get<any>("run", rb.id)).status, "succeeded");
    assert.deepEqual(await f.store.events(ra.id), []);
    const invalidResource = frame(ra, a.project.id, a.session.id);
    invalidResource.type = "capture.created";
    invalidResource.payload = {
      capture: {
        id: "wrong-owner-capture",
        projectId: b.project.id,
        path: "/other-project/image.jpg",
      },
    };
    remotes.get(ra.id)!.events = [invalidResource];
    await f.sync();
    assert.equal(
      await f.store.get("capture", "wrong-owner-capture"),
      undefined,
    );
    assert.deepEqual(await f.store.events(ra.id), []);
    remotes.get(ra.id)!.events = [frame(ra, a.project.id, a.session.id)];
    await f.sync();
    assert.equal((await f.store.get<any>("run", ra.id)).status, "succeeded");
    assert.equal((await f.store.events(ra.id)).length, 1);
  } finally {
    await f.close();
  }
});

test("missing project images and captures are rejected before accepting a paid model task", async () => {
  let posts = 0;
  const f = await fixture(() => {
    posts++;
    return { data: {} };
  });
  try {
    const { project, session } = await f.seed();
    const imageId = randomUUID(),
      captureId = randomUUID();
    await f.store.put("asset", imageId, {
      id: imageId,
      projectId: project.id,
      name: "lost-reference.png",
      kind: "reference",
      mime: "image/png",
      path: path.join(
        f.root,
        "projects",
        project.id,
        "assets",
        imageId,
        "source.png",
      ),
      sha256: "fixture",
      size: 123,
      createdAt: new Date().toISOString(),
    });
    await f.store.put("capture", captureId, {
      id: captureId,
      projectId: project.id,
      path: path.join(f.root, "projects", project.id, "captures", "lost.jpg"),
      mime: "image/jpeg",
      createdAt: new Date().toISOString(),
    });
    for (const id of [imageId, captureId]) {
      const response = await f.app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/turns`,
        headers: f.headers,
        payload: {
          text: "根据图片创建模型",
          assetIds: [id],
          clientRequestId: randomUUID(),
        },
      });
      assert.equal(response.statusCode, 409);
      assert.match(response.json().error, /本地文件缺失或不可读/);
    }
    assert.equal(posts, 0);
    assert.deepEqual(await f.store.list("run", project.id), []);
  } finally {
    await f.close();
  }
});

test("a vanished running worker preserves partial mutation receipts and interrupts without replay", async () => {
  const workerRoot = await mkdtemp(
    path.join(os.tmpdir(), "pilot-release-lost-worker-"),
  );
  const history = new Jobs(workerRoot, new SceneBridge(workerRoot));
  await history.init();
  let posts = 0,
    starts = 0;
  const pool = {
    history,
    byRun: () => history,
    open: async () => {
      starts++;
      throw new Error("must not restart an uncertain scene mutation");
    },
  } as unknown as StudioPool;
  const queue = new StartupJobs(pool);
  const f = await fixture(async (url, body) => {
    if (url === "/jobs") {
      posts++;
      return { data: { id: body.runId, status: "running" } };
    }
    const parsed = new URL(url, "http://worker"),
      id = parsed.pathname.split("/")[2];
    if (parsed.pathname.endsWith("/cancel"))
      return { data: await queue.cancel(id, body) };
    if (parsed.pathname.endsWith("/events"))
      return {
        data: (history.events.get(id) || []).filter(
          (event) => event.seq > Number(parsed.searchParams.get("after")),
        ),
      };
    const state = queue.get(id);
    return state
      ? { data: state }
      : {
          status: 404,
          data: {
            error: "simulated worker state loss after partial scene execution",
          },
        };
  });
  try {
    const { project, session } = await f.seed();
    const body = {
      text: "创建组件后继续调整",
      clientRequestId: "partially-executed-message",
    };
    const response = await f.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/turns`,
      headers: f.headers,
      payload: body,
    });
    const run = response.json();
    assert.equal(response.statusCode, 200);
    await wait(() => posts === 1, "worker accepted initial dispatch");
    await f.store.updateRun(run.id, (current) => {
      current.status = "running";
    });
    for (const event of [
      { seq: 1, type: "run.status", payload: { status: "running" } },
      {
        seq: 2,
        type: "tool.started",
        payload: { callId: "partial", name: "execute_blender_code" },
      },
      {
        seq: 3,
        type: "scene.receipt",
        payload: {
          callId: "partial",
          receipt: {
            created: ["Partial_Component"],
            modified: [],
            deleted: [],
          },
        },
      },
    ])
      await f.store.event({
        ...event,
        runId: run.id,
        projectId: project.id,
        sessionId: session.id,
      });
    await wait(async () => {
      await f.sync();
      return (await f.store.get<any>("run", run.id)).status === "interrupted";
    }, "lost running worker is reconciled to interrupted");
    assert.equal(queue.get(run.id)?.status, "cancelled");
    const events = await f.store.events(run.id);
    assert.equal(events.length, 3);
    assert.deepEqual(events[2].payload.receipt.created, ["Partial_Component"]);
    const retry = await f.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/turns`,
      headers: f.headers,
      payload: body,
    });
    assert.equal(retry.json().id, run.id);
    assert.equal(retry.json().status, "interrupted");
    assert.equal(posts, 1);
    assert.equal(starts, 0);
  } finally {
    await f.close();
    await queue.shutdown();
    await rm(workerRoot, { recursive: true, force: true });
  }
});

test("a hung status or event response cannot delay a healthy project or overwrite a concurrent cancellation", async () => {
  for (const stage of ["status", "events"] as const) {
    const remotes = new Map<string, any>();
    let hungId = "",
      waiting = false,
      releases!: () => void,
      activeSync: Promise<void> | undefined;
    const gate = new Promise<void>((resolve) => {
      releases = resolve;
    });
    const f = await fixture(async (url, body) => {
      if (url === "/jobs") {
        remotes.set(body.runId, body);
        return { data: { id: body.runId, status: "running" } };
      }
      const parsed = new URL(url, "http://worker"),
        id = parsed.pathname.split("/")[2],
        input = remotes.get(id);
      if (parsed.pathname.endsWith("/cancel"))
        return { data: { id, status: "cancelling" } };
      const eventRoute = parsed.pathname.endsWith("/events");
      if (id === hungId && eventRoute === (stage === "events")) {
        waiting = true;
        await gate;
      }
      const status = id === hungId ? "running" : "succeeded";
      if (eventRoute)
        return {
          data:
            Number(parsed.searchParams.get("after")) < 1
              ? [
                  {
                    schemaVersion: 1,
                    runId: id,
                    projectId: input.projectId,
                    sessionId: input.sessionId,
                    seq: 1,
                    type: "run.status",
                    payload: { status },
                    time: new Date().toISOString(),
                  },
                ]
              : [],
        };
      return {
        data: {
          id,
          projectId: input.projectId,
          sessionId: input.sessionId,
          status,
          seq: 1,
          verification: status === "succeeded" ? "passed" : "pending",
          updatedAt: new Date().toISOString(),
        },
      };
    });
    try {
      const a = await f.seed(),
        b = await f.seed();
      await Promise.all(
        [a, b].map((owner) =>
          f.app.inject({
            method: "POST",
            url: `/api/sessions/${owner.session.id}/turns`,
            headers: f.headers,
            payload: { text: "检查场景", clientRequestId: randomUUID() },
          }),
        ),
      );
      await wait(
        () => remotes.size === 2,
        "both independent projects were admitted",
      );
      const ordered = await f.store.list<any>("run");
      hungId = ordered[0].id;
      const healthyId = ordered[1].id;
      activeSync = f.sync();
      await wait(() => waiting, "the first project reached its held response");
      await wait(
        async () =>
          (await f.store.get<any>("run", healthyId)).status === "succeeded",
        `healthy project must finish while ${stage} of another project is still held`,
        2000,
      );
      assert.equal((await f.store.get<any>("run", hungId)).status, "queued");
      const cancellation = await f.app.inject({
        method: "POST",
        url: `/api/runs/${hungId}/cancel`,
        headers: f.headers,
        payload: {},
      });
      assert.equal(cancellation.statusCode, 200);
      const intent = (await f.store.get<any>("run", hungId)).cancelRequestedAt;
      assert(intent);
      releases();
      await activeSync;
      const settled = await f.store.get<any>("run", hungId);
      assert.equal(settled.status, "cancelling");
      assert.equal(
        settled.cancelRequestedAt,
        intent,
        "an old running response cannot overwrite new cancellation intent",
      );
    } finally {
      releases();
      await activeSync;
      await f.close();
    }
  }
});

test("read-only worker polling has a short deadline and retains uncertain state for a later recovery", async () => {
  let input: any,
    release!: () => void,
    held = true,
    posts = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(async (url, body) => {
    if (url === "/jobs") {
      posts++;
      input = body;
      return { data: { id: body.runId, status: "running" } };
    }
    const parsed = new URL(url, "http://worker");
    if (!parsed.pathname.endsWith("/events") && held) await gate;
    if (parsed.pathname.endsWith("/events"))
      return {
        data:
          Number(parsed.searchParams.get("after")) < 1
            ? [
                {
                  schemaVersion: 1,
                  runId: input.runId,
                  projectId: input.projectId,
                  sessionId: input.sessionId,
                  seq: 1,
                  type: "run.status",
                  payload: { status: "running" },
                  time: new Date().toISOString(),
                },
              ]
            : [],
      };
    return {
      data: {
        id: input.runId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        status: "running",
        seq: 1,
        verification: "pending",
        updatedAt: new Date().toISOString(),
      },
    };
  });
  try {
    const { session } = await f.seed();
    const accepted = await f.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/turns`,
      headers: f.headers,
      payload: { text: "读取场景", clientRequestId: randomUUID() },
    });
    assert.equal(accepted.statusCode, 200);
    await wait(() => posts === 1, "initial dispatch reaches worker");
    const started = Date.now();
    await f.sync();
    const elapsed = Date.now() - started;
    assert(
      elapsed >= 4500 && elapsed < 10000,
      `status polling must expire around5seconds, saw${elapsed}ms`,
    );
    assert.equal(
      (await f.store.get<any>("run", accepted.json().id)).status,
      "queued",
      "read timeout must not claim success or permit a duplicate write",
    );
    held = false;
    release();
    await f.sync();
    assert.equal(
      (await f.store.get<any>("run", accepted.json().id)).status,
      "running",
    );
    assert.equal(posts, 1);
  } finally {
    held = false;
    release();
    await f.close();
  }
});
