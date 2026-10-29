import type { PoolClient } from "pg";
import type { LibraryAsset } from "../contracts/library.js";
import { Database, sharedDatabase } from "./database.js";
export class LibraryCatalog {
  constructor(public db: Database = sharedDatabase()) {}
  async get(id: string) {
    await this.db.init();
    return (
      await this.db.query<{ data: LibraryAsset }>(
        `SELECT data FROM ${this.db.table("library_assets")} WHERE id=$1`,
        [id],
      )
    ).rows[0]?.data;
  }
  async list(
    query: {
      search?: string;
      category?: string;
      favorite?: boolean;
      page?: number;
    } = {},
  ) {
    await this.db.init();
    const search = (query.search || "").trim().toLowerCase(),
      page = Math.min(100000, Math.max(0, Math.floor(query.page || 0)));
    const where = `($1='' OR category=$1) AND (NOT $2 OR favorite) AND ($3='' OR position($3 in lower(name || ' ' || coalesce(data->>'description','') || ' ' || array_to_string(tags,' ')))>0)`;
    const values = [
      query.category && query.category !== "all" ? query.category : "",
      !!query.favorite,
      search,
    ];
    // One statement gives count and page the same database snapshot.
    const r = await this.db.query<{ items: LibraryAsset[]; total: number }>(
      `WITH matched AS (SELECT * FROM ${this.db.table("library_assets")} WHERE ${where}), page AS (SELECT data FROM matched ORDER BY created_at DESC,id LIMIT 60 OFFSET $4) SELECT coalesce((SELECT jsonb_agg(data) FROM page),'[]'::jsonb) AS items,(SELECT count(*)::int FROM matched) AS total`,
      [...values, page * 60],
    );
    return { ...r.rows[0], page };
  }
  private async insert(tx: PoolClient, a: LibraryAsset) {
    await tx.query(
      `INSERT INTO ${this.db.table("library_assets")}(id,name,category,tags,favorite,source_project_id,path,sha256,size_bytes,created_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        a.id,
        a.name,
        a.category,
        a.tags,
        a.favorite,
        a.sourceProjectId || null,
        a.path,
        a.sha256,
        a.size,
        a.createdAt,
        JSON.stringify(a),
      ],
    );
  }
  async importMany(assets: LibraryAsset[], tx: PoolClient) {
    for (const a of assets) await this.insert(tx, a);
    for (const a of assets)
      for (const source of new Set(a.sourceAssetIds || []))
        await tx.query(
          `INSERT INTO ${this.db.table("library_asset_sources")}(asset_id,source_asset_id) SELECT $1,id FROM ${this.db.table("library_assets")} WHERE id=$2 AND id<>$1 ON CONFLICT DO NOTHING`,
          [a.id, source],
        );
  }
  async create(a: LibraryAsset) {
    await this.db.init();
    await this.db.transaction((tx) => this.importMany([a], tx));
    return a;
  }

  async update(id: string, patch: Partial<LibraryAsset>) {
    await this.db.init();
    return this.db.transaction(async (tx) => {
      const current = (
        await tx.query<{ data: LibraryAsset }>(
          `SELECT data FROM ${this.db.table("library_assets")} WHERE id=$1 FOR UPDATE`,
          [id],
        )
      ).rows[0]?.data;
      if (!current)
        throw Object.assign(new Error("素材不存在"), { statusCode: 404 });
      const a = { ...current, ...patch };
      await tx.query(
        `UPDATE ${this.db.table("library_assets")} SET name=$2,category=$3,tags=$4,favorite=$5,data=$6 WHERE id=$1`,
        [id, a.name, a.category, a.tags, a.favorite, JSON.stringify(a)],
      );
      return a;
    });
  }
}
