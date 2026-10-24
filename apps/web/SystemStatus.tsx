import type { ReactNode } from "react";
import {
  Server,
  Command,
  Database,
  HardDrive,
  RefreshCw,
  AlertCircle,
} from "lucide-react";
import type { Project } from "../../packages/contracts/index";
import { bytes } from "./api";
import type { SystemHealth } from "./useSystemHealth";
import "./status.css";

type Tone = "good" | "warning" | "bad" | "unknown";
export function workspaceHealth(
  health: SystemHealth | undefined,
  stale: boolean,
  error?: string,
  projectId?: string,
): { label: string; tone: Tone } {
  if (stale) return { label: "状态已过期", tone: "warning" };
  if (!health)
    return {
      label: error ? "服务暂不可用" : "正在检查系统状态",
      tone: error ? "bad" : "unknown",
    };
  if (!health.database?.ok) return { label: "数据库异常", tone: "bad" };
  if (health.storage?.ok === false) return { label: "存储异常", tone: "bad" };
  if (!health.execution?.ok)
    return {
      label:
        health.execution?.reachable === false
          ? "执行环境未连接"
          : "执行环境异常",
      tone: "bad",
    };
  if (
    health.execution.studios?.some(
      (s) => s.projectId === projectId && s.status === "failed",
    )
  )
    return { label: "当前项目异常", tone: "bad" };
  const currentStudio = health.execution.studios?.find(
    (studio) => studio.projectId === projectId,
  );
  if (currentStudio?.status === "closing")
    return { label: "当前项目正在关闭", tone: "warning" };
  if (currentStudio?.status === "starting")
    return { label: "当前项目正在启动", tone: "warning" };
  if (
    typeof health.storage?.free === "number" &&
    health.storage.free < 1024 ** 3
  )
    return { label: "可用存储不足", tone: "warning" };
  if (health.model?.ok === false)
    return { label: "模型配置读取失败", tone: "bad" };
  if (!health.model?.hasKey || !health.model?.model || !health.model?.baseUrl)
    return { label: "待配置模型", tone: "warning" };
  return { label: "执行环境就绪", tone: "good" };
}
function Metric({
  name,
  icon,
  title,
  value,
  detail,
  tone,
}: {
  name: string;
  icon: ReactNode;
  title: string;
  value: string;
  detail: string;
  tone: Tone;
}) {
  return (
    <div className="metric" data-testid={"metric-" + name} data-tone={tone}>
      <div>
        {icon}
        <span>{title}</span>
        <i className="health-dot" aria-hidden="true" />
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}
export function SystemStatus({
  health,
  stale,
  loading,
  error,
  lastSuccessAt,
  onRefresh,
  projectId,
  projects,
}: {
  health?: SystemHealth;
  stale: boolean;
  loading: boolean;
  error?: string;
  lastSuccessAt?: number;
  onRefresh: () => void;
  projectId?: string;
  projects: Project[];
}) {
  const summary = workspaceHealth(health, stale, error, projectId);
  const unknown = !health || stale;
  const execution = health?.execution;
  const studios = execution?.studios || [];
  const studioName = (id: string) =>
    projects.find((p) => p.id === id)?.name || id;
  const configured =
    !!health?.model?.hasKey &&
    !!health.model.model &&
    !!health.model.baseUrl &&
    health.model.ok !== false;
  const readyCount = studios.filter((s) => s.status === "ready").length;
  const diagnostics = [
    execution?.error,
    execution?.database?.error,
    execution?.storage?.error,
    health?.database?.error,
    health?.model?.error,
  ].filter(Boolean);
  const storageKnown =
    !unknown &&
    health?.storage?.ok !== false &&
    Number.isFinite(health?.storage?.free);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">SYSTEM CONSOLE</div>
          <h1>运行控制台</h1>
          <p>连接、存储和项目实例的实际状态，每 10 秒更新。</p>
        </div>
        <button
          data-testid="health-refresh"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw size={14} className={loading ? "spin" : undefined} />
          {loading ? "正在刷新" : "刷新"}
        </button>
      </div>
      <div
        className="health-summary"
        data-testid="system-health-summary"
        data-tone={summary.tone}
        role="status"
        aria-live="polite"
      >
        <span>
          <i className="health-dot" aria-hidden="true" />
          <strong>{summary.label}</strong>
        </span>
        <small>
          {lastSuccessAt ? (
            <>
              上次更新{" "}
              <time dateTime={new Date(lastSuccessAt).toISOString()}>
                {new Date(lastSuccessAt).toLocaleTimeString("zh-CN", {
                  hour12: false,
                })}
              </time>
            </>
          ) : (
            "尚未取得有效状态"
          )}
          {stale ? " · 历史数据仅供参考" : ""}
        </small>
      </div>
      {error && (
        <div className="health-notice" role="alert">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}
      <div
        className="metrics system-metrics"
        aria-label="系统组件状态"
        aria-busy={loading}
      >
        <Metric
          name="execution"
          icon={<Server size={18} />}
          title="执行环境"
          tone={unknown ? "unknown" : execution?.ok ? "good" : "bad"}
          value={
            unknown
              ? "待确认"
              : execution?.ok
                ? "已连接"
                : execution?.reachable === false
                  ? "未连接"
                  : "异常"
          }
          detail={
            unknown
              ? "等待最新检查"
              : `${readyCount} 个 Blender 就绪 · 上限 ${execution?.maxStudios ?? "—"}`
          }
        />
        <Metric
          name="model"
          icon={<Command size={18} />}
          title="Codex 模型"
          tone={
            unknown
              ? "unknown"
              : health?.model?.ok === false
                ? "bad"
                : configured
                  ? "good"
                  : "warning"
          }
          value={
            unknown
              ? "待确认"
              : health?.model?.ok === false
                ? "读取失败"
                : configured
                  ? "已配置"
                  : "未配置"
          }
          detail={
            unknown
              ? "等待最新检查"
              : health?.model?.ok === false
                ? health.model.error || "无法读取模型配置"
                : configured
                  ? `${health!.model!.model} · 推理与工具能力需任务验证`
                  : "前往模型与连接，填写 URL、模型和 Key"
          }
        />
        <Metric
          name="database"
          icon={<Database size={18} />}
          title="数据库"
          tone={unknown ? "unknown" : health?.database?.ok ? "good" : "bad"}
          value={
            unknown ? "待确认" : health?.database?.ok ? "已连接" : "未连接"
          }
          detail={
            unknown
              ? "等待最新检查"
              : (health?.database?.version
                  ? `${health.database.engine || "PostgreSQL"} ${health.database.version}`
                  : undefined) ||
                health?.database?.error ||
                "PostgreSQL"
          }
        />
        <Metric
          name="storage"
          icon={<HardDrive size={18} />}
          title="可用存储"
          tone={
            unknown
              ? "unknown"
              : health?.storage?.ok === false
                ? "bad"
                : !storageKnown
                  ? "unknown"
                  : health!.storage!.free! < 1024 ** 3
                    ? "warning"
                    : "good"
          }
          value={storageKnown ? bytes(health!.storage!.free!) : "—"}
          detail={
            unknown
              ? "等待最新检查"
              : health?.storage?.ok === false
                ? health.storage.error || "无法读取存储状态"
                : typeof health?.storage?.total === "number"
                  ? "总容量 " + bytes(health.storage.total)
                  : "存储状态未知"
          }
        />
      </div>
      {!unknown && diagnostics.length > 0 && (
        <div className="health-notice" role="alert">
          <AlertCircle size={16} />
          <span>{[...new Set(diagnostics)].join("；")}</span>
        </div>
      )}
      <h3 className="section-heading">Blender 项目实例</h3>
      <div className="studio-status-list" data-testid="studio-status-list">
        {unknown ? (
          <p className="muted">连接恢复后显示实时项目状态。</p>
        ) : studios.length ? (
          studios.map((studio) => (
            <div
              key={studio.projectId}
              data-tone={
                studio.status === "failed"
                  ? "bad"
                  : studio.status === "ready"
                    ? "good"
                    : "warning"
              }
            >
              <i className="health-dot" aria-hidden="true" />
              <div>
                <strong>
                  {studioName(studio.projectId)}
                  {studio.projectId === projectId && <small>当前项目</small>}
                </strong>
                <p>
                  {studio.error ||
                    (studio.status === "ready"
                      ? "桌面与 MCP 已就绪"
                      : studio.status === "closing"
                        ? "正在保存并关闭实例"
                        : studio.status === "starting"
                          ? "正在启动桌面与 MCP"
                          : "实例状态待确认")}
                </p>
              </div>
              <span>
                {studio.status === "failed"
                  ? "异常"
                  : studio.status === "ready"
                    ? "就绪"
                    : studio.status === "closing"
                      ? "关闭中"
                      : studio.status === "starting"
                        ? "启动中"
                        : "待确认"}
              </span>
            </div>
          ))
        ) : (
          <p className="muted">
            尚未启动 Blender 项目，打开项目后按需创建实例。
          </p>
        )}
      </div>
      <h3 className="section-heading">组件版本</h3>
      <div className="component-table" data-testid="component-versions">
        {Object.entries(health?.versions || {}).map(([name, value]) => (
          <div key={name}>
            <span>{name}</span>
            <code>{value}</code>
            <span className="muted">
              {stale ? "上次记录 · " : ""}
              {health?.versionSources?.[name] === "runtime"
                ? "运行时检测"
                : health?.versionSources?.[name] === "pending"
                  ? "待实例启动后检测"
                  : health?.versionSources?.[name] === "configured"
                    ? "部署配置版本"
                    : "构建配置版本"}
            </span>
          </div>
        ))}
        {!health && <div className="muted">获取系统状态后显示。</div>}
      </div>
    </>
  );
}
