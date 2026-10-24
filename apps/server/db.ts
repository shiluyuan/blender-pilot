import type { PoolClient } from "pg";
import {
  Database,
  type DatabaseOptions,
} from "../../packages/storage/database.js";
import type { Run } from "../../packages/contracts/index.js";

export type TurnInput = Pick<
  Run,
  "sessionId" | "projectId" | "prompt" | "assetIds" | "libraryAssetIds"
>;
function assertSameTurn(existing: TurnInput, requested: TurnInput) {
  const ids = (values: string[] | undefined) =>
    [...new Set(values || [])].sort();
  if (
    existing.sessionId !== requested.sessionId ||
    existing.projectId !== requested.projectId ||
    existing.prompt !== requested.prompt ||
    JSON.stringify(ids(existing.assetIds)) !==
      JSON.stringify(ids(requested.assetIds)) ||
    JSON.stringify(ids(existing.libraryAssetIds)) !==
      JSON.stringify(ids(requested.libraryAssetIds))
  )
    throw Object.assign(
      new Error("该发送编号已用于不同内容，请重新发送新消息"),
      { statusCode: 409 },
    );
}
const tables: Record<string, string> = {
  project: "projects",
  session: "sessions",
  run: "runs",
  asset: "assets",
  capture: "captures",
  snapshot: "snapshots",
  artifact: "artifacts",
  upload: "uploads",
  config: "config",
};
export class Store {
  db: Database;
  constructor(
    public root: string,
    options: DatabaseOptions = {},
  ) {
    this.db = new Database(options);
  }
  init() {
    return this.db.init();
  }
  private table(kind: string) {
    const table = tables[kind];
    if (!table) throw new Error("Unknown entity kind");
    return this.db.table(table);
  }
  async get<T>(
    kind: string,
    id: string,
    tx?: PoolClient,
  ): Promise<T | undefined> {
    return (
      await (tx
        ? tx.query<{ data: T }>(
            `SELECT data FROM ${this.table(kind)} WHERE id=$1`,
            [id],
          )
        : this.db.query<{ data: T }>(
            `SELECT data FROM ${this.table(kind)} WHERE id=$1`,
            [id],
          ))
    ).rows[0]?.data;
  }
  async put(kind: string, id: string, input: unknown, tx?: PoolClient) {
    const d = input as any,
      table = this.table(kind),
      columns = ["id", "data"],
      values: any[] = [id, JSON.stringify(d)];
    const add = (name: string, value: any) => {
      columns.push(name);
      values.push(value);
    };
    if (kind !== "config")
      add("created_at", d.createdAt || new Date().toISOString());
    if (["project", "run"].includes(kind))
      add("updated_at", d.updatedAt || d.createdAt || new Date().toISOString());
    if (!["project", "config"].includes(kind))
      add("project_id", d.projectId || null);
    if (kind === "project") add("name", d.name);
    if (kind === "session") {
      add("title", d.title || "新对话");
      add("native_thread_id", d.nativeThreadId || null);
    }
    if (kind === "run") {
      add("session_id", d.sessionId);
      add("status", d.status);
      add("verification", d.verification || "pending");
    }
    if (kind === "asset") {
      for (const k of ["name", "kind", "path", "sha256"]) add(k, d[k]);
      add("size_bytes", d.size);
    }
    const sql = `INSERT INTO ${table}(${columns.join(",")}) VALUES(${values.map((_, i) => "$" + (i + 1)).join(",")}) ON CONFLICT(id) DO UPDATE SET ${columns
      .filter((c) => c !== "id")
      .map((c) => `${c}=excluded.${c}`)
      .join(",")}`;
    if (tx) await tx.query(sql, values);
    else await this.db.query(sql, values);
  }
  async list<T>(kind: string, projectId?: string): Promise<T[]> {
    const table = this.table(kind);
    const result = await this.db.query<{ data: T }>(
      `SELECT data FROM ${table}${projectId ? " WHERE project_id=$1" : ""} ORDER BY ${kind === "config" ? "id" : "created_at DESC,id"}`,
      projectId ? [projectId] : [],
    );
    return result.rows.map((r) => r.data);
  }
  async delete(kind: string, id: string) {
    await this.db.query(`DELETE FROM ${this.table(kind)} WHERE id=$1`, [id]);
  }
  async events(runId: string, after = 0, limit?: number) {
    return (
      await this.db.query<{ data: any }>(
        `SELECT data FROM ${this.db.table("events")} WHERE run_id=$1 AND seq>$2 ORDER BY seq${limit ? " LIMIT $3" : ""}`,
        limit ? [runId, after, limit] : [runId, after],
      )
    ).rows.map((r) => r.data);
  }
  async latestSequence(runId: string) {
    const result = await this.db.query<{ seq: number | null }>(
      `SELECT max(seq) AS seq FROM ${this.db.table("events")} WHERE run_id=$1`,
      [runId],
    );
    return result.rows[0]?.seq || 0;
  }
  async requestedRun(key: string, input?: TurnInput): Promise<Run | undefined> {
    const result = await this.db.query<{ data: Run }>(
      `SELECT r.data FROM ${this.db.table("requests")} q JOIN ${this.db.table("runs")} r ON r.id=q.run_id WHERE q.key=$1`,
      [key],
    );
    const run = result.rows[0]?.data;
    if (run && input) assertSameTurn(run, input);
    return run;
  }
  async event(e: any, tx?: PoolClient) {
    const sql = `INSERT INTO ${this.db.table("events")}(run_id,seq,type,data) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`;
    const values = [e.runId, e.seq, e.type, JSON.stringify(e)];
    if (tx) await tx.query(sql, values);
    else await this.db.query(sql, values);
  }
  async createRun(run: any, key: string) {
    return this.db.transaction(async (tx) => {
      // Protect retries across gateway processes, then atomically commit request+run.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        key,
      ]);
      const existing = (
        await tx.query<{ run_id: string }>(
          `SELECT run_id FROM ${this.db.table("requests")} WHERE key=$1`,
          [key],
        )
      ).rows[0];
      if (existing) {
        const previous = (
          await tx.query(
            `SELECT data FROM ${this.db.table("runs")} WHERE id=$1`,
            [existing.run_id],
          )
        ).rows[0].data;
        assertSameTurn(previous, run);
        return previous;
      }
      // Serialize distinct sends for a project across API processes as well.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "pilot-project:" + this.db.schema + ":" + run.projectId,
      ]);
      await this.put("run", run.id, run, tx);
      await tx.query(
        `INSERT INTO ${this.db.table("requests")}(key,run_id) VALUES($1,$2)`,
        [key, run.id],
      );
      return run;
    });
  }
  async updateRun(id: string, update: (run: Run) => void) {
    return this.db.transaction(async (tx) => {
      const current = (
        await tx.query<{ data: Run }>(
          `SELECT data FROM ${this.db.table("runs")} WHERE id=$1 FOR UPDATE`,
          [id],
        )
      ).rows[0]?.data;
      if (!current) return undefined;
      update(current);
      await this.put("run", id, current, tx);
      return current;
    });
  }
}
