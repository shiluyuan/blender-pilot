import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Vault } from "../apps/server/security.js";
import {
  safePath,
  existingSafePath,
  redact,
} from "../packages/contracts/fs.js";
import { receipt } from "../packages/blender-bridge/scene.js";
test("vault encrypts secrets, detects tampering and signs expiring sessions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pilot-vault-"));
  const v = new Vault(dir);
  await v.init();
  const encrypted = v.encrypt("cr-test-secret");
  assert.ok(!encrypted.includes("cr-test"));
  assert.equal(v.decrypt(encrypted), "cr-test-secret");
  const changed = Buffer.from(encrypted, "base64");
  changed[14] ^= 1;
  assert.throws(() => v.decrypt(changed.toString("base64")));
  assert.ok(v.valid(v.session()));
  assert.equal(v.valid("1.invalid"), false);
  const v2 = new Vault(dir);
  await v2.init();
  assert.equal(v2.decrypt(encrypted), "cr-test-secret");
});
test("paths reject traversal and symlinks outside a project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-path-"));
  await mkdir(path.join(root, "project"));
  await writeFile(path.join(root, "secret"), "private");
  assert.throws(() => safePath(path.join(root, "project"), "../secret"));
  await symlink(path.join(root, "secret"), path.join(root, "project", "link"));
  await assert.rejects(existingSafePath(path.join(root, "project"), "link"));
});
test("receipts detect transforms even when object counts stay constant", () => {
  const before: any = { objects: [{ name: "Cube", location: [0, 0, 0] }] };
  const after: any = { objects: [{ name: "Cube", location: [2, 0, 0] }] };
  assert.equal(receipt(before, after).modified.length, 1);
  assert.deepEqual(receipt(before, after).created, []);
});
test("redaction preserves complete structured events", () => {
  const text = JSON.stringify({
    secret: "test-private-key",
    code: "x".repeat(40000),
  });
  const result = redact(text, ["test-private-key"]);
  assert.equal(JSON.parse(result).secret, "[redacted]");
  assert.equal(JSON.parse(result).code.length, 40000);
});
