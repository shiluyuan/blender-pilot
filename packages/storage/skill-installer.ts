import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  MAX_PROJECT_SKILLS,
  SKILL_INSTALLER,
  skillNameSchema,
} from "../contracts/skills.js";
import {
  bundleSkills,
  readSkillDirectory,
  safeSkillFileName,
  skillError,
} from "./skill-bundle.js";

const MAX_REPOSITORY_FILES = 5000;
const MAX_REPOSITORY_BYTES = 100 * 1024 * 1024;
const MAX_STAGE_BYTES = 250 * 1024 * 1024;
const MAX_STAGE_ENTRIES = 20000;

export function normalizeSkillSource(source: string) {
  const trimmed = source
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\/$/, "")
    .replace(/\.git$/, "");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(trimmed) ||
    [".", ".."].includes(trimmed.split("/")[1])
  )
    throw skillError(
      "请输入 GitHub 的 owner/repo 或 https://github.com/owner/repo，不支持命令、私有凭据或分支参数",
    );
  return trimmed;
}

function installerArguments(source: string, skillNames?: string[]) {
  if (
    skillNames &&
    (!skillNames.length ||
      skillNames.length > MAX_PROJECT_SKILLS ||
      new Set(skillNames).size !== skillNames.length ||
      skillNames.some((name) => !skillNameSchema.safeParse(name).success))
  )
    throw skillError("技能名称列表无效");
  return [
    "--yes",
    `--package=${SKILL_INSTALLER}`,
    "skills",
    "add",
    source,
    "--agent",
    "codex",
    "--skill",
    ...(skillNames || ["*"]),
    "--copy",
    "--yes",
  ];
}

/** A displayable command. Execution replaces the source with a prevalidated local checkout. */
export function skillInstallArguments(source: string, skillNames?: string[]) {
  return installerArguments(normalizeSkillSource(source), skillNames);
}

export async function installerAvailability() {
  const missing: string[] = [];
  for (const binary of ["npx", "git"]) {
    let found = false;
    for (const directory of (process.env.PATH || "")
      .split(path.delimiter)
      .filter(Boolean)) {
      try {
        const executable = path.join(directory, binary);
        await access(executable, constants.X_OK);
        if ((await lstat(await realpath(executable))).isFile()) {
          found = true;
          break;
        }
      } catch {
        /* Continue through PATH without executing an installer. */
      }
    }
    if (!found) missing.push(binary);
  }
  return missing.length
    ? { available: false, reason: `服务器缺少 ${missing.join("、")}` }
    : { available: true };
}

