import "./database-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { buildApp } from "../apps/server/app.js";
import { AssetLibrary } from "../packages/blender-bridge/library.js";
test("global upload without a project preserves provenance, is retry-idempotent, and rejects external dependencies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-global-upload-"));
  const { app } = await buildApp({
    dataRoot: root,
    password: "test-password-1234",
    internalToken: "test-internal-token-123456789",
    runnerUrl: "http://127.0.0.1:1",
    poll: false,
  });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "test-password-1234" },
    });
    const headers = { cookie: `pilot_session=${login.cookies[0].value}` };
    const call = async (
      url: string,
      payload?: any,
      method: any = "POST",
      extra = {},
    ) =>
      app.inject({
        url: "/api" + url,
        method,
        headers: { ...headers, ...extra },
        payload,
      });
    const image = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "#abcdef" },
    })
      .png()
      .toBuffer();
    const metadata = {
      name: "Shared reference",
      category: "other",
      sourceUrl: "https://example.com/asset",
      author: "Example creator",
      license: "Test-only license",
    };
    const started = await call("/uploads", {
      destination: "library",
      name: "reference.png",
      size: image.length,
      library: metadata,
    });
    assert.equal(started.statusCode, 200);
    const id = started.json().id;
    const patch = await call(`/uploads/${id}`, image, "PATCH", {
      "content-type": "application/octet-stream",
      "upload-offset": "0",
    });
    assert.equal(patch.statusCode, 200);
    const completed = await call(`/uploads/${id}/complete`, {});
    assert.equal(completed.statusCode, 200);
    const item = completed.json();
    assert.equal(item.sourceUrl, metadata.sourceUrl);
    assert.equal(item.author, metadata.author);
    assert.equal(item.sourceProjectId, undefined);
    assert(item.previewPath);
    assert.equal(
      (await call(`/uploads/${id}/complete`, {})).json().id,
      item.id,
    );
    assert.equal((await call("/library", undefined, "GET")).json().total, 1);
    assert.equal(
      (await call(`/library/${item.id}`, { favorite: true }, "PATCH"))
        .statusCode,
      200,
    );
    const saved = await new AssetLibrary(root).get(item.id);
    assert.equal(saved.license, metadata.license);
    assert.equal(saved.category, "other");
    assert.equal(saved.sourceUrl, metadata.sourceUrl);
    assert.equal(
      (
        await call("/uploads", {
          destination: "library",
          name: "bad.png",
          size: 5,
          library: { ...metadata, sourceUrl: "javascript:alert(1)" },
        })
      ).statusCode,
      400,
    );
    const gltf = Buffer.from(
      JSON.stringify({
        asset: { version: "2.0" },
        buffers: [{ uri: "https://example.com/secret.bin", byteLength: 1 }],
      }),
    );
    const gid = (
      await call("/uploads", {
        destination: "library",
        name: "external.gltf",
        size: gltf.length,
        library: metadata,
      })
    ).json().id;
    await call(`/uploads/${gid}`, gltf, "PATCH", {
      "content-type": "application/octet-stream",
      "upload-offset": "0",
    });
    assert.equal((await call(`/uploads/${gid}/complete`, {})).statusCode, 400);
    assert.equal((await call("/library", undefined, "GET")).json().total, 1);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
