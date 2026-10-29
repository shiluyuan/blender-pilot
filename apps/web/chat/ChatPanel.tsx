import type { ReactNode } from "react";
import { Clock3, PanelRightClose, Plus, Sparkles } from "lucide-react";
import { usePanelWidth } from "./usePanelWidth";

/** Presentation boundary: conversation state and commands remain in the workspace. */
export function ChatPanel({
  sessionTitle,
  reconnecting,
  canCreate,
  onHistory,
  onNew,
  onClose,
  children,
}: {
  sessionTitle: string;
  reconnecting: boolean;
  canCreate: boolean;
  onHistory: () => void;
  onNew: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const { width, separatorProps } = usePanelWidth();
  return (
    <>
      <div
        className="resize-handle"
        role="separator"
        aria-label="调整助手宽度"
        aria-orientation="vertical"
        aria-controls="creative-assistant"
        tabIndex={0}
        title="拖动调整宽度 · 方向键微调 · 双击重置"
        {...separatorProps}
      />
      <aside
        id="creative-assistant"
        aria-label="创作助手"
        className="chat-panel"
        style={{ width }}
      >
        <div className="chat-header">
          <div>
            <Sparkles size={16} />
            <strong>创作助手</strong>
            <span className="badge small">CODEX</span>
          </div>
          <div>
            <button
              className="icon"
              title="对话历史"
              aria-label="对话历史"
              onClick={onHistory}
            >
              <Clock3 size={15} />
            </button>
            <button
              className="icon"
              title="新建对话"
              aria-label="新建对话"
              disabled={!canCreate}
              onClick={onNew}
            >
              <Plus size={17} />
            </button>
            <button
              className="icon"
              title="收起助手"
              aria-label="收起助手"
              onClick={onClose}
            >
              <PanelRightClose size={16} />
            </button>
          </div>
        </div>
        <div className="chat-context">
          <span
            className={"dot " + (reconnecting ? "" : "green")}
            aria-hidden="true"
          />
          <span className="chat-connection" role="status">
            {reconnecting ? "正在重连，恢复消息中…" : "自动截图已开启"}
          </span>
          <span className="grow" />
          <span title={sessionTitle}>{sessionTitle}</span>
        </div>
        {children}
      </aside>
    </>
  );
}
