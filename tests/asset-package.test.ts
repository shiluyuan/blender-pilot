import "./database-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zip } from "./fixtures/zip.js";
import { unpackAssetPackage } from "../packages/storage/asset-package.js";
import { buildApp } from "../apps/server/app.js";
import { AssetLibrary } from "../packages/blender-bridge/library.js";
const file = (name: string, text: string) => ({
  name,
  data: Buffer.from(text),
});
test("asset packages keep glTF/OBJ dependencies and reject missing, remote and ambiguous entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-package-"));
  const archive = path.join(root, "asset.zip");
  const unpack = async (files: any[]) => {
    await writeFile(archive, zip(files));
    return unpackAssetPackage(archive, path.join(root, crypto.randomUUID()));
  };
  try {
    const result = await unpack([
      file(
        "model/room.gltf",
        JSON.stringify({
          buffers: [{ uri: "room.bin" }],
          images: [{ uri: "../textures/wall.png" }],
        }),
      ),
      file("model/room.bin", "binary"),
      file("textures/wall.png", "image"),
    ]);
    assert.equal(result.entry, "model/room.gltf");
    assert.equal(result.files, 3);
    await assert.rejects(
      unpack([
        file("room.gltf", '{"buffers":[{"uri":"https://example.com/a.bin"}]}'),
      ]),
      /外部地址/,
    );
    await assert.rejects(
      unpack([file("room.gltf", '{"buffers":[{"uri":"missing.bin"}]}')]),
      /缺少依赖/,
    );
    await assert.rejects(unpack([file("../escape.blend", "bad")]), /路径/);
    await assert.rejects(
      unpack([file("one.blend", "x"), file("two.blend", "y")]),
      /多个/,
    );
    const chosen = await unpack([
      file("one.blend", "x"),
      file("two.blend", "y"),
      file("pilot-asset.json", '{"entry":"two.blend"}'),
    ]);
    assert.equal(chosen.entry, "two.blend");
    const obj = await unpack([
      file("model.obj", "mtllib model.mtl"),
      file("model.mtl", "map_Kd tex.png"),
      file("tex.png", "image"),
    ]);
    assert.equal(obj.entry, "model.obj");
    await assert.rejects(
      unpack([file("model.obj", "mtllib missing.mtl")]),
      /缺少依赖/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("library ZIP API retains original download, resolves extracted entry and retries idempotently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-package-api-"));
  const { app } = await buildApp({
    dataRoot: root,
    password: "package-test-password",
    internalToken: "package-internal-token-123456",
    runnerUrl: "http://127.0.0.1:1",
    poll: false,
  });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "package-test-password" },
    });
    const headers = { cookie: "pilot_session=" + login.cookies[0].value };
    const archive = zip([
      file("room.obj", "mtllib room.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3"),
      file("room.mtl", "newmtl wall\nKd 1 0 0"),
    ]);
    const start = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers,
      payload: {
        destination: "library",
        name: "room.zip",
        size: archive.length,
        library: { name: "Room package", category: "scene" },
      },
    });
    assert.equal(start.statusCode, 200, start.body);
    const id = start.json().id;
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/uploads/" + id,
          headers: {
            ...headers,
            "content-type": "application/octet-stream",
            "upload-offset": "0",
          },
          payload: archive,
        })
      ).statusCode,
      200,
    );
    const done = await app.inject({
      method: "POST",
      url: "/api/uploads/" + id + "/complete",
      headers,
      payload: {},
    });
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(done.json().package.entry, "room.obj");
    const library = new AssetLibrary(root);
    assert.match(await library.importFile(id), /content\/room.obj$/);
    assert.deepEqual(await readFile(await library.file(id)), archive);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/uploads/" + id + "/complete",
          headers,
          payload: {},
        })
      ).json().id,
      id,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
