import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import {
  MAX_SKILL_UPLOAD_BYTES,
  MAX_SKILL_EXPANDED_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_MARKDOWN_BYTES,
  MAX_PROJECT_SKILLS,
  skillNameSchema,
} from "../contracts/skills.js";

export const skillError = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
export function skillFileError(error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR")
    return skillError("技能文件不存在，请重新安装或选择有效资源", 404);
  if (code === "ENOSPC")
    return skillError("本地磁盘空间不足，无法保存技能文件", 507);
  if (
    code &&
    [
      "EACCES",
      "EPERM",
      "EIO",
      "EROFS",
      "ELOOP",
      "EMFILE",
      "ENFILE",
      "EEXIST",
    ].includes(code)
  )
    return skillError("技能文件无法访问，请检查本地磁盘或重新安装", 409);
  return error;
}
export interface SkillFile {
  name: string;
  data: Buffer;
}
export interface SkillBundle {
  name: string;
  description: string;
  files: SkillFile[];
  sha256: string;
  size: number;
}

export function safeSkillFileName(name: string) {
  if (
    !name ||
    name.length > 240 ||
    /[\\\x00-\x1f\x7f:]/.test(name) ||
    name.startsWith("/") ||
    name
      .split("/")
      .some(
        (p) =>
          !p || p === "." || p === ".." || p === ".git" || p === "node_modules",
      )
  )
    throw skillError("技能包含不允许的文件路径");
  return name;
}

function utf8(data: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw skillError("SKILL.md 必须是 UTF-8 文本");
  }
}
export function parseSkillMarkdown(data: Buffer) {
  if (
    !data.length ||
    data.length > MAX_SKILL_MARKDOWN_BYTES ||
    data.includes(0)
  )
    throw skillError("SKILL.md 必须是 64 KiB 以内的文本");
  const content = utf8(data).replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match || match[1].length > 16384)
    throw skillError("SKILL.md 需要 YAML 头部中的 name 和 description");
  const doc = parseDocument(match[1], { uniqueKeys: true });
  if (doc.errors.length) throw skillError("SKILL.md 的 YAML 头部无效");
  let metadata: any;
  try {
    metadata = doc.toJS({ maxAliasCount: 10 });
  } catch {
    throw skillError("SKILL.md 的 YAML 引用过于复杂");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw skillError("SKILL.md 的 YAML 头部无效");
  const name = skillNameSchema.safeParse(metadata.name);
  if (!name.success)
    throw skillError("技能名称必须为 1–64 位小写字母、数字及单个连字符");
  if (
    typeof metadata.description !== "string" ||
    !metadata.description.trim() ||
    metadata.description.length > 2000 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(metadata.description)
  )
    throw skillError("技能描述必须为 1–2000 字符的文本");
  if (!content.slice(match[0].length).trim())
    throw skillError("SKILL.md 缺少技能正文");
  return { name: name.data, description: metadata.description.trim(), content };
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function skillCRC32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Ordinary single-disk ZIP only. Preflight all lengths before bounded inflation. */
export function readSkillZip(
  zip: Buffer,
  limits = {
    upload: MAX_SKILL_UPLOAD_BYTES,
    expanded: MAX_SKILL_EXPANDED_BYTES,
    files: MAX_SKILL_FILES,
  },
): SkillFile[] {
  if (!zip.length || zip.length > limits.upload)
    throw skillError(`压缩包不能超过 ${limits.upload / 1024 ** 2} MiB`);
  let eocd = -1;
  for (let p = zip.length - 22; p >= Math.max(0, zip.length - 65557); p--) {
    if (
      zip.readUInt32LE(p) === 0x06054b50 &&
      p + 22 + zip.readUInt16LE(p + 20) === zip.length
    ) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) throw skillError("无效 ZIP 压缩包");
  const count = zip.readUInt16LE(eocd + 10),
    centralSize = zip.readUInt32LE(eocd + 12),
    centralOffset = zip.readUInt32LE(eocd + 16);
  if (
    zip.readUInt16LE(eocd + 4) ||
    zip.readUInt16LE(eocd + 6) ||
    zip.readUInt16LE(eocd + 8) !== count ||
    !count ||
    count > limits.files ||
    centralOffset + centralSize !== eocd
  )
    throw skillError(
      `压缩包结构不受支持，最多允许 ${limits.files} 个文件及目录`,
    );
  const entries: Array<{
    name: string;
    start: number;
    compressed: number;
    expanded: number;
    crc: number;
    method: number;
    directory: boolean;
  }> = [];
  const names = new Set<string>(),
    ranges: Array<[number, number]> = [];
  let p = centralOffset,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || zip.readUInt32LE(p) !== 0x02014b50)
      throw skillError("无效 ZIP 目录");
    const flags = zip.readUInt16LE(p + 8),
      method = zip.readUInt16LE(p + 10),
      crc = zip.readUInt32LE(p + 16),
      compressed = zip.readUInt32LE(p + 20),
      expanded = zip.readUInt32LE(p + 24);
    const nameLength = zip.readUInt16LE(p + 28),
      extraLength = zip.readUInt16LE(p + 30),
      commentLength = zip.readUInt16LE(p + 32),
      offset = zip.readUInt32LE(p + 42);
    if (
      p + 46 + nameLength + extraLength + commentLength > eocd ||
      flags & ~0x080e ||
      ![0, 8].includes(method) ||
      zip.readUInt16LE(p + 34) !== 0
    )
      throw skillError("不支持加密或特殊 ZIP 格式");
    const rawName = zip.subarray(p + 46, p + 46 + nameLength),
      decoded = utf8(rawName),
      directory = decoded.endsWith("/");
    const name = safeSkillFileName(directory ? decoded.slice(0, -1) : decoded);
    const modeType = (zip.readUInt32LE(p + 38) >>> 16) & 0xf000;
    if (modeType && modeType !== (directory ? 0x4000 : 0x8000))
      throw skillError("技能包不能包含符号链接或特殊文件");
    if (names.has(name)) throw skillError("技能压缩包包含重复文件名");
    names.add(name);
    if (directory && (expanded || compressed))
      throw skillError("无效 ZIP 目录条目");
    total += expanded;
    if (total > limits.expanded || compressed > limits.upload)
      throw skillError(`解压后不能超过 ${limits.expanded / 1024 ** 2} MiB`);
    if (offset + 30 > centralOffset || zip.readUInt32LE(offset) !== 0x04034b50)
      throw skillError("无效 ZIP 文件头");
    const localNameLength = zip.readUInt16LE(offset + 26),
      localExtraLength = zip.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLength + localExtraLength;
    if (
      start + compressed > centralOffset ||
      zip.readUInt16LE(offset + 6) !== flags ||
      zip.readUInt16LE(offset + 8) !== method ||
      !zip.subarray(offset + 30, offset + 30 + localNameLength).equals(rawName)
    )
      throw skillError("ZIP 文件头与目录不一致");
    if (
      !(flags & 8) &&
      (zip.readUInt32LE(offset + 14) !== crc ||
        zip.readUInt32LE(offset + 18) !== compressed ||
        zip.readUInt32LE(offset + 22) !== expanded)
    )
      throw skillError("ZIP 大小校验失败");
    if (ranges.some(([a, b]) => offset < b && start + compressed > a))
      throw skillError("ZIP 文件区域重叠");
    ranges.push([offset, start + compressed]);
    entries.push({ name, start, compressed, expanded, crc, method, directory });
    p += 46 + nameLength + extraLength + commentLength;
  }
  if (p !== eocd) throw skillError("ZIP 目录长度不一致");
  const files: SkillFile[] = [];
  for (const entry of entries) {
    if (entry.directory) continue;
    let data: Buffer;
    try {
      const packed = zip.subarray(entry.start, entry.start + entry.compressed);
      data =
        entry.method === 0
          ? Buffer.from(packed)
          : inflateRawSync(packed, {
              maxOutputLength: Math.max(1, entry.expanded),
            });
    } catch {
      throw skillError("ZIP 解压失败或文件超出声明大小");
    }
    if (data.length !== entry.expanded || skillCRC32(data) !== entry.crc)
      throw skillError("ZIP 文件校验失败");
    files.push({ name: entry.name, data });
  }
  return files;
}

