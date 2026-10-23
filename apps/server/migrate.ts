/** Offline, one-time PGlite / JSON metadata import. Original files remain intact. */
import { PGlite } from "@electric-sql/pglite";
import { cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./db.js";
import { LibraryCatalog } from "../../packages/storage/library-catalog.js";
import {
  libraryMetadataSchema,
  type LibraryAsset,
} from "../../packages/blender-bridge/library.js";
import { existingSafePath } from "../../packages/contracts/fs.js";
export async function importLegacy(store: Store) {
  await store.init();
  const db = store.db;
  if (
    (
      await db.query(
        `SELECT source FROM ${db.table("migration_imports")} WHERE source=$1`,
        ["legacy-v1"],
      )
    ).rowCount
  )
    return { alreadyImported: true };
  const legacy = path.join(store.root, "database");
  let old: PGlite | undefined, temp: string | undefined;
  const records: { kind: string; id: string; data: any }[] = [],
    events: any[] = [],
    requests: any[] = [];
  const library: LibraryAsset[] = [];
  try {
    try {
      await stat(path.join(legacy, "PG_VERSION"));
      temp = await mkdtemp(path.join(store.root, ".migration-"));
      await cp(legacy, path.join(temp, "database"), { recursive: true });
      old = new PGlite(path.join(temp, "database"));
      await old.waitReady;
      records.push(
        ...(
          await old.query<{ kind: string; id: string; data: any }>(
            "SELECT kind,id,data FROM records",
          )
        ).rows,
      );
      events.push(
        ...(
          await old.query("SELECT data FROM events ORDER BY run_id,seq")
        ).rows.map((r: any) => r.data),
      );
      requests.push(
        ...(await old.query("SELECT key,run_id FROM requests")).rows,
      );
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    let entries: any[] = [];
    try {
      entries = await readdir(path.join(store.root, "library"), {
        withFileTypes: true,
      });
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let a: any;
      try {
        a = JSON.parse(
          await readFile(
            path.join(store.root, "library", entry.name, "asset.json"),
            "utf8",
          ),
        );
      } catch (e: any) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      const parsed = {
        ...a,
        ...libraryMetadataSchema.parse(a),
        sourceAssetIds: a.sourceAssetIds || [],
      };
      if (parsed.id !== entry.name)
        throw new Error("Legacy library asset ID mismatch");
      await existingSafePath(store.root, parsed.path);
      if (parsed.previewPath)
        await existingSafePath(store.root, parsed.previewPath);
      library.push(parsed);
    }
    if (!records.length && !library.length && !old)
      return { records: 0, events: 0, library: 0 };
    const summary = {
      records: records.length,
      events: events.length,
      requests: requests.length,
      library: library.length,
    };
    await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "blender-pilot-legacy-import:" + db.schema,
      ]);
      if (
        (
          await tx.query(
            `SELECT 1 FROM ${db.table("migration_imports")} WHERE source='legacy-v1'`,
          )
        ).rowCount
      )
        return;
      for (const table of [
        "projects",
        "sessions",
        "runs",
        "assets",
        "captures",
        "snapshots",
        "artifacts",
        "uploads",
        "config",
        "library_assets",
      ])
        if (
          (await tx.query(`SELECT 1 FROM ${db.table(table)} LIMIT 1`)).rowCount
        )
          throw new Error(
            "Legacy import requires an empty PostgreSQL schema. No existing data was replaced.",
          );
      const order = [
        "project",
        "session",
        "run",
        "asset",
        "capture",
        "snapshot",
        "artifact",
        "upload",
        "config",
      ];
      if (records.some((r) => !order.includes(r.kind)))
        throw new Error("Unknown legacy record type; import aborted");
      records.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
      for (const r of records) {
        if (
          r.kind === "run" &&
          ["queued", "running", "cancelling"].includes(r.data.status)
        )
          r.data = {
            ...r.data,
            status: "interrupted",
            error: "迁移前任务已中断，请检查场景后重新发起。",
          };
        await store.put(r.kind, r.id, r.data, tx);
      }
      for (const e of events)
        await tx.query(
          `INSERT INTO ${db.table("events")}(run_id,seq,type,data) VALUES($1,$2,$3,$4)`,
          [e.runId, e.seq, e.type, JSON.stringify(e)],
        );
      for (const r of requests)
        await tx.query(
          `INSERT INTO ${db.table("requests")}(key,run_id) VALUES($1,$2)`,
          [r.key, r.run_id],
        );
      await new LibraryCatalog(db).importMany(library, tx);
      await tx.query(
        `INSERT INTO ${db.table("migration_imports")}(source,details) VALUES('legacy-v1',$1)`,
        [JSON.stringify(summary)],
      );
    });
    return summary;
  } finally {
    await old?.close();
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const store = new Store(process.env.PILOT_DATA || "/data");
  try {
    console.log("Legacy import:", JSON.stringify(await importLegacy(store)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : "Migration failed");
    process.exitCode = 1;
  } finally {
    await store.db.close();
  }
}
