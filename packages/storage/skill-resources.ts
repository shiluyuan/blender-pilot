import { lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { RunSkill } from "../contracts/skills.js";
import {
  MAX_PROJECT_SKILLS,
  MAX_RUN_SKILL_MARKDOWN_BYTES,
  skillNameSchema,
} from "../contracts/skills.js";
import { idSchema } from "../contracts/index.js";
import { z } from "zod";
import {
  bundleSkills,
  readSkillDirectory,
  safeSkillFileName,
  skillError,
  skillFileError,
} from "./skill-bundle.js";

export type SkillResourceContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" };
export async function verifyRunSkills(
  dataRoot: string,
  projectId: string,
  runId: string,
  skills: RunSkill[],
) {
  try {
    return await verifyRunSkillsInternal(dataRoot, projectId, runId, skills);
  } catch (error) {
    throw skillFileError(error);
  }
}
async function verifyRunSkillsInternal(
  dataRoot: string,
  projectId: string,
  runId: string,
  skills: RunSkill[],
) {
  idSchema.parse(projectId);
  idSchema.parse(runId);
  if (
    skills.length > MAX_PROJECT_SKILLS ||
    new Set(skills.map((skill) => skill.id)).size !== skills.length ||
    new Set(skills.map((skill) => skill.name)).size !== skills.length
  )
    throw skillError("任务技能列表无效");
  let markdownBytes = 0;
  for (const skill of skills) {
    z.string().uuid().parse(skill.id);
    skillNameSchema.parse(skill.name);
    if (!/^[a-f0-9]{64}$/.test(skill.sha256))
      throw skillError("技能快照校验值无效");
    const expected = path.resolve(
      dataRoot,
      "projects",
      projectId,
      "runs",
      runId,
      "skills",
      skill.id,
      "SKILL.md",
    );
    if (skill.path !== expected)
      throw skillError("技能快照不属于当前任务", 403);
    const base = path.dirname(expected);
    if ((await realpath(base)) !== base)
      throw skillError("技能快照目录不能包含符号链接", 403);
    const bundles = bundleSkills(await readSkillDirectory(base));
    if (
      bundles.length !== 1 ||
      bundles[0].name !== skill.name ||
      bundles[0].sha256 !== skill.sha256
    )
      throw skillError("技能快照文件校验失败", 409);
    markdownBytes += bundles[0].files.find((file) => file.name === "SKILL.md")!
      .data.length;
    if (markdownBytes > MAX_RUN_SKILL_MARKDOWN_BYTES)
      throw skillError("任务技能正文合计超过 256 KiB", 413);
  }
}
/** Read only from this run's selected immutable skill copies, never global/host files. */
export async function readSkillResource(
  skills: RunSkill[],
  skillId: string,
  relativePath: string,
): Promise<SkillResourceContent[]> {
  try {
    return await readSkillResourceInternal(skills, skillId, relativePath);
  } catch (error) {
    throw skillFileError(error);
  }
}
async function readSkillResourceInternal(
  skills: RunSkill[],
  skillId: string,
  relativePath: string,
): Promise<SkillResourceContent[]> {
  const skill = skills.find((item) => item.id === skillId);
  if (!skill) throw skillError("该技能不属于当前任务", 403);
  safeSkillFileName(relativePath);
  const base = path.dirname(skill.path);
  const actualBase = await realpath(base);
  if (actualBase !== path.resolve(base))
    throw skillError("技能目录不能包含符号链接", 403);
  let candidate = base;
  for (const part of relativePath.split("/")) {
    candidate = path.join(candidate, part);
    if ((await lstat(candidate)).isSymbolicLink())
      throw skillError("技能资源不能是符号链接", 403);
  }
  const actual = await realpath(candidate);
  if (!actual.startsWith(actualBase + path.sep))
    throw skillError("技能资源超出目录", 403);
  const handle = await open(
    candidate,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat(),
      image = /\.(png|jpe?g|webp)$/i.test(relativePath);
    const limit = image ? 5 * 1024 * 1024 : 128 * 1024;
    if (!stat.isFile() || stat.size > limit)
      throw skillError(
        image ? "技能图片超过 5 MiB" : "技能文本资源超过 128 KiB",
      );
    const data = await handle.readFile();
    if (data.length > limit) throw skillError("技能资源大小超过限制");
    if (image) {
      const pngSignature = data
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpegSignature =
        data.length >= 3 &&
        data[0] === 255 &&
        data[1] === 216 &&
        data[2] === 255;
      const webpSignature =
        data.subarray(0, 4).toString("ascii") === "RIFF" &&
        data.subarray(8, 12).toString("ascii") === "WEBP";
      if (!pngSignature && !jpegSignature && !webpSignature)
        throw skillError("技能图片只支持 PNG、JPEG 或 WebP");
      try {
        const png = await sharp(data, {
          limitInputPixels: 40 * 1024 * 1024,
          animated: false,
        })
          .resize({
            width: 1280,
            height: 1280,
            fit: "inside",
            withoutEnlargement: true,
          })
          .png()
          .toBuffer();
        return [
          {
            type: "image",
            data: png.toString("base64"),
            mimeType: "image/png",
          },
        ];
      } catch {
        throw skillError("技能图片无效或解码后过大");
      }
    }
    if (data.includes(0)) throw skillError("该资源不是可读取的文本或图片");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw skillError("技能文本资源必须为 UTF-8");
    }
    return [{ type: "text", text }];
  } finally {
    await handle.close();
  }
}
