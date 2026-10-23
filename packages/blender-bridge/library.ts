import { randomUUID, createHash } from "node:crypto";
import { mkdir, readdir, readFile, copyFile, stat, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  atomicJson,
  existingSafePath,
  now,
  safePath,
} from "../contracts/fs.js";
import { idSchema } from "../contracts/index.js";
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
  mime: string;
  size: number;
  sha256: string;
  createdAt: string;
  source: "blender" | "upload";
  objectNames: string[];
};
export class AssetLibrary {
  constructor(public dataRoot: string) {}
  root(id?: string) {
    return id
      ? safePath(this.dataRoot, "library", idSchema.parse(id))
      : safePath(this.dataRoot, "library");
  }
  async get(id: string): Promise<LibraryAsset> {
    const file = await existingSafePath(
      this.root(id),
      path.join(this.root(id), "asset.json"),
    );
    const asset = JSON.parse(await readFile(file, "utf8")) as LibraryAsset;
    if (asset.id !== id) throw new Error("素材标识不匹配");
    return asset;
  }
  async file(id: string, preview = false) {
    const asset = await this.get(id);
    if (preview && !asset.previewPath) throw new Error("素材没有预览图");
    return existingSafePath(
      this.root(id),
      preview ? asset.previewPath! : asset.path,
    );
  }
  async list(
    query: {
      search?: string;
      category?: string;
      favorite?: boolean;
      page?: number;
    } = {},
  ) {
    await mkdir(this.root(), { recursive: true });
    const items: LibraryAsset[] = [];
    for (const entry of await readdir(this.root(), { withFileTypes: true })) {
      if (!entry.isDirectory() || !idSchema.safeParse(entry.name).success)
        continue;
      try {
        items.push(await this.get(entry.name));
      } catch {
        /* Uncommitted/invalid entries are not published. */
      }
    }
    const search = (query.search || "").toLocaleLowerCase().trim();
    const filtered = items
      .filter(
        (a) =>
          (!query.category ||
            query.category === "all" ||
            a.category === query.category) &&
          (!query.favorite || a.favorite) &&
          (!search ||
            [a.name, a.description, ...a.tags]
              .join(" ")
              .toLocaleLowerCase()
              .includes(search)),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const page = Math.min(100000, Math.max(0, Math.floor(query.page || 0)));
    return {
      items: filtered.slice(page * 60, page * 60 + 60),
      total: filtered.length,
      page,
    };
  }
  async update(id: string, input: unknown) {
    const patch = z
      .object({
        name: libraryMetadataSchema.shape.name.optional(),
        sourceUrl: libraryMetadataSchema.shape.sourceUrl
          .removeDefault()
          .optional(),
        license: libraryMetadataSchema.shape.license.removeDefault().optional(),
        author: libraryMetadataSchema.shape.author.removeDefault().optional(),
        category: libraryMetadataSchema.shape.category
          .removeDefault()
          .optional(),
        description: libraryMetadataSchema.shape.description
          .removeDefault()
          .optional(),
        tags: libraryMetadataSchema.shape.tags.removeDefault().optional(),
        favorite: libraryMetadataSchema.shape.favorite
          .removeDefault()
          .optional(),
      })
      .parse(input);
    const asset = { ...(await this.get(id)), ...patch };
    await atomicJson(path.join(this.root(id), "asset.json"), asset);
    return asset;
  }
  async publish(
    input: z.infer<typeof libraryMetadataSchema>,
    source: {
      id?: string;
      projectId?: string;
      file: string;
      preview?: string;
      mime: string;
      source: LibraryAsset["source"];
      objectNames?: string[];
      sourceAssetIds?: string[];
    },
  ) {
    const id = source.id || randomUUID(),
      dir = this.root(id);
    await mkdir(dir, { recursive: true });
    try {
      const file = path.join(
        dir,
        "asset" + path.extname(source.file).toLowerCase(),
      );
      if (file !== source.file) await copyFile(source.file, file);
      let previewPath: string | undefined;
      if (source.preview) {
        previewPath = path.join(dir, "preview.jpg");
        if (source.preview !== previewPath)
          await copyFile(source.preview, previewPath);
      }
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      const asset: LibraryAsset = {
        ...libraryMetadataSchema.parse(input),
        id,
        sourceProjectId: source.projectId,
        sourceAssetIds: source.sourceAssetIds || [],
        path: file,
        previewPath,
        mime: source.mime,
        size: (await stat(file)).size,
        sha256: hash.digest("hex"),
        createdAt: now(),
        source: source.source,
        objectNames: source.objectNames || [],
      };
      await atomicJson(path.join(dir, "asset.json"), asset);
      return asset;
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
  }
}
