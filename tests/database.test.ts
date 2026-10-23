import "./database-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../apps/server/db.js";
import { PGlite } from "@electric-sql/pglite";
import { importLegacy } from "../apps/server/migrate.js";

test("PostgreSQL ownership constraints, active-run uniqueness, transactional idempotency and rollback", async () => {
  const store = new Store("/unused", {
    schema: "pilot_constraint_" + process.pid,
  });
  await store.init();
  try {
    await store.put("project", "a", { id: "a", name: "A" });
    await store.put("project", "b", { id: "b", name: "B" });
    await store.put("session", "sa", { id: "sa", projectId: "a", title: "A" });
    await store.put("session", "sb", { id: "sb", projectId: "b", title: "B" });
    const run = {
      id: "one",
      sessionId: "sa",
      projectId: "a",
      status: "queued",
      verification: "pending",
    };
    await assert.rejects(
      store.put("run", "bad", { ...run, id: "bad", sessionId: "sb" }),
      (e: any) => e.code === "23503",
    );
    const accepted = await store.createRun(run, "sa:request1");
    assert.equal(accepted.id, "one");
    assert.equal(
      (await store.createRun({ ...run, id: "duplicate" }, "sa:request1")).id,
      "one",
    );
    await assert.rejects(
      store.createRun({ ...run, id: "parallel" }, "sa:request2"),
      (e: any) => e.code === "23505",
    );
    assert.equal(
      (
        await store.db.query(
          `SELECT * FROM ${store.db.table("requests")} WHERE key=$1`,
          ["sa:request2"],
        )
      ).rowCount,
      0,
    );
    assert.equal(await store.get("run", "parallel"), undefined);
    await store.put("run", "one", { ...run, status: "succeeded" });
    await store.createRun({ ...run, id: "next" }, "sa:request2");
    await store.createRun(
      { ...run, id: "b-run", sessionId: "sb", projectId: "b" },
      "sb:request",
    );
    assert.equal((await store.list("run")).length, 3);
    await assert.rejects(
      store.db.transaction(async (tx) => {
        await store.put(
          "project",
          "rolled",
          { id: "rolled", name: "Rolled back" },
          tx,
        );
        throw new Error("abort");
      }),
    );
    assert.equal(await store.get("project", "rolled"), undefined);
  } finally {
    await store.db.close();
  }
});
test("legacy import copies PGlite and library metadata atomically, preserves key bytes, interrupts jobs and is repeatable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-import-")),
    schema = "pilot_migrate_" + process.pid;
  const old = new PGlite(path.join(root, "database"));
  await old.exec(
    "CREATE TABLE records(kind text,id text,data jsonb);CREATE TABLE events(run_id text,seq int,data jsonb);CREATE TABLE requests(key text,run_id text)",
  );
  const entries = [
    ["project", "p", { id: "p", name: "Migrated" }],
    ["session", "s", { id: "s", projectId: "p", title: "Old chat" }],
    [
      "run",
      "r",
      { id: "r", projectId: "p", sessionId: "s", status: "running" },
    ],
    [
      "config",
      "model",
      { encryptedKey: "unaltered-encrypted-ciphertext", model: "test" },
    ],
  ];
  for (const [kind, id, d] of entries)
    await old.query("INSERT INTO records VALUES($1,$2,$3)", [
      kind,
      id,
      JSON.stringify(d),
    ]);
  const event = {
    runId: "r",
    seq: 1,
    type: "message.completed",
    payload: { text: "Legacy" },
  };
  await old.query("INSERT INTO events VALUES($1,$2,$3)", [
    "r",
    1,
    JSON.stringify(event),
  ]);
  await old.query("INSERT INTO requests VALUES($1,$2)", ["s:request", "r"]);
  await old.close();
  const id = "11111111-1111-4111-8111-111111111111",
    dir = path.join(root, "library", id);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "asset.blend");
  await writeFile(file, "test blend");
  const raw = {
    id,
    name: "Legacy chair",
    category: "prop",
    tags: ["wood"],
    favorite: true,
    path: file,
    mime: "application/x-blender",
    size: 10,
    sha256: "a".repeat(64),
    createdAt: new Date().toISOString(),
    source: "blender",
    objectNames: ["Chair"],
  };
  await writeFile(path.join(dir, "asset.json"), JSON.stringify(raw));
  const store = new Store(root, { schema });
  try {
    const result = await importLegacy(store);
    assert.equal((result as any).records, 4);
    assert.equal((result as any).library, 1);
    assert.equal(
      (await store.get<any>("config", "model")).encryptedKey,
      "unaltered-encrypted-ciphertext",
    );
    assert.equal((await store.get<any>("run", "r")).status, "interrupted");
    assert.equal((await store.events("r")).length, 1);
    assert.equal(((await importLegacy(store)) as any).alreadyImported, true);
    assert.equal(await readFile(file, "utf8"), "test blend");
    assert.equal(
      (
        await store.db.query(
          `SELECT name FROM ${store.db.table("library_assets")} WHERE id=$1`,
          [id],
        )
      ).rows[0].name,
      "Legacy chair",
    );
  } finally {
    await store.db.close();
  }
});
