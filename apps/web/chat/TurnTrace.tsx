import { useId, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import {
  terminal,
  type Run,
  type Snapshot,
} from "../../../packages/contracts/index";
import type { ChatBlock } from "./timeline";
import { toolNames } from "./ActivityGroup";
import { TraceBlock } from "./TraceBlock";

export function TurnTrace({
  blocks,
  run,
  busy,
  lightbox,
  onRestoreSnapshot,
}: {
  blocks: ChatBlock[];
  run: Run;
  busy: boolean;
  lightbox: (v: { src: string; title: string }) => void;
  onRestoreSnapshot?: (snapshot: Snapshot) => void;
}) {
  const id = useId();
  const finished = terminal.has(run.status);
  // Automatically fold on completion; a user's choice is scoped to that phase.
  const [choice, setChoice] = useState<{ finished: boolean; open: boolean }>();
  const open = choice?.finished === finished ? choice.open : false;
  if (!blocks.length) return null;
  const tools = blocks.filter((block) => block.kind === "tool");
  const failures = tools.filter((block) => block.status === "failed").length;
  const missing = finished
    ? tools.filter((block) => block.status === "running").length
    : 0;
  const notices = blocks.filter(
    (block) => block.kind === "notice" && block.severity === "error",
  ).length;
  const current = tools.findLast((block) => block.status === "running");
  const progress = blocks.findLast((block) => block.kind === "message");
  return (
    <section className="chat-activity chat-turn-trace" aria-label="执行过程">
      <button
        type="button"
        className="chat-activity-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setChoice({ finished, open: !open })}
      >
        <ChevronRight size={12} className={open ? "expanded" : ""} />
        {!finished && <Loader2 size={12} className="spin" />}
        <span>
          {finished
            ? "执行过程"
            : current
              ? toolNames[current.name] || current.name
              : "正在处理"}
          {tools.length > 0 && ` · ${tools.length} 次操作`}
          {failures > 0 && ` · ${failures} 次失败记录`}
          {missing > 0 && ` · ${missing} 次未回执`}
          {notices > 0 && ` · ${notices} 条异常记录`}
        </span>
      </button>
      {!finished && !open && progress?.kind === "message" && (
        <p className="chat-progress-preview" title={progress.text}>
          {progress.text}
        </p>
      )}
      <div id={id} className="chat-activity-items" hidden={!open}>
        {open &&
          blocks.map((block) => (
            <TraceBlock
              key={block.id}
              block={block}
              run={run}
              finished={finished}
              busy={busy}
              lightbox={lightbox}
              onRestoreSnapshot={onRestoreSnapshot}
            />
          ))}
      </div>
    </section>
  );
}
