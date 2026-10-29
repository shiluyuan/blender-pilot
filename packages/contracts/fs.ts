import { mkdir, writeFile, rename, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
export async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}
export function safePath(root: string, ...parts: string[]) {
  const resolved = path.resolve(root, ...parts);
  if (
    resolved !== path.resolve(root) &&
    !resolved.startsWith(path.resolve(root) + path.sep)
  )
    throw new Error("路径超出项目目录");
  return resolved;
}
export async function existingSafePath(root: string, file: string) {
  const [base, actual] = await Promise.all([
    realpath(root),
    realpath(safePath(root, file)),
  ]);
  if (!actual.startsWith(base + path.sep)) throw new Error("文件不属于项目");
  return actual;
}
export const now = () => new Date().toISOString();
export function redact(value: string, secrets: string[] = []) {
  let s = value.replace(/(Bearer\s+)[\w.\-]+/gi, "$1[redacted]");
  for (const secret of secrets)
    if (secret.length > 3) s = s.split(secret).join("[redacted]");
  return s;
}