export interface SkillInstallerOptions {
  command?: string;
  gitCommand?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

type GitFile = { name: string; size: number };

/** Never check out links: skills@1.7.4 dereferences them while copying. */
export function validateSkillGitTree(data: Buffer): GitFile[] {
  let listing: string;
  try {
    listing = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw skillError("技能仓库包含非 UTF-8 文件名", 422);
  }
  if (!listing.endsWith("\0")) throw skillError("技能仓库文件清单无效", 422);
  const records = listing.slice(0, -1).split("\0"),
    result: GitFile[] = [],
    links: string[] = [],
    seen = new Set<string>();
  if (!records.length || records.length > MAX_REPOSITORY_FILES)
    throw skillError("技能仓库最多允许 5000 个文件", 422);
  let total = 0;
  for (const record of records) {
    const match =
      /^(100644|100755|120000|160000) (blob|commit) [a-f\d]{40,64}\s+(\d+|-)\t([^\0]+)$/.exec(
        record,
      );
    if (!match)
      throw skillError("技能仓库不能包含符号链接、子模块或特殊文件", 422);
    const name = safeSkillFileName(match[4]),
      submodule = match[1] === "160000",
      size = submodule && match[3] === "-" ? 0 : Number(match[3]);
    if (
      (submodule ? match[2] !== "commit" : match[2] !== "blob") ||
      (!submodule && match[3] === "-")
    )
      throw skillError("技能仓库文件清单无效", 422);
    if (!Number.isSafeInteger(size) || size < 0 || seen.has(name))
      throw skillError("技能仓库文件清单无效", 422);
    seen.add(name);
    total += size;
    if (total > MAX_REPOSITORY_BYTES)
      throw skillError("技能仓库内容不能超过 100 MiB", 422);
    if (match[1] === "120000" || submodule) links.push(name);
    else result.push({ name, size });
  }
  const roots = result
    .filter((file) => path.posix.basename(file.name) === "SKILL.md")
    .map((file) => file.name.slice(0, -8));
  if (!roots.length)
    throw skillError(
      "技能仓库缺少常规 SKILL.md，符号链接不能作为技能入口",
      422,
    );
  if (
    links.some(
      (name) =>
        path.posix.basename(name) === "SKILL.md" ||
        roots.some((root) => name.startsWith(root)),
    )
  )
    throw skillError("技能目录不能包含符号链接或子模块", 422);
  // Metadata links outside all skill roots (for example a repository CLAUDE.md)
  // are omitted from the explicit checkout list and never materialized or read.
  return result;
}

async function checkStageSize(root: string) {
  let bytes = 0,
    count = 0;
  async function walk(directory: string) {
    const children = await readdir(directory, { withFileTypes: true }).catch(
      (error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const entry of children) {
      if (++count > MAX_STAGE_ENTRIES)
        throw skillError("技能安装临时文件数量超过限制", 422);
      const file = path.join(directory, entry.name),
        info = await lstat(file).catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
      if (!info) continue;
      // Never follow a checkout or npm-cache link while measuring the stage.
      if (info.isSymbolicLink()) continue;
      bytes += info.size;
      if (bytes > MAX_STAGE_BYTES)
        throw skillError("技能安装临时文件超过 250 MiB，已停止", 422);
      if (info.isDirectory()) await walk(file);
    }
  }
  await walk(root);
}

async function validateCheckout(directory: string, files: GitFile[]) {
  const canonicalRoot = await realpath(directory);
  for (const file of files) {
    const resolved = path.join(directory, file.name),
      info = await lstat(resolved);
    const canonical = await realpath(resolved);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== file.size ||
      canonical !== path.join(canonicalRoot, file.name)
    )
      throw skillError("技能仓库检出文件与审查清单不一致", 422);
  }
}

/** The pinned npm CLI runs as the service user. This is not an OS sandbox. */
export async function runSkillInstaller(
  cwd: string,
  source: string,
  skillNames?: string[],
  options: SkillInstallerOptions = {},
) {
  const normalized = normalizeSkillSource(source);
  // Validate public input before creating files or spawning any command.
  skillInstallArguments(normalized, skillNames);
  const installerHome = path.join(cwd, "home"),
    checkout = path.join(cwd, "source");
  await mkdir(installerHome, { recursive: true, mode: 0o700 });
  const gitConfig = path.join(installerHome, "gitconfig"),
    npmConfig = path.join(installerHome, "npmrc");
  await writeFile(gitConfig, "", { mode: 0o600 });
  await writeFile(npmConfig, "", { mode: 0o600 });
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: installerHome,
    XDG_CONFIG_HOME: path.join(installerHome, ".config"),
    XDG_CACHE_HOME: path.join(installerHome, ".cache"),
    npm_config_cache: path.join(installerHome, ".npm"),
    npm_config_userconfig: npmConfig,
    npm_config_globalconfig: path.join(installerHome, "npm-globalrc"),
    npm_config_registry: "https://registry.npmjs.org",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_proxy: process.env.HTTP_PROXY,
    npm_config_https_proxy: process.env.HTTPS_PROXY,
    npm_config_noproxy: process.env.NO_PROXY,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    CI: "1",
    LANG: "C.UTF-8",
    DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    HTTP_PROXY: process.env.HTTP_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
  };
  const deadline = Date.now() + (options.timeoutMs ?? 180000);
  async function command(
    binary: string,
    args: string[],
    label: string,
    capture = false,
  ) {
    if (Date.now() >= deadline)
      throw skillError("技能安装超时，请检查服务器网络后重试", 504);
    return new Promise<Buffer>((resolve, reject) => {
      let bytes = 0,
        settled = false,
        checking = false,
        failure: Error | undefined;
      const chunks: Buffer[] = [];
      const child = spawn(binary, args, {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: environment,
      });
      function kill() {
        try {
          if (child.pid && process.platform !== "win32")
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
      function stop(error: Error) {
        if (settled || failure) return;
        failure = error;
        kill();
      }
      const timeout = setTimeout(
        () => stop(skillError("技能安装超时，请检查服务器网络后重试", 504)),
        Math.max(1, deadline - Date.now()),
      );
      const monitor = setInterval(() => {
        if (checking || settled) return;
        checking = true;
        void checkStageSize(cwd)
          .catch(stop)
          .finally(() => {
            checking = false;
          });
      }, 250);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(monitor);
        error ? reject(error) : resolve(Buffer.concat(chunks));
      };
      const output = (chunk: Buffer, stdout: boolean) => {
        bytes += chunk.length;
        if (
          bytes >
          (options.maxOutputBytes ?? (capture ? 2 * 1024 * 1024 : 256 * 1024))
        )
          stop(skillError("技能安装输出超出限制，已停止", 502));
        else if (capture && stdout) chunks.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => output(chunk, true));
      child.stderr.on("data", (chunk: Buffer) => output(chunk, false));
      child.on("error", () =>
        finish(
          skillError(
            `无法启动 ${label}，请检查服务器 Node.js、npm 和 git 安装`,
            503,
          ),
        ),
      );
      child.on("close", (code) => {
        // Never return command output: repositories can include terminal controls or credentials.
        if (failure) finish(failure);
        else if (code !== 0)
          finish(
            skillError(
              `${label}失败，请检查公开仓库地址、技能名称和服务器网络`,
              502,
            ),
          );
        else finish();
      });
    });
  }
  const git = options.gitCommand || "git";
  const safeGit = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "credential.helper=",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "http.followRedirects=false",
  ];
  await command(
    git,
    [
      ...safeGit,
      "clone",
      "--depth=1",
      "--single-branch",
      "--no-tags",
      "--no-checkout",
      `https://github.com/${normalized}.git`,
      checkout,
    ],
    "Git 仓库下载",
  );
  await checkStageSize(cwd);
  const tree = await command(
    git,
    [
      ...safeGit,
      "-C",
      checkout,
      "ls-tree",
      "-r",
      "-l",
      "-z",
      "--full-tree",
      "HEAD",
    ],
    "Git 文件检查",
    true,
  );
  const files = validateSkillGitTree(tree);
  const checkoutPaths = path.join(cwd, "checkout-paths");
  await writeFile(
    checkoutPaths,
    files.map((file) => file.name).join("\0") + "\0",
    { mode: 0o600 },
  );
  await command(
    git,
    [
      ...safeGit,
      "--literal-pathspecs",
      "-C",
      checkout,
      "checkout",
      "HEAD",
      "--pathspec-from-file=" + checkoutPaths,
      "--pathspec-file-nul",
    ],
    "Git 文件检出",
  );
  await checkStageSize(cwd);
  await validateCheckout(checkout, files);
  // User-supplied sources never reach this local-path branch. The preceding
  // git-tree inspection stops upstream CLI symlink dereferencing before it occurs.
  await command(
    options.command || "npx",
    installerArguments(checkout, skillNames),
    "npx 安装",
  );
  await checkStageSize(cwd);
}

export async function fetchSkillBundles(
  dataRoot: string,
  source: string,
  skillNames?: string[],
  options: SkillInstallerOptions = {},
) {
  const staging = path.join(dataRoot, "skills", ".staging");
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const cwd = await mkdtemp(path.join(staging, "install-"));
  try {
    await runSkillInstaller(cwd, source, skillNames, options);
    let files;
    try {
      files = await readSkillDirectory(path.join(cwd, ".agents", "skills"));
    } catch (error: any) {
      if (error.code === "ENOENT")
        throw skillError(
          "npx 未生成 Codex 技能目录，请确认仓库包含有效 SKILL.md",
          422,
        );
      throw error;
    }
    const bundles = bundleSkills(files);
    if (
      skillNames &&
      (bundles.length !== skillNames.length ||
        skillNames.some(
          (name) => !bundles.some((bundle) => bundle.name === name),
        ))
    )
      throw skillError("安装结果与所选技能不一致，未保存任何技能", 422);
    return bundles;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
