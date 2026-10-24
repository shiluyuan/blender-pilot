import { copyText } from "./clipboard";
import { useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowDownToLine,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  FileBox,
  Loader2,
  Maximize2,
  Paperclip,
  RotateCcw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type {
  PilotEvent,
  Run,
  Snapshot,
} from "../../../packages/contracts/index";
import { terminal } from "../../../packages/contracts/index";
import { date, fileUrl } from "../api";
import { Markdown } from "./Markdown";
import { reduceTimeline, type ChatBlock } from "./timeline";
import { WorkSummary } from "./WorkSummary";
import {
  workPhaseLabels,
  type WorkPhase,
} from "../../../packages/contracts/workflow";

const labels: Record<string, string> = {
  queued: "等待执行",
  running: "执行中",
  cancelling: "正在停止",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已停止",
  interrupted: "需要检查",
};
const names: Record<string, string> = {
  get_scene_info: "读取场景",
  execute_blender_code: "执行 Blender 操作",
  capture: "观察当前画面",
  query_blender_api: "查询 Blender API",
  import_asset: "导入资源",
  search_library: "搜索素材库",
  get_library_asset: "查看素材预览",
  save_library_asset: "保存可复用素材",
  import_library_asset: "复用素材",
  save_scene: "保存场景",
  export_scene: "导出场景",
  report_verification: "检查创作结果",
  inspect_scene_quality: "检查场景结构与材质",
  capture_views: "检查多个角度",
  update_work_plan: "更新创作阶段",
  read_skill_resource: "读取技能资料",
};
const pretty = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
function ToolCard({
  block,
  finished,
}: {
  block: Extract<ChatBlock, { kind: "tool" }>;
  finished: boolean;
}) {
  const interrupted = finished && block.status === "running";
  const elapsed =
    Date.parse(block.completedAt || "") - Date.parse(block.startedAt || "");
  const duration =
    Number.isFinite(elapsed) && elapsed >= 0
      ? elapsed < 1000
        ? "<1 秒"
        : `${(elapsed / 1000).toFixed(elapsed < 10000 ? 1 : 0)} 秒`
      : "";
  const receipt =
    block.receipt ||
    (block.result &&
    typeof block.result === "object" &&
    "receipt" in block.result
      ? (block.result.receipt as Record<string, unknown>)
      : undefined);
  return (
    <details
      className={
        "tool-row chat-tool " + (block.status === "failed" ? "failed" : "")
      }
      data-call-id={block.callId}
    >
      <summary>
        {block.status === "running" && !finished ? (
          <Loader2 className="spin" size={13} />
        ) : block.status === "failed" || interrupted ? (
          <AlertCircle size={13} />
        ) : (
          <Check size={13} />
        )}
        <span>{names[block.name] || block.name}</span>
        <small>
          {interrupted
            ? "未收到完成回执"
            : block.status === "running"
              ? "执行中"
              : block.status === "failed"
                ? "失败"
                : "完成"}
          {duration && ` · ${duration}`}
        </small>
        <ChevronRight size={12} />
      </summary>
      {receipt && (
        <div className="chat-change-receipt">
          {[
            ["created", "新增"],
            ["modified", "修改"],
            ["deleted", "删除"],
          ].map(([key, label]) => {
            const values = receipt[key];
            if (!Array.isArray(values) || !values.length) return null;
            const names = values
              .slice(0, 8)
              .map((v) =>
                typeof v === "string"
                  ? v
                  : typeof v?.name === "string"
                    ? v.name
                    : "",
              )
              .filter(Boolean);
            return (
              <div key={key}>
                <strong>
                  {label} {values.length}
                </strong>
                <span>
                  {names.join("、")}
                  {values.length > 8 ? "…" : ""}
                </span>
              </div>
            );
          })}
          <small>对象变化回读；完整范围见结果。</small>
        </div>
      )}
      {block.args !== undefined && (
        <div className="chat-tool-detail">
          <span>输入</span>
          <pre>{pretty(block.args)}</pre>
        </div>
      )}
      {block.result !== undefined && (
        <div className="chat-tool-detail">
          <span>结果</span>
          <pre>{pretty(block.result)}</pre>
        </div>
      )}
      {block.error && <div className="chat-notice error">{block.error}</div>}
    </details>
  );
}
export function RunView({
  run,
  events,
  lightbox,
  onRestoreSnapshot,
  busy = false,
}: {
  run: Run;
  events: PilotEvent[];
  lightbox: (v: { src: string; title: string }) => void;
  onRestoreSnapshot?: (snapshot: Snapshot) => void;
  busy?: boolean;
}) {
  const blocks = useMemo(() => reduceTimeline(events), [events]);
  const [copied, setCopied] = useState(false);
  const finished = terminal.has(run.status);
  const phase = events.filter((e) => e.type === "work.phase").at(-1)?.payload
    .phase as WorkPhase | undefined;
  return (
    <article className="conversation-turn" data-run-id={run.id}>
      <div className="user-message">
        <span className="user-label">
          你<time>{date(run.createdAt)}</time>
        </span>
        <p>{run.prompt}</p>
        {!!run.skillRefs?.length && (
          <div className="chat-skill-refs" aria-label="本轮技能">
            {run.skillRefs.map((s) => (
              <span key={s.id} title={"版本 " + s.sha256.slice(0, 12)}>
                技能 · {s.name}
              </span>
            ))}
          </div>
        )}
        {run.attachmentRefs?.length ? (
          <div className="chat-user-refs">
            {run.attachmentRefs.map((a) => {
              const href =
                a.kind === "library"
                  ? `/api/library/${a.id}/file`
                  : fileUrl(a.kind, a.id);
              const image = /^image\/(png|jpeg|webp)$/.test(a.mime || "");
              return (
                <a
                  className="chat-user-ref"
                  href={href}
                  key={a.id}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={a.name}
                >
                  {image ? (
                    <img
                      src={
                        a.kind === "library"
                          ? href + "?preview=true"
                          : fileUrl(a.kind, a.id, true)
                      }
                      alt=""
                    />
                  ) : (
                    <Paperclip size={12} />
                  )}
                  <span>{a.name}</span>
                </a>
              );
            })}
          </div>
        ) : (
          run.assetIds.length + (run.libraryAssetIds?.length || 0) > 0 && (
            <small>
              <Paperclip size={12} />
              {run.assetIds.length + (run.libraryAssetIds?.length || 0)}{" "}
              个引用附件
            </small>
          )
        )}
      </div>
      <div className="assistant-message">
        <div className="assistant-label">
          <Sparkles size={16} />
          <strong>Blender Pilot</strong>
          <span className={"run-badge " + run.status}>
            {labels[run.status]}
          </span>
        </div>
        {blocks.map((block) => {
          if (block.kind === "message")
            return block.text ? (
              <div
                key={block.id}
                className={"chat-message-part " + (block.phase || "")}
                data-item-id={block.itemId}
              >
                <Markdown text={block.text} />
              </div>
            ) : null;
          if (block.kind === "tool")
            return (
              <ToolCard key={block.id} block={block} finished={finished} />
            );
          if (block.kind === "plan")
            return (
              <details className="chat-plan" key={block.id} open>
                <summary>
                  创作计划
                  <span>
                    {block.steps.filter((s) => s.status === "completed").length}
                    /{block.steps.length}
                  </span>
                </summary>
                {block.explanation && <p>{block.explanation}</p>}
                <ol>
                  {block.steps.map((s, i) => (
                    <li key={i} data-status={s.status}>
                      {s.status === "completed" ? (
                        <CheckCircle2 size={12} />
                      ) : ["in_progress", "inProgress"].includes(s.status) ? (
                        <Loader2 size={12} className="spin" />
                      ) : (
                        <span className="chat-plan-dot" />
                      )}
                      {s.step}
                    </li>
                  ))}
                </ol>
              </details>
            );
          if (block.kind === "capture") {
            const c = block.capture,
              title =
                c.phase === "before"
                  ? "操作前场景"
                  : c.phase.startsWith("final")
                    ? "结果检查" +
                      (c.phase.includes(":")
                        ? " · " +
                          ({
                            front: "正面",
                            right: "右侧",
                            top: "俯视",
                            isometric: "透视",
                          }[c.phase.split(":")[1]] || "多角度")
                        : "")
                    : "当前场景";
            return (
              <button
                type="button"
                className="chat-capture"
                key={block.id}
                onClick={() =>
                  lightbox({ src: fileUrl("capture", c.id), title })
                }
              >
                <img
                  src={fileUrl("capture", c.id)}
                  alt={title}
                  loading="lazy"
                />
                <span>
                  <span>{title}</span>
                  <Maximize2 size={12} />
                </span>
              </button>
            );
          }
          if (block.kind === "snapshot") {
            const snapshot = block.snapshot;
            if (snapshot.projectId !== run.projectId) return null;
            return (
              <div className="chat-snapshot" key={block.id}>
                <ShieldCheck size={14} />
                <span>
                  <strong>{snapshot.name || "场景恢复点"}</strong>
                  <small>已保存 Blender 文件</small>
                </span>
                <a
                  href={fileUrl("snapshot", snapshot.id)}
                  title="下载恢复点"
                  aria-label="下载恢复点"
                >
                  <ArrowDownToLine size={14} />
                </a>
                {onRestoreSnapshot && (
                  <button
                    type="button"
                    disabled={busy || !finished}
                    onClick={() => onRestoreSnapshot(snapshot)}
                  >
                    <RotateCcw size={12} />
                    恢复
                  </button>
                )}
              </div>
            );
          }
          if (block.kind === "verification")
            return (
              <div
                key={block.id}
                className={"verification " + (block.passed ? "passed" : "")}
              >
                <CheckCircle2 size={13} />
                <span>
                  {block.passed ? "视觉检查通过" : "仍有待调整项"}
                  <small>{block.observations}</small>
                </span>
              </div>
            );
          if (block.kind === "artifact")
            return (
              <a
                key={block.id}
                className="artifact-link"
                href={fileUrl("artifact", String(block.artifact.id))}
              >
                <FileBox size={18} />
                <span>{String(block.artifact.name || "下载产物")}</span>
                <ArrowDownToLine size={14} />
              </a>
            );
          return (
            <div key={block.id} className={"chat-notice " + block.severity}>
              <AlertCircle size={13} />
              <span>{block.message}</span>
            </div>
          );
        })}
        {finished && (
          <WorkSummary
            events={events}
            projectId={run.projectId}
            lightbox={lightbox}
            restore={onRestoreSnapshot}
            busy={busy}
          />
        )}
        {run.error && (
          <div className="run-error">
            <AlertCircle size={14} />
            {run.error}
          </div>
        )}
        {!finished && (
          <div className="chat-working" role="status">
            <Loader2 className="spin" size={13} />
            {run.status === "queued"
              ? "正在准备场景与参考资料…"
              : run.status === "cancelling"
                ? "正在停止当前任务…"
                : phase && workPhaseLabels[phase]
                  ? workPhaseLabels[phase] + "…"
                  : "正在创作，操作后会自动截图检查…"}
          </div>
        )}
        {finished && blocks.some((b) => b.kind === "message") && (
          <div className="chat-turn-actions">
            <button
              type="button"
              aria-label="复制回复"
              onClick={() => {
                void copyText(
                  blocks
                    .filter(
                      (b): b is Extract<ChatBlock, { kind: "message" }> =>
                        b.kind === "message",
                    )
                    .map((b) => b.text)
                    .join("\n\n"),
                )
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? "已复制" : "复制回复"}
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
