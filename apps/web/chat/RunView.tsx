import { copyText } from "./clipboard";
import { memo, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowDownToLine,
  Check,
  CheckCircle2,
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
import { ActivityGroup } from "./ActivityGroup";
import { groupActivity, reduceTimeline, type ChatBlock } from "./timeline";
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
export const RunView = memo(function RunView({
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
  const displayBlocks = useMemo(() => groupActivity(blocks), [blocks]);
  const [copied, setCopied] = useState(false);
  const finished = terminal.has(run.status);
  const phase = events.filter((e) => e.type === "work.phase").at(-1)?.payload
    .phase as WorkPhase | undefined;
  return (
    <article className="conversation-turn" data-run-id={run.id}>
      <div className="user-message">
        <span
          className="user-label"
          title={date(run.createdAt)}
          aria-label={"你 · " + date(run.createdAt)}
        >
          你
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
        {displayBlocks.map((block) => {
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
          if (block.kind === "activity")
            return (
              <ActivityGroup key={block.id} group={block} finished={finished} />
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
                className={
                  "chat-capture " +
                  (c.phase.startsWith("final") ? "" : "compact")
                }
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
});
