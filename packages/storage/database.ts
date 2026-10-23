import pg, { type PoolClient, type QueryResultRow } from "pg";
import { migrations } from "./schema.js";
export interface DatabaseOptions {
  url?: string;
  schema?: string;
}
export class Database {
  readonly pool: pg.Pool;
  readonly schema: string;
  private initialized?: Promise<void>;
  constructor(options: DatabaseOptions = {}) {
    const url = options.url || process.env.DATABASE_URL;
    if (!url)
      throw new Error(
        "DATABASE_URL is required. Run ./docker-up.sh to start PostgreSQL.",
      );
    const parsed = new URL(url);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol))
      throw new Error("DATABASE_URL must be a PostgreSQL connection URL");
    this.schema = options.schema || process.env.PILOT_DB_SCHEMA || "public";
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(this.schema))
      throw new Error("Invalid PostgreSQL schema name");
    this.pool = new pg.Pool({
      connectionString: url,
      max: 5,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 10000,
      statement_timeout: 30000,
      query_timeout: 35000,
      options: `-c search_path=${this.schema},public`,
      allowExitOnIdle: true,
    });
    // Idle disconnections must not crash the HTTP/Runner process; the pool
    // reconnects on the next operation and readiness checks surface failures.
    this.pool.on("error", () => {});
  }
  table(name: string) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error("Invalid table name");
    return `"${this.schema}"."${name}"`;
  }
  query<T extends QueryResultRow = any>(sql: string, values?: any[]) {
    return this.pool.query<T>(sql, values);
  }
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  init() {
    if (!this.initialized)
      this.initialized = this.migrate().catch((e) => {
        this.initialized = undefined;
        throw e;
      });
    return this.initialized;
  }
  private async migrate() {
    await this.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "blender-pilot:" + this.schema,
      ]);
      await tx.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
      await tx.query(`SET LOCAL search_path TO "${this.schema}",public`);
      await tx.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const applied = (
        await tx.query<{ version: number }>(
          "SELECT version FROM schema_migrations",
        )
      ).rows.map((r) => r.version);
      if (
        applied.some(
          (version) => version > Math.max(...migrations.map((m) => m.version)),
        )
      )
        throw new Error(
          "Database schema is newer than this application version",
        );
      for (const m of migrations) {
        if (applied.includes(m.version)) continue;
        await tx.query(m.sql);
        await tx.query("INSERT INTO schema_migrations(version) VALUES($1)", [
          m.version,
        ]);
      }
    });
  }
  async health() {
    const r = await this.query<{ version: string }>(
      "SELECT current_setting('server_version') AS version",
    );
    return {
      ok: true,
      engine: "PostgreSQL",
      version: r.rows[0].version,
      schema: this.schema,
    };
  }
  close() {
    return this.pool.end();
  }
}
let shared: Database | undefined;
export function sharedDatabase() {
  return (shared ??= new Database());
}
export async function closeSharedDatabase() {
  const db = shared;
  shared = undefined;
  await db?.close();
}
