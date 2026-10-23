import { PGlite } from "@electric-sql/pglite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
export class Store {
  db: PGlite;
  constructor(public root: string) {
    this.db = new PGlite(path.join(root, "database"));
  }
  async init() {
    await mkdir(this.root, { recursive: true });
    await this.db.exec(
      `CREATE TABLE IF NOT EXISTS records (kind text NOT NULL,id text NOT NULL,data jsonb NOT NULL,PRIMARY KEY(kind,id));CREATE TABLE IF NOT EXISTS events(run_id text NOT NULL,seq int NOT NULL,data jsonb NOT NULL,PRIMARY KEY(run_id,seq)); CREATE INDEX IF NOT EXISTS records_project ON records ((data->>'projectId')); CREATE TABLE IF NOT EXISTS requests(key text PRIMARY KEY,run_id text NOT NULL);`,
    );
  }
  async get<T>(kind: string, id: string): Promise<T | undefined> {
    return (
      await this.db.query<{ data: T }>(
        "SELECT data FROM records WHERE kind=$1 AND id=$2",
        [kind, id],
      )
    ).rows[0]?.data;
  }
  async put(kind: string, id: string, data: unknown) {
    await this.db.query(
      "INSERT INTO records VALUES($1,$2,$3) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      [kind, id, JSON.stringify(data)],
    );
  }
  async list<T>(kind: string, projectId?: string): Promise<T[]> {
    const r = projectId
      ? await this.db.query<{ data: T }>(
          "SELECT data FROM records WHERE kind=$1 AND data->>'projectId'=$2 ORDER BY data->>'createdAt' DESC",
          [kind, projectId],
        )
      : await this.db.query<{ data: T }>(
          "SELECT data FROM records WHERE kind=$1 ORDER BY data->>'createdAt' DESC",
          [kind],
        );
    return r.rows.map((x) => x.data);
  }
  async delete(kind: string, id: string) {
    await this.db.query("DELETE FROM records WHERE kind=$1 AND id=$2", [
      kind,
      id,
    ]);
  }
  async events(runId: string, after = 0) {
    return (
      await this.db.query<{ data: any }>(
        "SELECT data FROM events WHERE run_id=$1 AND seq>$2 ORDER BY seq",
        [runId, after],
      )
    ).rows.map((x) => x.data);
  }
  async event(e: any) {
    await this.db.query(
      "INSERT INTO events VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [e.runId, e.seq, JSON.stringify(e)],
    );
  }
}
