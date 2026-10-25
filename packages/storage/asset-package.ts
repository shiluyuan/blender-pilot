import path from "node:path";
import { mkdir, readFile, writeFile, statfs } from "node:fs/promises";
import { readSkillZip } from "./skill-bundle.js";
import { MODEL_EXTENSIONS } from "../contracts/asset-formats.js";

export const ASSET_PACKAGE_LIMITS = {
  upload: 100 * 1024 ** 2,
  expanded: 512 * 1024 ** 2,
  files: 2000,
};
const fail = (message: string) =>
  Object.assign(new Error(message), { statusCode: 400 });
export async function unpackAssetPackage(archive: string, directory: string) {
  const files = readSkillZip(await readFile(archive), ASSET_PACKAGE_LIMITS);
  const names = new Set(files.map((f) => f.name));
  let entry: string | undefined;
  const manifest = files.find((f) => f.name === "pilot-asset.json");
  if (manifest) {
    if (manifest.data.length > 4096) throw fail("pilot-asset.json 过大");
    const data = JSON.parse(manifest.data.toString("utf8"));
    if (typeof data.entry !== "string" || !names.has(data.entry))
      throw fail("素材包入口不存在");
    entry = data.entry;
  } else {
    for (const ext of MODEL_EXTENSIONS) {
      const candidates = files.filter(
        (f) => path.extname(f.name).toLowerCase() === ext,
      );
      if (candidates.length > 1)
        throw fail(
          "素材包包含多个同类型模型，请用 pilot-asset.json 的 entry 指定入口",
        );
      if (candidates.length === 1) {
        entry = candidates[0].name;
        break;
      }
    }
  }
  if (
    !entry ||
    !MODEL_EXTENSIONS.includes(path.extname(entry).toLowerCase() as any)
  )
    throw fail("ZIP 中没有支持的模型入口");
  const checkReference = (from: string, uri: string) => {
    if (uri.startsWith("data:")) return;
    let decoded: string;
    try {
      decoded = decodeURIComponent(uri);
    } catch {
      throw fail("素材引用编码无效");
    }
    if (/^[a-z]+:|^[/\\]|\\|\x00/i.test(decoded))
      throw fail("素材包不允许外部地址或绝对路径");
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(from), decoded),
    );
    if (resolved.startsWith("../") || !names.has(resolved))
      throw fail("素材包缺少依赖：" + uri.slice(0, 120));
    return resolved;
  };
  const disk = await statfs(path.dirname(directory));
  if (
    Number(disk.bavail) * Number(disk.bsize) <
    files.reduce((n, f) => n + f.data.length, 0) + 256 * 1024 ** 2
  )
    throw Object.assign(new Error("解压空间不足"), { statusCode: 507 });
  for (const file of files) {
    if (file.name.toLowerCase().endsWith(".gltf")) {
      const doc = JSON.parse(file.data.toString("utf8"));
      for (const item of [...(doc.buffers || []), ...(doc.images || [])])
        if (item.uri) checkReference(file.name, String(item.uri));
    }
    if (file.name.toLowerCase().endsWith(".obj"))
      for (const line of file.data.toString("utf8").split(/\r?\n/)) {
        const match = /^\s*mtllib\s+(.+)$/.exec(line);
        if (match) checkReference(file.name, match[1].trim());
      }
    if (file.name.toLowerCase().endsWith(".mtl"))
      for (const line of file.data.toString("utf8").split(/\r?\n/)) {
        const match = /^\s*(?:map_\w+|bump|disp|decal|norm)\s+(.+)$/.exec(line);
        if (match) {
          if (match[1].startsWith("-"))
            throw fail("MTL 贴图选项暂不支持，请转换为 GLB 或打包的 blend");
          checkReference(file.name, match[1].trim());
        }
      }
  }
  for (const file of files) {
    const target = path.join(directory, file.name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.data, { flag: "wx", mode: 0o600 });
  }
  return {
    entryPath: path.join(directory, entry),
    entry,
    files: files.length,
    expandedBytes: files.reduce((n, f) => n + f.data.length, 0),
  };
}
