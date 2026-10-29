import type { FastifyInstance } from "fastify";
import type { ProjectService } from "./projects.js";
export function registerProjectRoutes(
  app: FastifyInstance,
  projects: ProjectService,
) {
  app.get("/api/projects", async () => projects.list());
  app.post("/api/projects", async (req) => projects.create(req.body));
  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (req) =>
    projects.rename(req.params.id, req.body),
  );
}
