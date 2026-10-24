import { useEffect, useRef, useState, type RefObject } from "react";
import {
  AlertCircle,
  ArrowUp,
  Camera,
  FileText,
  Loader2,
  Paperclip,
  Plus,
  RefreshCw,
  Square,
  X,
} from "lucide-react";
import {
  DOCUMENT_EXTENSIONS,
  MAX_DOCUMENT_BYTES,
} from "../../../packages/contracts/attachments";
import { bytes, fileUrl } from "../api";
import { MAX_CHAT_PROMPT_CHARS } from "../../../packages/contracts/chat-limits";
import type { ChatAttachment, ChatOutbox, ChatUpload } from "./useChatComposer";

export function ChatComposer(props: {
  draft: string;
  setDraft: (text: string) => void;
  attachments: ChatAttachment[];
  uploads: ChatUpload[];
  outbox?: ChatOutbox;
  busy: boolean;
  loading: boolean;
  disabled: boolean;
  disabledReason?: string;
  model?: string;
  status?: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onSend: () => void;
  onStop: () => void;
  onCapture: () => void;
  onReference: () => void;
  onFiles: (files: FileList | File[]) => void;
  onRemove: (id: string) => void;
  onRetryUpload: (id: string) => void;
  onRemoveUpload: (id: string) => void;
  onRetrySend: () => void;
  onMoveBack: () => void;
}) {
  const picker = useRef<HTMLInputElement>(null),
    composing = useRef(false);
  const [dragging, setDragging] = useState(false),
    [menu, setMenu] = useState(false);
  const referenceCount = props.attachments.length + props.uploads.length;
  useEffect(() => {
    if (props.disabled) {
      setMenu(false);
      setDragging(false);
    }
  }, [props.disabled]);
  const blocked =
    props.disabled ||
    props.loading ||
    props.busy ||
    !!props.outbox ||
    props.uploads.length > 0 ||
    !props.draft.trim() ||
    props.draft.length > MAX_CHAT_PROMPT_CHARS ||
    referenceCount > 12;
  useEffect(() => {
    const node = props.inputRef.current;
    if (node) {
      node.style.height = "auto";
      node.style.height = Math.min(190, Math.max(66, node.scrollHeight)) + "px";
    }
  }, [props.draft]);
  return (
    <div className="composer-wrap chat-composer-wrap">
      {props.disabledReason && (
        <div className="run-status" role="status">
          <Loader2 size={13} className="spin" />
          {props.disabledReason}
        </div>
      )}
      {props.busy && (
        <div className="run-status" role="status">
          <Loader2 size={13} className="spin" />
          {props.status || "正在创作"}
          <span className="grow" />
          <button className="text-button" onClick={props.onStop}>
            停止并接管
          </button>
        </div>
      )}
      {props.outbox && (
        <div
          className={"chat-outbox " + props.outbox.status}
          data-testid="chat-outbox"
          role="status"
        >
          <div>
            {props.loading ? (
              <Loader2 className="spin" size={14} />
            ) : (
              <AlertCircle size={14} />
            )}
            <strong>
              {props.loading
                ? "正在发送消息"
                : props.outbox.uncertain
                  ? "等待接收确认"
                  : "消息未被接收"}
            </strong>
          </div>
          <p>{props.outbox.text}</p>
          {props.outbox.error && <small>{props.outbox.error}</small>}
          {!props.loading && (
            <div className="chat-outbox-actions">
              <button
                type="button"
                disabled={props.disabled}
                onClick={props.onRetrySend}
              >
                <RefreshCw size={12} />
                重试确认
              </button>
              {!props.outbox.uncertain && (
                <button
                  type="button"
                  disabled={props.disabled}
                  onClick={props.onMoveBack}
                >
                  移回草稿
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {props.attachments.length > 0 && (
        <div className="attachments chat-attachments">
          {props.attachments.map((a) => {
            const image =
              a.kind === "capture" ||
              /^image\//.test(a.mime || "") ||
              /\.(png|jpe?g|webp)$/i.test(a.name);
            return (
              <div key={a.id} className="chat-attachment" title={a.name}>
                {image ? (
                  <img
                    src={
                      a.kind === "library"
                        ? `/api/library/${a.id}/file?preview=true`
                        : fileUrl(
                            a.kind === "capture" ? "capture" : "asset",
                            a.id,
                            true,
                          )
                    }
                    alt={a.name}
                  />
                ) : (
                  <FileText size={15} />
                )}
                <span>
                  {a.name}
                  {a.documentInfo?.truncated && (
                    <small>
                      正文将截断至{" "}
                      {a.documentInfo.contextCharacters.toLocaleString()} 字符
                    </small>
                  )}
                </span>
                <button
                  type="button"
                  className="icon"
                  aria-label="移除附件"
                  disabled={props.disabled}
                  title={"移除 " + a.name}
                  onClick={() => props.onRemove(a.id)}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {props.uploads.length > 0 && (
        <div className="chat-upload-list">
          {props.uploads.map((row) => (
            <div
              className={"chat-upload-row " + row.status}
              key={row.id}
              data-testid="chat-upload-row"
            >
              <div>
                {row.status === "uploading" ? (
                  <Loader2 size={13} className="spin" />
                ) : (
                  <AlertCircle size={13} />
                )}
                <span>
                  {row.name}
                  <small>
                    {row.status === "uploading"
                      ? `${bytes(row.size)} · ${row.progress}%`
                      : row.error}
                  </small>
                </span>
                {row.status === "failed" && (
                  <button
                    type="button"
                    className="icon"
                    aria-label={"重试上传 " + row.name}
                    disabled={props.disabled}
                    onClick={() => props.onRetryUpload(row.id)}
                  >
                    <RefreshCw size={13} />
                  </button>
                )}
                <button
                  type="button"
                  className="icon"
                  aria-label={"取消上传 " + row.name}
                  disabled={props.disabled}
                  onClick={() => props.onRemoveUpload(row.id)}
                >
                  <X size={13} />
                </button>
              </div>
              {row.status === "uploading" && (
                <progress max={100} value={row.progress} />
              )}
            </div>
          ))}
        </div>
      )}
      <div
        className={"composer " + (dragging ? "dragging" : "")}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node))
            setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!props.disabled) props.onFiles(e.dataTransfer.files);
        }}
      >
        <textarea
          ref={props.inputRef}
          aria-label="消息输入"
          value={props.draft}
          onChange={(e) => props.setDraft(e.target.value)}
          placeholder={
            props.disabled
              ? props.disabledReason || "先创建一个项目，开启对话创作…"
              : "描述创作目标，或添加参考图片与文档…"
          }
          disabled={props.disabled}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !composing.current &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              if (!blocked) props.onSend();
            }
          }}
          onPaste={(e) => {
            if (e.clipboardData.files.length && !props.disabled) {
              e.preventDefault();
              props.onFiles(e.clipboardData.files);
            }
          }}
        />
        <div className="composer-controls">
          <div className="chat-attach-menu">
            <button
              type="button"
              className="icon"
              title="添加附件"
              aria-label="添加附件"
              disabled={props.disabled}
              onClick={() => setMenu((v) => !v)}
            >
              <Plus size={17} />
            </button>
            {menu && (
              <div role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    picker.current?.click();
                  }}
                >
                  <Paperclip size={14} />
                  上传图片或文档
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    props.onReference();
                  }}
                >
                  <FileText size={14} />
                  引用项目资源
                </button>
                <small>
                  文档：MD / TXT / JSON / CSV，最大 {bytes(MAX_DOCUMENT_BYTES)}
                </small>
              </div>
            )}
          </div>
          <button
            type="button"
            className="icon"
            title="截取当前视口"
            disabled={props.disabled || props.busy}
            onClick={props.onCapture}
          >
            <Camera size={17} />
          </button>
          <span className="grow" />
          <span className="shortcut">Enter 发送 · Shift ↵ 换行</span>
          <button
            type="button"
            className="send-button"
            aria-label={props.busy ? "停止任务" : "发送消息"}
            disabled={props.disabled || (props.busy ? false : blocked)}
            onClick={props.busy ? props.onStop : props.onSend}
          >
            {props.busy ? (
              <Square size={13} />
            ) : props.loading ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <ArrowUp size={18} />
            )}
          </button>
        </div>
        {dragging && <div className="chat-drop-label">松开即可上传并引用</div>}
      </div>
      {(props.draft.length > 15000 ||
        referenceCount > 12 ||
        props.uploads.length > 0) && (
        <div
          className={
            "chat-composer-hint " +
            (props.draft.length > MAX_CHAT_PROMPT_CHARS || referenceCount > 12
              ? "error"
              : "")
          }
        >
          {props.draft.length > 15000
            ? `${props.draft.length.toLocaleString()} / 16,000 字符`
            : referenceCount > 12
              ? "每条消息最多 12 个附件，请减少引用。"
              : props.uploads.some((u) => u.status === "failed")
                ? "请重试或移除失败附件后发送。"
                : "附件上传完成后即可发送。"}
        </div>
      )}
      <div className="composer-foot">
        <span>
          <span className="dot" />
          {props.model || "请先配置模型"}
        </span>
        <span>
          {referenceCount
            ? `${referenceCount}/12 个引用`
            : "图片 · 文档 · 素材"}
        </span>
      </div>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        aria-label="上传对话附件"
        disabled={props.disabled}
        accept={[
          ".png",
          ".jpg",
          ".jpeg",
          ".webp",
          ".glb",
          ".gltf",
          ".fbx",
          ".obj",
          ".blend",
          ".hdr",
          ".exr",
          ...DOCUMENT_EXTENSIONS,
        ].join(",")}
        onChange={(e) => {
          if (e.target.files && !props.disabled) props.onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
