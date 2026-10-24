import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  MAX_SKILL_UPLOAD_BYTES,
  SKILL_INSTALLER,
  installSkillsSchema,
  projectSkillsSchema,
} from "../../packages/contracts/skills.js";
import { SkillCatalog } from "../../packages/storage/skill-catalog.js";
import { idSchema } from "../../packages/contracts/index.js";
import { installerAvailability } from "../../packages/storage/skill-installer.js";
import type { Store } from "./db.js";

export function registerSkillRoutes(app: FastifyInstance, store: Store) {
  const catalog = new SkillCatalog(store.db, store.root);
  const id = z.string().uuid();
  app.get("/api/skills", async () => ({
    items: await catalog.list(),
    installer: { package: SKILL_INSTALLER, ...(await installerAvailability()) },
  }));
  app.get("/api/skills/:id", async (req) =>
    catalog.detail(id.parse((req.params as any).id)),
  );
  app.post(
    "/api/skills/upload",
    { bodyLimit: Math.ceil(MAX_SKILL_UPLOAD_BYTES / 3) * 4 + 2048 },
    async (req, reply) => {
      const input = z
        .object({
          name: z.string().min(1).max(200),
          dataBase64: z.string().max(Math.ceil(MAX_SKILL_UPLOAD_BYTES / 3) * 4),
        })
        .strict()
        .parse(req.body);
      return reply
        .code(201)
        .send({ items: await catalog.upload(input.name, input.dataBase64) });
    },
  );
  app.post("/api/skills/install", async (req, reply) => {
    const input = installSkillsSchema.parse(req.body);
    return reply
      .code(201)
      .send({ items: await catalog.install(input.source, input.skillNames) });
  });
  app.patch("/api/skills/:id", async (req) => {
    const input = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    return catalog.setEnabled(id.parse((req.params as any).id), input.enabled);
  });
  app.delete("/api/skills/:id", async (req) =>
    catalog.delete(id.parse((req.params as any).id)),
  );
  app.get("/api/projects/:projectId/skills", async (req) =>
    catalog.projectSkills(idSchema.parse((req.params as any).projectId)),
  );
  app.put("/api/projects/:projectId/skills", async (req) => {
    const input = projectSkillsSchema.parse(req.body);
    return catalog.select(
      idSchema.parse((req.params as any).projectId),
      input.skillIds,
    );
  });
}