export function bundleSkills(files: SkillFile[]): SkillBundle[] {
  if (
    !files.length ||
    files.length > MAX_SKILL_FILES ||
    files.reduce((n, f) => n + f.data.length, 0) > MAX_SKILL_EXPANDED_BYTES
  )
    throw skillError("技能文件数量或大小超过限制");
  const names = new Set<string>();
  for (const file of files) {
    safeSkillFileName(file.name);
    if (names.has(file.name)) throw skillError("技能包包含重复文件");
    names.add(file.name);
  }
  const manifests = files.filter(
    (file) => file.name === "SKILL.md" || file.name.endsWith("/SKILL.md"),
  );
  if (!manifests.length || manifests.length > MAX_PROJECT_SKILLS)
    throw skillError("技能包应包含 1–20 个 SKILL.md");
  const roots = manifests.map((file) => file.name.slice(0, -8));
  if (
    roots.some((root, i) =>
      roots.some((other, j) => i !== j && other.startsWith(root)),
    )
  )
    throw skillError("技能目录不能相互嵌套");
  const bundles = manifests.map((manifest, index) => {
    const root = roots[index],
      metadata = parseSkillMarkdown(manifest.data);
    const owned = files
      .filter((file) => file.name.startsWith(root))
      .map((file) => ({ name: file.name.slice(root.length), data: file.data }))
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
    const hash = createHash("sha256");
    for (const file of owned) {
      hash.update(file.name);
      hash.update("\0");
      hash.update(String(file.data.length));
      hash.update("\0");
      hash.update(file.data);
    }
    return {
      name: metadata.name,
      description: metadata.description,
      files: owned,
      sha256: hash.digest("hex"),
      size: owned.reduce((n, file) => n + file.data.length, 0),
    };
  });
  if (new Set(bundles.map((bundle) => bundle.name)).size !== bundles.length)
    throw skillError("技能包包含同名技能");
  return bundles;
}

export async function readSkillDirectory(root: string): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  let size = 0,
    entries = 0;
  async function walk(dir: string, prefix = "") {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw skillError("技能安装目录不能是符号链接");
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++entries > MAX_SKILL_FILES)
        throw skillError("技能包最多允许 500 个文件及目录");
      const name = safeSkillFileName(prefix + entry.name),
        file = path.join(dir, entry.name),
        stat = await lstat(file);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        throw skillError("技能包不能包含符号链接或特殊文件");
      if (stat.isDirectory()) await walk(file, name + "/");
      else {
        size += stat.size;
        if (size > MAX_SKILL_EXPANDED_BYTES)
          throw skillError("技能解压后不能超过 50 MiB");
        const data = await readFile(file);
        if (data.length !== stat.size)
          throw skillError("技能文件在安装期间发生变化");
        files.push({ name, data });
      }
    }
  }
  await walk(root);
  return files;
}
