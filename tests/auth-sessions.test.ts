import "./database-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../apps/server/db.js";
import { Vault } from "../apps/server/security.js";
import { AuthSessions } from "../apps/server/auth-sessions.js";
import { buildApp } from "../apps/server/app.js";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-auth-"));
  const store = new Store(root);
  await store.init();
  const vault = new Vault(path.join(root, "config"));
  await vault.init();
  const auth = new AuthSessions(store.db, vault);
  return {
    root,
    store,
    vault,
    auth,
    close: async () => {
      auth.close();
      await store.db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("same-millisecond logins have unique nonces, and unregistered legacy signatures require login", async () => {
  const f = await fixture();
  try {
    const realNow = Date.now,
      fixed = realNow();
    let first: string, second: string;
    try {
      Date.now = () => fixed;
      first = f.vault.session();
      second = f.vault.session();
    } finally {
      Date.now = realNow;
    }
    assert.notEqual(first, second);
    assert.equal(f.vault.expiresAt(first), f.vault.expiresAt(second));
    assert(f.vault.valid(first));
    assert.equal(await f.auth.valid(first), false);
    const payload = String(Date.now() + 86400000);
    const legacy =
      payload +
      "." +
      createHmac("sha256", f.vault.key).update(payload).digest("hex");
    assert(f.vault.valid(legacy));
    assert.equal(await f.auth.valid(legacy), false);
    assert.equal(f.vault.valid(first + ".extra"), false);
    const token = await f.auth.create();
    assert(await f.auth.valid(token));
    const row = (
      await f.store.db.query(
        `SELECT * FROM ${f.store.db.table("auth_sessions")} WHERE token_hash=$1`,
        [f.auth.hash(token)],
      )
    ).rows[0];
    assert(row && !JSON.stringify(row).includes(token));
  } finally {
    await f.close();
  }
});

test("logout revocation survives registry and database reconnect without invalidating another login or vault data", async () => {
  const f = await fixture();
  let reopened: Store | undefined;
  try {
    const encrypted = f.vault.encrypt("fixture-model-secret");
    const first = await f.auth.create(),
      second = await f.auth.create();
    let closed = 0;
    const unwatch = f.auth.watch(first, () => closed++);
    await f.auth.revoke(first);
    assert.equal(closed, 1);
    assert.equal(await f.auth.valid(first), false);
    assert(await f.auth.valid(second));
    unwatch();
    f.auth.close();
    await f.store.db.close();
    reopened = new Store(f.root);
    await reopened.init();
    const freshVault = new Vault(path.join(f.root, "config"));
    await freshVault.init();
    const freshAuth = new AuthSessions(reopened.db, freshVault);
    assert.equal(await freshAuth.valid(first), false);
    assert(await freshAuth.valid(second));
    assert.equal(freshVault.decrypt(encrypted), "fixture-model-secret");
    freshAuth.close();
  } finally {
    f.auth.close();
    await reopened?.db.close();
    if (!reopened) await f.store.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("database expiration closes existing authenticated watchers and watcher removal prevents callbacks", async () => {
  const f = await fixture();
  try {
    const token = await f.auth.create();
    let ended = 0;
    const stoppedToken = await f.auth.create();
    const stop = f.auth.watch(stoppedToken, () =>
      assert.fail("removed watcher called"),
    );
    stop();
    const endedPromise = new Promise<void>((resolve) =>
      f.auth.watch(token, () => {
        ended++;
        resolve();
      }),
    );
    await f.store.db.query(
      `UPDATE ${f.store.db.table("auth_sessions")} SET expires_at=now()-interval '1 second' WHERE token_hash=$1`,
      [f.auth.hash(token)],
    );
    await Promise.race([
      endedPromise,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("session watcher did not expire")),
          3000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(ended, 1);
    assert.equal(await f.auth.valid(token), false);
    await f.auth.revoke(stoppedToken);
    const live = await f.auth.create();
    f.auth.close();
    assert.equal(await f.auth.valid(live), false);
    await assert.rejects(f.auth.create(), /认证服务正在关闭/);
    await new Promise<void>((resolve) => f.auth.watch(live, resolve));
  } finally {
    await f.close();
  }
});

async function login(app: Awaited<ReturnType<typeof buildApp>>["app"]) {
  const result = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { password: "auth-integration-password" },
  });
  assert.equal(result.statusCode, 200);
  return { cookie: "pilot_session=" + result.cookies[0].value };
}
async function runFixture(store: Store) {
  await store.put("project", "auth-project", {
    id: "auth-project",
    name: "Auth fixture",
  });
  await store.put("session", "auth-conversation", {
    id: "auth-conversation",
    projectId: "auth-project",
    title: "Fixture",
  });
  await store.put("run", "auth-run", {
    id: "auth-run",
    projectId: "auth-project",
    sessionId: "auth-conversation",
    status: "running",
    verification: "pending",
  });
  await store.event({
    schemaVersion: 1,
    runId: "auth-run",
    seq: 1,
    type: "message.delta",
    payload: { delta: "before-auth-expiry" },
    time: new Date().toISOString(),
  });
}
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
) {
  let text = "";
  while (!text.includes(marker)) {
    const next = await reader.read();
    if (next.done) throw new Error("SSE ended before " + marker);
    text += new TextDecoder().decode(next.value);
  }
  return text;
}
async function drain(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let text = "";
  while (true) {
    const next = await reader.read();
    if (next.done) return text;
    text += new TextDecoder().decode(next.value);
  }
}

test("HTTP logout revokes only its login, terminates SSE and remains revoked after gateway rebuild", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-auth-http-"));
  const options = {
    dataRoot: root,
    databaseSchema: "auth_http_" + randomUUID().replaceAll("-", ""),
    password: "auth-integration-password",
    internalToken: "auth-fixture-internal-token",
    runnerUrl: "http://127.0.0.1:1",
    poll: false,
  };
  let built = await buildApp(options);
  try {
    const first = await login(built.app),
      second = await login(built.app);
    await runFixture(built.store);
    await built.app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: first,
      payload: {
        baseUrl: "https://example.invalid",
        model: "auth-model-fixture",
        apiKey: "fixture-model-secret",
        effort: "low",
      },
    });
    const address = await built.app.listen({ host: "127.0.0.1", port: 0 });
    const stream = await fetch(address + "/api/runs/auth-run/events", {
      headers: first,
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    await readUntil(reader, "before-auth-expiry");
    const logout = await built.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: first,
    });
    assert.equal(logout.statusCode, 200);
    await built.store.event({
      schemaVersion: 1,
      runId: "auth-run",
      seq: 2,
      type: "message.delta",
      payload: { delta: "must-not-stream-after-logout" },
      time: new Date().toISOString(),
    });
    const tail = await drain(reader);
    assert(tail.includes("auth.expired"));
    assert(!tail.includes("must-not-stream-after-logout"));
    assert.equal(
      (await built.app.inject({ url: "/api/projects", headers: first }))
        .statusCode,
      401,
    );
    assert.equal(
      (await built.app.inject({ url: "/api/projects", headers: second }))
        .statusCode,
      200,
    );
    await built.app.close();
    built = await buildApp(options);
    assert.deepEqual(
      (
        await built.app.inject({ url: "/api/auth/status", headers: first })
      ).json(),
      { authenticated: false },
    );
    assert.equal(
      (await built.app.inject({ url: "/api/projects", headers: first }))
        .statusCode,
      401,
    );
    assert.equal(
      (await built.app.inject({ url: "/api/projects", headers: second }))
        .statusCode,
      200,
    );
    assert.equal(
      (await built.app.inject({ url: "/api/settings", headers: second })).json()
        .hasKey,
      true,
    );
    const third = await login(built.app);
    assert.equal(
      (await built.app.inject({ url: "/api/projects", headers: third }))
        .statusCode,
      200,
    );
  } finally {
    await built.app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("expiry after opening SSE and desktop closes both, rejects replay and allows a new login", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-auth-stream-"));
  const runner = createServer();
  const remote = new WebSocketServer({ server: runner });
  remote.on("connection", (socket) => {
    socket.send("fixture-desktop");
    socket.on("message", (data) => socket.send(data));
  });
  await new Promise<void>((resolve) => runner.listen(0, "127.0.0.1", resolve));
  const runnerUrl = `http://127.0.0.1:${(runner.address() as any).port}`;
  const { app, store } = await buildApp({
    dataRoot: root,
    databaseSchema: "auth_stream_" + randomUUID().replaceAll("-", ""),
    password: "auth-integration-password",
    internalToken: "auth-fixture-internal-token",
    runnerUrl,
    poll: false,
  });
  const clients: WebSocket[] = [];
  try {
    await runFixture(store);
    const headers = await login(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const open = (cookie: { cookie: string }) =>
      new Promise<WebSocket>((resolve, reject) => {
        const client = new WebSocket(
          address.replace(/^http/, "ws") + "/desktop?projectId=auth-project",
          { headers: { ...cookie, origin: address } },
        );
        clients.push(client);
        client.once("error", reject);
        client.once("message", () => resolve(client));
      });
    const desktop = await open(headers);
    const closed = new Promise<number>((resolve) =>
      desktop.once("close", (code) => resolve(code)),
    );
    const response = await fetch(address + "/api/runs/auth-run/events", {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    const reader = response.body!.getReader();
    await readUntil(reader, "before-auth-expiry");
    const token = headers.cookie.slice("pilot_session=".length);
    await store.db.query(
      `UPDATE ${store.db.table("auth_sessions")} SET expires_at=now()-interval '1 second' WHERE token_hash=$1`,
      [createHash("sha256").update(token).digest("hex")],
    );
    const code = await Promise.race([
      closed,
      new Promise<never>((_r, reject) => {
        const timer = setTimeout(
          () => reject(new Error("desktop did not expire")),
          4000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(code, 1008);
    await store.event({
      schemaVersion: 1,
      runId: "auth-run",
      seq: 2,
      type: "message.delta",
      payload: { delta: "must-not-stream-after-expiry" },
      time: new Date().toISOString(),
    });
    const tail = await drain(reader);
    assert(tail.includes("auth.expired"));
    assert(!tail.includes("must-not-stream-after-expiry"));
    assert.equal(
      (await app.inject({ url: "/api/projects", headers })).statusCode,
      401,
    );
    await assert.rejects(open(headers));
    const next = await login(app);
    assert.equal(
      (await app.inject({ url: "/api/projects", headers: next })).statusCode,
      200,
    );
    await open(next);
    await app.close(); // Also proves active transport authentication timers are cleaned.
  } finally {
    for (const client of clients) client.terminate();
    await app.close();
    for (const client of remote.clients) client.terminate();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
    await new Promise<void>((resolve) => runner.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
