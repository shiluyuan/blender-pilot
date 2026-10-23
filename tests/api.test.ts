import "./database-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { buildApp } from "../apps/server/app.js";
test("authenticated API: settings, project, resumable upload, isolation and persistence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-api-"));
  const options = {
    dataRoot: root,
    password: "test-password-1234",
    internalToken: "test-internal-token-123456789",
    runnerUrl: "http://127.0.0.1:1",
    poll: false,
  };
  const { app, store } = await buildApp(options);
  try {
    assert.equal((await app.inject({ url: "/api/projects" })).statusCode, 401);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: options.password },
    });
    assert.equal(login.statusCode, 200);
    const auth = login.cookies[0].value;
    const headers = { cookie: `pilot_session=${auth}` };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/projects",
          headers: { ...headers, origin: "https://evil.example" },
          payload: { name: "bad" },
        })
      ).statusCode,
      403,
    );
    let r = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers,
      payload: {
        baseUrl: "https://relay.example/custom/v1",
        model: "custom-model",
        apiKey: "cr-private-test-key",
        effort: "medium",
      },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().hasKey, true);
    assert.ok(!r.body.includes("cr-private"));
    const settings = await store.get<any>("config", "model");
    assert.ok(settings.encryptedKey);
    assert.ok(!JSON.stringify(settings).includes("cr-private"));
    r = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers,
      payload: { baseUrl: "https://relay.example/responses", model: "x" },
    });
    assert.equal(r.statusCode, 400);
    const p = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers,
        payload: { name: "测试项目" },
      })
    ).json();
    const image = await sharp({
      create: { width: 24, height: 24, channels: 3, background: "#2f7d63" },
    })
      .png()
      .toBuffer();
    const up = (
      await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers,
        payload: { projectId: p.id, name: "参考图.png", size: image.length },
      })
    ).json();
    assert.ok(up.id);
    r = await app.inject({
      method: "PATCH",
      url: `/api/uploads/${up.id}`,
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "upload-offset": "12",
      },
      payload: image,
    });
    assert.equal(r.statusCode, 409);
    const split = Math.floor(image.length / 2);
    r = await app.inject({
      method: "PATCH",
      url: `/api/uploads/${up.id}`,
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "upload-offset": "0",
      },
      payload: image.subarray(0, split),
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().offset, split);
    assert.equal(
      (await app.inject({ url: `/api/uploads/${up.id}`, headers })).json()
        .offset,
      split,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/uploads/${up.id}/complete`,
          headers,
          payload: {},
        })
      ).statusCode,
      400,
    );
    await app.inject({
      method: "PATCH",
      url: `/api/uploads/${up.id}`,
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "upload-offset": String(split),
      },
      payload: image.subarray(split),
    });
    const done = await app.inject({
      method: "POST",
      url: `/api/uploads/${up.id}/complete`,
      headers,
      payload: {},
    });
    assert.equal(done.statusCode, 200);
    const asset = done.json();
    assert.ok(asset.previewPath);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/uploads/${up.id}/complete`,
          headers,
          payload: {},
        })
      ).json().id,
      asset.id,
    );
    assert.equal(
      (await app.inject({ url: `/api/files/asset/${asset.id}` })).statusCode,
      401,
    );
    r = await app.inject({ url: `/api/files/asset/${asset.id}`, headers });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers["content-type"], "image/png");
    const other = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers,
        payload: { name: "隔离项目" },
      })
    ).json();
    const session = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${other.id}/sessions`,
        headers,
        payload: {},
      })
    ).json();
    r = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/turns`,
      headers,
      payload: {
        text: "use wrong asset",
        assetIds: [asset.id],
        clientRequestId: "req-one",
      },
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.body, /不属于/);
    assert.equal((await app.inject({ url: "/api/library" })).statusCode, 401);
    const published = await app.inject({
      method: "POST",
      url: `/api/assets/${asset.id}/publish`,
      headers,
      payload: {
        name: "共享参考图",
        category: "character",
        tags: ["人物参考"],
      },
    });
    assert.equal(published.statusCode, 200);
    const shared = published.json();
    assert.equal(
      (
        await app.inject({
          url: "/api/library?category=character&search=人物",
          headers,
        })
      ).json().items[0].id,
      shared.id,
    );
    assert.equal(
      (
        await app.inject({
          url: `/api/library/${shared.id}/file?preview=true`,
          headers,
        })
      ).headers["content-type"],
      "image/jpeg",
    );
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/library/${shared.id}`,
          headers,
          payload: { favorite: true },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/library/${shared.id}`,
          headers,
          payload: { category: "unknown" },
        })
      ).statusCode,
      400,
    );
    const sharedAfter = (
      await app.inject({
        url: "/api/library?category=character&search=人物",
        headers,
      })
    ).json();
    assert.equal(
      sharedAfter.total,
      1,
      "favorite patch preserves classification and tags",
    );
    await app.close();
    const reopened = await buildApp(options);
    assert.equal((await reopened.store.list("project")).length, 2);
    assert.equal(
      (
        await reopened.app.inject({
          url: "/api/library?favorite=true",
          headers,
        })
      ).json().total,
      1,
    );
    assert.equal(
      (await reopened.store.get<any>("asset", asset.id)).name,
      "参考图.png",
    );
    await reopened.app.close();
  } finally {
    if (!app.server.listening) await app.close().catch(() => {});
  }
});
