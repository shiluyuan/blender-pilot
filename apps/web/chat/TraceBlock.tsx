import {
  AlertCircle,
  ArrowDownToLine,
  CheckCircle2,
  FileBox,
  Maximize2,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import type { Run, Snapshot } from "../../../packages/contracts/index";
import { fileUrl } from "../api";
import { Markdown } from "./Markdown";
import { ToolCard, PlanRow } from "./ActivityGroup";
import type { ChatBlock } from "./timeline";

/** A chronological receipt; only mounted when its turn's trace is expanded. */
export function TraceBlock({
  block,
  run,
  finished,
  busy,
  lightbox,
  onRestoreSnapshot,
}: {
  block: ChatBlock;
  run: Run;
  finished: boolean;
  busy: boolean;
  lightbox: (v: { src: string; title: string }) => void;
  onRestoreSnapshot?: (snapshot: Snapshot) => void;
}) {
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
    return <ToolCard block={block} finished={finished} />;
  if (block.kind === "plan")
    return <PlanRow block={block} finished={finished} />;
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
        className="chat-capture compact"
        key={block.id}
        onClick={() => lightbox({ src: fileUrl("capture", c.id), title })}
      >
        <img src={fileUrl("capture", c.id)} alt={title} loading="lazy" />
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
}
