import { z } from "zod";
export const projectNameSchema = z.string().trim().min(1).max(80);
export const createProjectSchema = z.object({
  name: projectNameSchema,
  requestId: z.string().uuid().optional(),
});
export const renameProjectSchema = z.object({ name: projectNameSchema });
export type CreateProjectInput = z.output<typeof createProjectSchema>;
