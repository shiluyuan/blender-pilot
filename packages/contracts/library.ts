import { z } from "zod";
export const categories = [
  "character",
  "prop",
  "scene",
  "material",
  "other",
] as const;
export const libraryMetadataSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.enum(categories).default("prop"),
  description: z.string().max(2000).default(""),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  favorite: z.boolean().default(false),
  sourceUrl: z
    .string()
    .max(1000)
    .refine(
      (s) =>
        s === "" ||
        (() => {
          try {
            return ["http:", "https:"].includes(new URL(s).protocol);
          } catch {
            return false;
          }
        })(),
      "来源需为 HTTP(S) 地址",
    )
    .default(""),
  license: z.string().max(300).default(""),
  author: z.string().max(200).default(""),
});
export const saveLibrarySchema = libraryMetadataSchema.extend({
  scope: z.enum(["selection", "scene"]).default("selection"),
  objectNames: z.array(z.string().min(1).max(200)).max(500).optional(),
});
export type LibraryAsset = z.infer<typeof libraryMetadataSchema> & {
  id: string;
  sourceProjectId?: string;
  sourceAssetIds?: string[];
  path: string;
  previewPath?: string;
  package?: { entry: string; files: number; expandedBytes: number };
  mime: string;
  size: number;
  sha256: string;
  createdAt: string;
  source: "blender" | "upload";
  objectNames: string[];
};
