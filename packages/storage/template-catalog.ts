import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  BUILTIN_TEMPLATES,
  templateInputSchema,
  type CreationTemplate,
  type TemplateInput,
} from "../contracts/templates.js";
import { Database } from "./database.js";
import { LibraryCatalog } from "./library-catalog.js";

const fail = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode });
export interface TemplateQuery {
  search?: string;
  category?: string;
  source?: "all" | "builtin" | "custom";
  page?: number;
}
export class TemplateCatalog {
  constructor(public db: Database) {}
  async get(id: string): Promise<CreationTemplate | undefined> {
    const builtin = BUILTIN_TEMPLATES.find((item) => item.id === id);
    if (builtin) return structuredClone(builtin);
    await this.db.init();
    return (
      await this.db.query<{ data: CreationTemplate }>(
        `SELECT data FROM ${this.db.table("creation_templates")} WHERE id=$1`,
        [id],
      )
    ).rows[0]?.data;
  }
  async list(query: TemplateQuery = {}) {
    await this.db.init();
    const search = (query.search || "").trim().toLocaleLowerCase();
    const category = query.category === "all" ? "" : query.category || "";
    const source = query.source || "all";
    const page = Math.min(100000, Math.max(0, Math.floor(query.page || 0)));
    const builtin =
      source === "custom"
        ? []
        : BUILTIN_TEMPLATES.filter(
            (item) =>
              (!category || item.category === category) &&
              (!search ||
                `${item.name} ${item.description} ${item.prompt}`
                  .toLocaleLowerCase()
                  .includes(search)),
          );
    const offset = page * 60;
    const builtinPage = builtin.slice(offset, offset + 60);
    if (source === "builtin")
      return {
        items: structuredClone(builtinPage),
        total: builtin.length,
        page,
      };
    const result = await this.db.query<{
      items: CreationTemplate[];
      total: number;
    }>(
      `WITH matched AS (SELECT * FROM ${this.db.table("creation_templates")} WHERE ($1='' OR category=$1) AND ($2='' OR position($2 in lower(name || ' ' || coalesce(data->>'description','') || ' ' || coalesce(data->>'prompt','')))>0)), page AS (SELECT data FROM matched ORDER BY updated_at DESC,id LIMIT $3 OFFSET $4) SELECT coalesce((SELECT jsonb_agg(data) FROM page),'[]'::jsonb) AS items,(SELECT count(*)::int FROM matched) AS total`,
      [
        category,
        search,
        60 - builtinPage.length,
        Math.max(0, offset - builtin.length),
      ],
    );
    return {
      items: [...structuredClone(builtinPage), ...result.rows[0].items],
      total: builtin.length + result.rows[0].total,
      page,
    };
  }
  async detail(id: string) {
    const template = await this.get(id);
    if (!template) throw fail("模板不存在", 404);
    const library = new LibraryCatalog(this.db);
    const assets = await Promise.all(
      template.libraryAssetIds.map((assetId) => library.get(assetId)),
    );
    return {
      template,
      libraryAssets: assets.filter((asset) => !!asset),
      missingLibraryAssetIds: template.libraryAssetIds.filter(
        (_id, index) => !assets[index],
      ),
    };
  }
  private editable(id: string) {
    if (id.startsWith("builtin:"))
      throw fail("内置模板不能修改，请另存为我的模板", 403);
  }
  private async referenceRows(tx: PoolClient, template: CreationTemplate) {
    await tx.query(
      `DELETE FROM ${this.db.table("creation_template_assets")} WHERE template_id=$1`,
      [template.id],
    );
    for (const assetId of template.libraryAssetIds) {
      const asset = await tx.query(
        `SELECT id FROM ${this.db.table("library_assets")} WHERE id=$1 FOR KEY SHARE`,
        [assetId],
      );
      if (!asset.rowCount)
        throw fail(`引用素材不存在：${assetId}，请移除后再保存`, 400);
      await tx.query(
        `INSERT INTO ${this.db.table("creation_template_assets")}(template_id,asset_id) VALUES($1,$2)`,
        [template.id, assetId],
      );
    }
  }
  async create(input: TemplateInput) {
    const validated = templateInputSchema.parse(input);
    const now = new Date().toISOString();
    const template: CreationTemplate = {
      ...validated,
      id: randomUUID(),
      source: "custom",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.init();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO ${this.db.table("creation_templates")}(id,name,category,version,created_at,updated_at,data) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          template.id,
          template.name,
          template.category,
          template.version,
          template.createdAt,
          template.updatedAt,
          JSON.stringify(template),
        ],
      );
      await this.referenceRows(tx, template);
    });
    return template;
  }
  async update(id: string, expectedVersion: number, input: TemplateInput) {
    this.editable(id);
    const validated = templateInputSchema.parse(input);
    await this.db.init();
    return this.db.transaction(async (tx) => {
      const current = (
        await tx.query<{ data: CreationTemplate }>(
          `SELECT data FROM ${this.db.table("creation_templates")} WHERE id=$1 FOR UPDATE`,
          [id],
        )
      ).rows[0]?.data;
      if (!current) throw fail("模板不存在", 404);
      if (current.version !== expectedVersion)
        throw fail("模板已在其他页面更新，请刷新后再编辑", 409);
      const template: CreationTemplate = {
        ...validated,
        id,
        source: "custom",
        version: current.version + 1,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      };
      await tx.query(
        `UPDATE ${this.db.table("creation_templates")} SET name=$2,category=$3,version=$4,updated_at=$5,data=$6 WHERE id=$1`,
        [
          id,
          template.name,
          template.category,
          template.version,
          template.updatedAt,
          JSON.stringify(template),
        ],
      );
      await this.referenceRows(tx, template);
      return template;
    });
  }
  async delete(id: string, expectedVersion: number) {
    this.editable(id);
    await this.db.init();
    return this.db.transaction(async (tx) => {
      const current = (
        await tx.query<{ version: number }>(
          `SELECT version FROM ${this.db.table("creation_templates")} WHERE id=$1 FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (!current) throw fail("模板不存在", 404);
      if (current.version !== expectedVersion)
        throw fail("模板已在其他页面更新，请刷新后再删除", 409);
      await tx.query(
        `DELETE FROM ${this.db.table("creation_templates")} WHERE id=$1`,
        [id],
      );
      return { deleted: true };
    });
  }
}
