import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PoolClient } from "pg";
import { Database } from "./database.js";
import {
  bundleSkills,
  parseSkillMarkdown,
  readSkillDirectory,
  readSkillZip,
  skillError,
  skillFileError,
  type SkillBundle,
} from "./skill-bundle.js";
import {
  fetchSkillBundles,
  normalizeSkillSource,
  type SkillInstallerOptions,
} from "./skill-installer.js";
import {
  MAX_SKILL_UPLOAD_BYTES,
  MAX_RUN_SKILL_MARKDOWN_BYTES,
  projectSkillsSchema,
  type InstalledSkill,
  type RunSkill,
} from "../contracts/skills.js";
import { idSchema } from "../contracts/index.js";

export class SkillCatalog {
  constructor(
    public db: Database,
    public dataRoot: string,
  ) {}
  private installed(id: string) {
    z.string().uuid().parse(id);
    return path.resolve(this.dataRoot, "skills", "installed", id);
  }
  private async lock(tx: PoolClient) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "pilot-skills:" + this.db.schema,
    ]);
  }
  async get(id: string): Promise<InstalledSkill | undefined> {
    await this.db.init();
    return (
      await this.db.query<{ data: InstalledSkill }>(
        `SELECT data FROM ${this.db.table("installed_skills")} WHERE id=$1`,
        [id],
      )
    ).rows[0]?.data;
  }
  async list() {
    await this.db.init();
    return (
      await this.db.query<{ data: InstalledSkill }>(
        `SELECT data FROM ${this.db.table("installed_skills")} ORDER BY name,id`,
      )
    ).rows.map((row) => row.data);
  }
  async detail(id: string) {
    await this.db.init();
    return this.db
      .transaction(async (tx) => {
        await this.lock(tx);
        const skill = (
          await tx.query<{ data: InstalledSkill }>(
            `SELECT data FROM ${this.db.table("installed_skills")} WHERE id=$1`,
            [id],
          )
        ).rows[0]?.data;
        if (!skill) throw skillError("技能不存在", 404);
        const bundles = bundleSkills(
          await readSkillDirectory(this.installed(id)),
        );
        if (bundles.length !== 1 || bundles[0].sha256 !== skill.sha256)
          throw skillError("技能文件校验失败，请卸载后重新安装", 409);
        const bundle = bundles[0];
        return {
          skill,
          content: parseSkillMarkdown(
            bundle.files.find((file) => file.name === "SKILL.md")!.data,
          ).content,
          files: bundle.files.map((file) => file.name),
        };
      })
      .catch((error) => {
        throw skillFileError(error);
      });
  }
  async create(
    bundles: SkillBundle[],
    source: InstalledSkill["source"],
    sourceLabel: string,
    transaction?: PoolClient,
  ) {
    await this.db.init();
    const created: InstalledSkill[] = [],
      paths: string[] = [];
    try {
      const persist = async (tx: PoolClient) => {
        await this.lock(tx);
        for (const bundle of bundles) {
          const existing = await tx.query(
            `SELECT id FROM ${this.db.table("installed_skills")} WHERE name=$1`,
            [bundle.name],
          );
          if (existing.rowCount)
            throw skillError(
              `技能 ${bundle.name} 已安装；请先卸载旧版本，不会自动覆盖`,
              409,
            );
        }
        for (const bundle of bundles) {
          const skill: InstalledSkill = {
            id: randomUUID(),
            name: bundle.name,
            description: bundle.description,
            source,
            sourceLabel,
            sha256: bundle.sha256,
            size: bundle.size,
            fileCount: bundle.files.length,
            enabled: true,
            createdAt: new Date().toISOString(),
          };
          const directory = this.installed(skill.id);
          paths.push(directory);
          await this.writeBundle(directory, bundle);
          await tx.query(
            `INSERT INTO ${this.db.table("installed_skills")}(id,name,enabled,created_at,data) VALUES($1,$2,$3,$4,$5)`,
            [
              skill.id,
              skill.name,
              true,
              skill.createdAt,
              JSON.stringify(skill),
            ],
          );
          created.push(skill);
        }
      };
      if (transaction) await persist(transaction);
      else await this.db.transaction(persist);
      return created;
    } catch (error) {
      await Promise.all(
        paths.map((directory) =>
          rm(directory, { recursive: true, force: true }),
        ),
      );
      throw skillFileError(error);
    }
  }
  private async writeBundle(directory: string, bundle: SkillBundle) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const file of bundle.files) {
      const destination = path.join(directory, file.name);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.data, { mode: 0o600, flag: "wx" });
    }
  }
  async upload(name: string, dataBase64: string) {
    if (
      !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64) ||
      dataBase64.length % 4 ||
      dataBase64.length > Math.ceil(MAX_SKILL_UPLOAD_BYTES / 3) * 4
    )
      throw skillError("上传文件无效或超过 10 MiB");
    const data = Buffer.from(dataBase64, "base64");
    if (
      !data.length ||
      data.length > MAX_SKILL_UPLOAD_BYTES ||
      data.toString("base64") !== dataBase64
    )
      throw skillError("上传文件无效或超过 10 MiB");
    if (
      name.length > 200 ||
      name !== path.basename(name) ||
      /[\\\x00-\x1f]/.test(name)
    )
      throw skillError("上传文件名无效");
    const files =
      name.toUpperCase() === "SKILL.MD"
        ? [{ name: "SKILL.md", data }]
        : /\.zip$/i.test(name)
          ? readSkillZip(data)
          : undefined;
    if (!files) throw skillError("请上传 SKILL.md 或 ZIP 技能包");
    return this.create(bundleSkills(files), "upload", name);
  }
  async install(
    source: string,
    skillNames?: string[],
    options: SkillInstallerOptions = {},
  ) {
    const normalized = normalizeSkillSource(source);
    await this.db.init();
    // A separate advisory lock bounds concurrent npm/git work across server processes.
    return this.db.transaction(async (tx) => {
      const locked = await tx.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
        ["pilot-skill-installer:" + this.db.schema],
      );
      if (!locked.rows[0]?.locked)
        throw skillError("已有技能正在安装，请稍后重试", 409);
      const bundles = await fetchSkillBundles(
        this.dataRoot,
        normalized,
        skillNames,
        options,
      );
      return this.create(
        bundles,
        "npx",
        "https://github.com/" + normalized,
        tx,
      );
    });
  }
  async setEnabled(id: string, enabled: boolean) {
    await this.db.init();
    return this.db.transaction(async (tx) => {
      await this.lock(tx);
      const skill = (
        await tx.query<{ data: InstalledSkill }>(
          `SELECT data FROM ${this.db.table("installed_skills")} WHERE id=$1`,
          [id],
        )
      ).rows[0]?.data;
      if (!skill) throw skillError("技能不存在", 404);
      const updated = { ...skill, enabled };
      await tx.query(
        `UPDATE ${this.db.table("installed_skills")} SET enabled=$2,data=$3 WHERE id=$1`,
        [id, enabled, JSON.stringify(updated)],
      );
      if (!enabled)
        await tx.query(
          `DELETE FROM ${this.db.table("project_skills")} WHERE skill_id=$1`,
          [id],
        );
      return updated;
    });
  }
  async delete(id: string) {
    await this.db.init();
    await this.db.transaction(async (tx) => {
      await this.lock(tx);
      const result = await tx.query(
        `DELETE FROM ${this.db.table("installed_skills")} WHERE id=$1`,
        [id],
      );
      if (!result.rowCount) throw skillError("技能不存在", 404);
    });
    // A failed database commit must not remove an installed skill's only copy.
    // Run snapshots are separate and remain readable after uninstall.
    try {
      await rm(this.installed(id), { recursive: true, force: true });
      return { deleted: true };
    } catch {
      return {
        deleted: true,
        warning: "技能已卸载，但旧文件清理失败，请检查本地磁盘权限",
      };
    }
  }
  private async selected(tx: PoolClient, projectId: string) {
    const project = await tx.query(
      `SELECT id FROM ${this.db.table("projects")} WHERE id=$1`,
      [projectId],
    );
    if (!project.rowCount) throw skillError("项目不存在", 404);
    const items = (
      await tx.query<{ data: InstalledSkill }>(
        `SELECT s.data FROM ${this.db.table("project_skills")} p JOIN ${this.db.table("installed_skills")} s ON s.id=p.skill_id WHERE p.project_id=$1 ORDER BY p.position`,
        [projectId],
      )
    ).rows.map((row) => row.data);
    return { skillIds: items.map((skill) => skill.id), items };
  }
  async projectSkills(projectId: string) {
    await this.db.init();
    return this.db.transaction((tx) => this.selected(tx, projectId));
  }
  async select(projectId: string, skillIds: string[]) {
    projectSkillsSchema.parse({ skillIds });
    await this.db.init();
    return this.db.transaction(async (tx) => {
      await this.lock(tx);
      await this.selected(tx, projectId);
      for (const id of skillIds) {
        const result = await tx.query(
          `SELECT id FROM ${this.db.table("installed_skills")} WHERE id=$1 AND enabled=true`,
          [id],
        );
        if (!result.rowCount)
          throw skillError("所选技能已卸载或停用，请刷新后重新选择", 409);
      }
      await tx.query(
        `DELETE FROM ${this.db.table("project_skills")} WHERE project_id=$1`,
        [projectId],
      );
      for (let position = 0; position < skillIds.length; position++)
        await tx.query(
          `INSERT INTO ${this.db.table("project_skills")}(project_id,skill_id,position) VALUES($1,$2,$3)`,
          [projectId, skillIds[position], position],
        );
      return this.selected(tx, projectId);
    });
  }
  async resolveForRun(projectId: string, runId: string): Promise<RunSkill[]> {
    idSchema.parse(projectId);
    idSchema.parse(runId);
    await this.db.init();
    const runRoot = path.resolve(
      this.dataRoot,
      "projects",
      projectId,
      "runs",
      runId,
    );
    const stage = path.join(runRoot, ".skills-" + randomUUID()),
      final = path.join(runRoot, "skills");
    try {
      return await this.db.transaction(async (tx) => {
        await this.lock(tx);
        const { items } = await this.selected(tx, projectId);
        if (!items.length) return [];
        const result: RunSkill[] = [];
        let markdownBytes = 0;
        for (const skill of items) {
          if (!skill.enabled)
            throw skillError("项目选择了已停用技能，请重新选择", 409);
          const bundles = bundleSkills(
            await readSkillDirectory(this.installed(skill.id)),
          );
          if (
            bundles.length !== 1 ||
            bundles[0].sha256 !== skill.sha256 ||
            bundles[0].name !== skill.name
          )
            throw skillError("技能文件发生变化，请卸载后重新安装", 409);
          markdownBytes += bundles[0].files.find(
            (file) => file.name === "SKILL.md",
          )!.data.length;
          if (markdownBytes > MAX_RUN_SKILL_MARKDOWN_BYTES)
            throw skillError(
              "所选技能正文合计超过 256 KiB，请减少当前项目选用的技能",
              413,
            );
          await this.writeBundle(path.join(stage, skill.id), bundles[0]);
          result.push({
            id: skill.id,
            name: skill.name,
            sha256: skill.sha256,
            path: path.join(final, skill.id, "SKILL.md"),
          });
        }
        await rename(stage, final);
        return result;
      });
    } catch (error: any) {
      if (error.code === "ENOENT")
        throw skillError("技能文件丢失，请卸载后重新安装", 409);
      throw skillFileError(error);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
}
