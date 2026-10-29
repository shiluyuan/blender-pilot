import { randomUUID, createHash } from "node:crypto";
import { mkdir, copyFile, stat, rm, open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { unpackAssetPackage } from "../storage/asset-package.js";
import { existingSafePath, now, safePath } from "../contracts/fs.js";
import { LibraryCatalog } from "../storage/library-catalog.js";
import { idSchema } from "../contracts/index.js";
import {
  libraryMetadataSchema,
  type LibraryAsset,
} from "../contracts/library.js";
// Preserve the previous server-facing import surface for downstream consumers.
export {
  categories,
  libraryMetadataSchema,
  saveLibrarySchema,
  type LibraryAsset,
} from "../contracts/library.js";
export class AssetLibrary {
  constructor(
    public dataRoot: string,
    public catalog = new LibraryCatalog(),
  ) {}
  root(id?: string) {
    return id
      ? safePath(this.dataRoot, "library", idSchema.parse(id))
      : safePath(this.dataRoot, "library");
  }
  async get(id: string): Promise<LibraryAsset> {
    idSchema.parse(id);
    const asset = await this.catalog.get(id);
    if (!asset)
      throw Object.assign(new Error("素材不存在"), { statusCode: 404 });
    return asset;
  }

  async file(id: string, preview = false) {
    const asset = await this.get(id);
    if (preview && !asset.previewPath) throw new Error("素材没有预览图");
    try {
      const file = await existingSafePath(
        this.root(id),
        preview ? asset.previewPath! : asset.path,
      );
      const handle = await open(file, "r");
      try {
        const info = await handle.stat();
        if (!info.isFile() || !info.size)
          throw new Error("内容文件为空或不是文件");
      } finally {
        await handle.close();
      }
      return file;
    } catch {
      throw Object.assign(
        new Error(
          `素材「${asset.name}」的本地文件缺失、不可读或不在素材目录，请恢复文件或重新上传`,
        ),
        { statusCode: 409 },
      );
    }
  }
  async importFile(id: string) {
    const asset = await this.get(id);
    await this.file(id);
    if (!asset.package) return asset.path;
    return existingSafePath(
      path.join(this.root(id), "content"),
      path.join(this.root(id), "content", asset.package.entry),
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
    return this.catalog.list(query);
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
    return this.catalog.update(idSchema.parse(id), patch);
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
      const unpacked =
        path.extname(file).toLowerCase() === ".zip"
          ? await unpackAssetPackage(file, path.join(dir, "content"))
          : undefined;
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
        ...(unpacked
          ? {
              package: {
                entry: unpacked.entry,
                files: unpacked.files,
                expandedBytes: unpacked.expandedBytes,
              },
            }
          : {}),
        mime: source.mime,
        size: (await stat(file)).size,
        sha256: hash.digest("hex"),
        createdAt: now(),
        source: source.source,
        objectNames: source.objectNames || [],
      };
      await this.catalog.create(asset);
      return asset;
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
  }
}
