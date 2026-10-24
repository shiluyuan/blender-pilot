/** Non-destructive health check for an installed workspace. Model inference,
 * native scene changes and Docker startup have separate acceptance suites. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export interface ReadinessReport {
  passed: boolean;
  time: string;
  scope: "installed-workspace-health";
  checks: Array<{ name: string; passed: boolean; message: string }>;
  observed: {
    databaseVersion?: string;
    versions?: Record<string, string>;
    readyStudios?: number;
    activeTasks?: number;
    freeBytes?: number;
    model?: string;
  };
}
export async function verifyReadiness(options: {
  baseUrl: string;
  password: string;
  timeoutMs?: number;
  minimumFreeBytes?: number;
}): Promise<ReadinessReport> {
  let url: URL;
  try {
    url = new URL(options.baseUrl);
  } catch {
    throw new Error("服务地址不是有效的 HTTP(S) 地址");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("服务地址须为 HTTP(S)，不能包含账号、密码、查询参数或片段");
  if (!options.password)
    throw new Error("请设置 PILOT_PASSWORD 或使用 --password-file");
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 180000)
    throw new Error("timeout-ms 须在 100–180000 之间");
  const minimumFreeBytes = options.minimumFreeBytes ?? 1024 ** 3;
  if (!Number.isFinite(minimumFreeBytes) || minimumFreeBytes < 0)
    throw new Error("可用空间阈值不能为负数");
  const base = url.toString().replace(/\/$/, "");
  const report: ReadinessReport = {
    passed: false,
    time: new Date().toISOString(),
    scope: "installed-workspace-health",
    checks: [],
    observed: {},
  };
  let cookie = "";
  const check = (name: string, passed: boolean, message: string) =>
    report.checks.push({ name, passed, message });
  const request = async (route: string, body?: unknown) => {
    const response = await fetch(base + "/api" + route, {
      method: body ? "POST" : "GET",
      redirect: "error",
      headers: {
        cookie,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (route === "/auth/login") {
      cookie =
        response.headers
          .getSetCookie()
          .find((value) => value.startsWith("pilot_session="))
          ?.split(";")[0] || "";
      if (!cookie) throw new Error("登录未返回工作台 Cookie");
    }
    let value: any;
    try {
      value = await response.json();
    } catch {
      throw new Error("服务没有返回有效 JSON");
    }
    return value;
  };
  try {
    try {
      const ready = await request("/ready");
      check(
        "service-ready",
        ready.ok === true,
        ready.ok === true ? "服务就绪接口通过" : "服务尚未就绪",
      );
    } catch (error) {
      check(
        "service-ready",
        false,
        error instanceof Error ? error.message : "就绪请求失败",
      );
    }
    try {
      await request("/auth/login", { password: options.password });
      const status = await request("/auth/status");
      check(
        "authentication",
        status.authenticated === true,
        status.authenticated === true
          ? "独立检查会话登录成功"
          : "工作台未确认登录",
      );
      if (!status.authenticated) return report;
    } catch (error) {
      check(
        "authentication",
        false,
        error instanceof Error ? error.message : "登录失败",
      );
      return report;
    }
    try {
      const health = await request("/health");
      check(
        "application",
        health.app === true,
        health.app === true ? "Web API 正常" : "Web API 状态异常",
      );
      check(
        "database",
        health.database?.ok === true &&
          health.database?.engine === "PostgreSQL",
        health.database?.ok === true ? "PostgreSQL 连接可用" : "数据库不可用",
      );
      if (typeof health.database?.version === "string")
        report.observed.databaseVersion = health.database.version;
      check(
        "runner",
        health.execution?.ok === true,
        health.execution?.ok === true ? "执行服务可达" : "执行服务不可用",
      );
      const studios = Array.isArray(health.execution?.studios)
        ? health.execution.studios
        : [];
      const failed = studios.filter(
        (studio: any) => studio.status === "failed",
      );
      check(
        "studio-failures",
        !failed.length,
        failed.length
          ? `${failed.length} 个项目实例故障，请关闭后重新打开`
          : "未发现故障实例",
      );
      report.observed.readyStudios = studios.filter(
        (studio: any) => studio.status === "ready",
      ).length;
      report.observed.activeTasks = Array.isArray(health.execution?.activeRuns)
        ? health.execution.activeRuns.length
        : 0;
      const free = health.storage?.free;
      const validFree =
        typeof free === "number" && Number.isFinite(free) && free >= 0;
      if (validFree) report.observed.freeBytes = free;
      check(
        "free-storage",
        validFree && free >= minimumFreeBytes,
        validFree && free >= minimumFreeBytes
          ? "可用空间达到设定阈值"
          : "可用空间不足或无法读取",
      );
      const configured =
        health.model?.hasKey === true &&
        typeof health.model?.model === "string" &&
        !!health.model.model.trim() &&
        typeof health.model?.baseUrl === "string" &&
        !!health.model.baseUrl.trim();
      check(
        "model-configured",
        configured,
        configured
          ? "模型配置已保存；推理能力由真实任务验收"
          : "请在模型设置补齐接口、Key 和模型名",
      );
      if (configured) report.observed.model = health.model.model;
      const versions = Object.fromEntries(
        Object.entries(health.versions || {}).filter(
          ([key, value]) =>
            ["app", "codex", "mcp", "blender"].includes(key) &&
            typeof value === "string",
        ),
      ) as Record<string, string>;
      report.observed.versions = versions;
    } catch (error) {
      check(
        "health-response",
        false,
        error instanceof Error ? error.message : "健康请求失败",
      );
    }
  } finally {
    if (cookie) {
      try {
        await request("/auth/logout", {});
        check("check-session-closed", true, "检查会话已退出");
      } catch {
        check(
          "check-session-closed",
          false,
          "检查会话退出失败，请检查服务连接",
        );
      }
    }
    report.passed =
      report.checks.length > 0 && report.checks.every((item) => item.passed);
  }
  return report;
}

export async function runReadinessCli() {
  const args = parseArgs({
    options: {
      url: { type: "string" },
      "password-file": { type: "string" },
      output: { type: "string" },
      "timeout-ms": { type: "string" },
      "min-free-gb": { type: "string" },
    },
  });
  const passwordFile =
    args.values["password-file"] || process.env.PILOT_PASSWORD_FILE;
  const password = passwordFile
    ? (await readFile(passwordFile, "utf8")).replace(/\r?\n$/, "")
    : process.env.PILOT_PASSWORD || "";
  const report = await verifyReadiness({
    baseUrl:
      args.values.url || process.env.PILOT_TEST_URL || "http://127.0.0.1:8090",
    password,
    timeoutMs: args.values["timeout-ms"]
      ? Number(args.values["timeout-ms"])
      : undefined,
    minimumFreeBytes: args.values["min-free-gb"]
      ? Number(args.values["min-free-gb"]) * 1024 ** 3
      : undefined,
  });
  if (args.values.output) {
    await mkdir(path.dirname(path.resolve(args.values.output)), {
      recursive: true,
    });
    await writeFile(
      args.values.output,
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await runReadinessCli();
