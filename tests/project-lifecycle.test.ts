import "./database-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../apps/server/app.js";

test("project create retries persist, renamed project survives replay, conflicting receipt is rejected", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "pilot-project-life-"));
  const options = {
    dataRoot,
    password: "test-password-1234",
    internalToken: "test-internal-token-123456789",
    runnerUrl: "http://127.0.0.1:1",
    poll: false,
  };
  let app = (await buildApp(options)).app;
  const login = async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: options.password },
    });
    return { cookie: `pilot_session=${r.cookies[0].value}` };
  };
  try {
    let headers = await login();
    const requestId = randomUUID();
    const create = () =>
      app.inject({
        method: "POST",
        url: "/api/projects",
        headers,
        payload: { name: "  Scene one  ", requestId },
      });
    const results = await Promise.all([create(), create(), create()]);
    assert.ok(results.every((r) => r.statusCode === 200));
    const id = results[0].json().id;
    assert.ok(results.every((r) => r.json().id === id));
    assert.equal(
      (await app.inject({ url: "/api/projects", headers })).json().length,
      1,
    );
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      headers,
      payload: { name: " 新名称 " },
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().name, "新名称");
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/projects/${id}`,
          headers,
          payload: { name: "   " },
        })
      ).statusCode,
      400,
    );
    await app.close();
    app = (await buildApp(options)).app;
    headers = await login();
    const replay = await create();
    assert.equal(replay.json().id, id);
    assert.equal(replay.json().name, "新名称");
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/projects",
          headers,
          payload: { name: "other", requestId },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await app.inject({ url: "/api/projects", headers })).json().length,
      1,
    );
  } finally {
    await app.close();
  }
});
