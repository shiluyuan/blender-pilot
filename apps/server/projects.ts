import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { idSchema, type Project } from "../../packages/contracts/index.js";
import {
  createProjectSchema,
  renameProjectSchema,
} from "../../packages/contracts/projects.js";
import { now, safePath } from "../../packages/contracts/fs.js";
import type { Store } from "./db.js";

/** Project metadata operations; Blender activation is a separate lifecycle. */
export class ProjectService {
  constructor(private store: Store) {}
  list() {
    return this.store.list<Project>("project");
  }
  async get(id: string) {
    idSchema.parse(id);
    const project = await this.store.get<Project>("project", id);
    if (!project)
      throw Object.assign(new Error("项目不存在"), { statusCode: 404 });
    return project;
  }
  async create(body: unknown): Promise<Project> {
    const input = createProjectSchema.parse(body);
    const requestId = input.requestId || randomUUID();
    return this.store.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "create-project:" + this.store.db.schema + ":" + requestId,
      ]);
      const key = "project-request:" + requestId;
      const receipt = await this.store.get<{ name: string; projectId: string }>(
        "config",
        key,
        tx,
      );
      if (receipt) {
        if (receipt.name !== input.name)
          throw Object.assign(new Error("创建编号已用于其他名称"), {
            statusCode: 409,
          });
        const project = await this.store.get<Project>(
          "project",
          receipt.projectId,
          tx,
        );
        if (!project)
          throw Object.assign(new Error("创建记录对应的项目不存在"), {
            statusCode: 409,
          });
        return project;
      }
      const project: Project = {
        id: randomUUID(),
        name: input.name,
        createdAt: now(),
        updatedAt: now(),
      };
      await mkdir(safePath(this.store.root, "projects", project.id), {
        recursive: true,
      });
      await this.store.put("project", project.id, project, tx);
      await this.store.put(
        "config",
        key,
        { name: input.name, projectId: project.id },
        tx,
      );
      return project;
    });
  }
  async rename(id: string, body: unknown) {
    const { name } = renameProjectSchema.parse(body);
    const project = await this.get(id);
    project.name = name;
    project.updatedAt = now();
    await this.store.put("project", id, project);
    return project;
  }
}
