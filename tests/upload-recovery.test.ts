import "./database-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { buildApp } from "../apps/server/app.js";
test("completed file uploads recover from database failure without losing chunks or duplicating library assets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-recovery-"));
  const { app, store } = await buildApp({
    dataRoot: root,
    password: "recovery-password-123",
    internalToken: "recovery-internal-token-123456789",
    runnerUrl: "http://127.0.0.1:1",
    poll: false,
  });
  try {
    const auth = (
      await app.inject({
        url: "/api/auth/login",
        method: "POST",
        payload: { password: "recovery-password-123" },
      })
    ).cookies[0].value;
    const call = (
      url: string,
      payload: any,
      method: any = "POST",
      extra = {},
    ) =>
      app.inject({
        url: "/api" + url,
        method,
        payload,
        headers: { cookie: "pilot_session=" + auth, ...extra },
      });
    const image = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "#112233" },
    })
      .png()
      .toBuffer();
    const project = (await call("/projects", { name: "Recovery" })).json();
    const start = async (destination: string) => {
      const u = (
        await call("/uploads", {
          destination,
          projectId: destination === "project" ? project.id : undefined,
          name: "recovery.png",
          size: image.length,
        })
      ).json();
      await call(`/uploads/${u.id}`, image, "PATCH", {
        "content-type": "application/octet-stream",
        "upload-offset": "0",
      });
      return u;
    };
    const u = await start("project"),
      originalTx = store.db.transaction.bind(store.db);
    let fail = true;
    store.db.transaction = async (fn: any) => {
      if (fail) {
        fail = false;
        throw new Error("injected database outage before upload commit");
      }
      return originalTx(fn);
    };
    assert.equal((await call(`/uploads/${u.id}/complete`, {})).statusCode, 500);
    assert.notEqual((await store.get<any>("upload", u.id)).completed, true);
    assert.equal(
      (await stat((await store.get<any>("upload", u.id)).path)).size,
      image.length,
    );
    const completed = await call(`/uploads/${u.id}/complete`, {});
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.json().id, u.id);
    assert.equal((await store.list("asset", project.id)).length, 1);
    store.db.transaction = originalTx;
    const global = await start("library"),
      put = store.put.bind(store);
    let rejectMarker = true;
    store.put = async (kind: string, id: string, data: any, tx?: any) => {
      if (kind === "upload" && data.completed && rejectMarker) {
        rejectMarker = false;
        throw new Error("injected failure after library commit");
      }
      return put(kind, id, data, tx);
    };
    assert.equal(
      (await call(`/uploads/${global.id}/complete`, {})).statusCode,
      500,
    );
    assert.equal((await call("/library", undefined, "GET")).json().total, 1);
    const recovered = await call(`/uploads/${global.id}/complete`, {});
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.json().id, global.id);
    assert.equal((await call("/library", undefined, "GET")).json().total, 1);
    assert.equal((await store.get<any>("upload", global.id)).completed, true);
    store.put = put;
    const health = store.db.health.bind(store.db);
    store.db.health = async () => {
      throw new Error("injected database readiness outage");
    };
    assert.equal((await call("/ready", undefined, "GET")).statusCode, 503);
    const degraded = await call("/health", undefined, "GET");
    assert.equal(degraded.statusCode, 200);
    assert.equal(degraded.json().database.ok, false);
    store.db.health = health;
    assert.equal((await call("/ready", undefined, "GET")).statusCode, 200);
  } finally {
    await app.close();
  }
});
