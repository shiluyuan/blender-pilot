import { copyText } from "./clipboard";
import { memo, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  Loader2,
  Paperclip,
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
import { reduceTimeline } from "./timeline";
import { presentConversation } from "./presentation";
import { TurnTrace } from "./TurnTrace";
import { TraceBlock } from "./TraceBlock";
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
  const conversation = useMemo(() => presentConversation(blocks), [blocks]);
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
        <TurnTrace
          blocks={conversation.trace}
          run={run}
          busy={busy}
          lightbox={lightbox}
          onRestoreSnapshot={onRestoreSnapshot}
        />
        <div className="chat-reply" aria-label="助手回复">
          {conversation.reply.map((block) => (
            <div
              key={block.id}
              className="chat-message-part"
              data-item-id={block.itemId}
            >
              <Markdown text={block.text} />
            </div>
          ))}
          {finished && !conversation.reply.length && (
            <p className="chat-reply-empty">
              {run.status === "succeeded"
                ? "本轮操作已完成，未收到最终文字回复。"
                : run.status === "cancelled"
                  ? "任务已停止，可以继续描述你的调整。"
                  : "本轮未完成，请查看执行状态与过程记录。"}
            </p>
          )}
        </div>
        {!!conversation.artifacts.length && (
          <div className="chat-result-files" aria-label="本轮文件">
            {conversation.artifacts.map((block) => (
              <TraceBlock
                key={block.id}
                block={block}
                run={run}
                finished={finished}
                busy={busy}
                lightbox={lightbox}
              />
            ))}
          </div>
        )}
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
        {finished && conversation.reply.length > 0 && (
          <div className="chat-turn-actions">
            <button
              type="button"
              aria-label="复制回复"
              onClick={() => {
                void copyText(
                  conversation.reply.map((b) => b.text).join("\n\n"),
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
