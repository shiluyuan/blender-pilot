import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  TEMPLATE_CATEGORIES,
  templateInputSchema,
} from "../../packages/contracts/templates.js";
import { TemplateCatalog } from "../../packages/storage/template-catalog.js";
import type { Store } from "./db.js";

const id = z
  .string()
  .max(100)
  .refine(
    (value) =>
      /^builtin:[a-z]+$/.test(value) ||
      z.string().uuid().safeParse(value).success,
    "模板编号不正确",
  );
const versionSchema = z.number().int().min(1).max(2147483646);
export function registerTemplateRoutes(app: FastifyInstance, store: Store) {
  const catalog = new TemplateCatalog(store.db);
  app.get("/api/templates", async (req) => {
    const query = z
      .object({
        search: z.string().trim().max(200).optional(),
        category: z.enum(["all", ...TEMPLATE_CATEGORIES]).optional(),
        source: z.enum(["all", "builtin", "custom"]).optional(),
        page: z.coerce.number().int().min(0).max(100000).optional(),
      })
      .strict()
      .parse(req.query);
    return catalog.list(query);
  });
  app.get("/api/templates/:id", async (req) =>
    catalog.detail(id.parse((req.params as any).id)),
  );
  app.post("/api/templates", async (req, reply) =>
    reply
      .code(201)
      .send(await catalog.create(templateInputSchema.parse(req.body))),
  );
  app.patch("/api/templates/:id", async (req) => {
    const { expectedVersion, ...input } = z
      .object({ expectedVersion: versionSchema })
      .passthrough()
      .parse(req.body);
    return catalog.update(
      id.parse((req.params as any).id),
      expectedVersion,
      templateInputSchema.parse(input),
    );
  });
  app.delete("/api/templates/:id", async (req) => {
    const { expectedVersion } = z
      .object({ expectedVersion: versionSchema })
      .strict()
      .parse(req.body);
    return catalog.delete(id.parse((req.params as any).id), expectedVersion);
  });
}
