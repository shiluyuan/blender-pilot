import { z } from "zod";

export const SKILL_INSTALLER = "skills@1.7.4";
export const MAX_SKILL_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_SKILL_EXPANDED_BYTES = 50 * 1024 * 1024;
export const MAX_SKILL_FILES = 500;
export const MAX_SKILL_MARKDOWN_BYTES = 64 * 1024;
export const MAX_RUN_SKILL_MARKDOWN_BYTES = 256 * 1024;
export const MAX_PROJECT_SKILLS = 20;
export const skillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "技能名称应为小写字母、数字或连字符");
export interface InstalledSkill {
  id: string;
  name: string;
  description: string;
  source: "upload" | "npx";
  sourceLabel: string;
  sha256: string;
  size: number;
  fileCount: number;
  enabled: boolean;
  createdAt: string;
}
export interface RunSkill {
  id: string;
  name: string;
  path: string;
  sha256: string;
}
export const projectSkillsSchema = z
  .object({
    skillIds: z
      .array(z.string().uuid())
      .max(MAX_PROJECT_SKILLS)
      .refine((ids) => new Set(ids).size === ids.length, "技能不能重复选择"),
  })
  .strict();
export const installSkillsSchema = z
  .object({
    source: z.string().trim().min(3).max(200),
    skillNames: z
      .array(skillNameSchema)
      .min(1)
      .max(MAX_PROJECT_SKILLS)
      .optional(),
  })
  .strict();
