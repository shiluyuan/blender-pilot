import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Run } from "../../../packages/contracts/index";
import { api, ApiError, post, upload } from "../api";
import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_PROMPT_CHARS,
} from "../../../packages/contracts/chat-limits";

export interface ChatAttachment {
  id: string;
  name: string;
  kind: string;
  mime?: string;
  documentInfo?: import("../../../packages/contracts/attachments").DocumentInfo;
}
export interface ChatUpload {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: "uploading" | "failed";
  error?: string;
}
export interface ChatOutbox {
  clientRequestId: string;
  text: string;
  attachments: ChatAttachment[];
  projectId: string;
  sessionId: string;
  createdAt: string;
  status: "sending" | "error";
  error?: string;
  uncertain?: boolean;
}
interface DraftRecord {
  text: string;
  attachments: ChatAttachment[];
  uploads: ChatUpload[];
  outbox?: ChatOutbox;
  revision: number;
}
const empty = (): DraftRecord => ({
  text: "",
  attachments: [],
  uploads: [],
  revision: 0,
});
const keyFor = (id: string) => "pilot-chat-draft:" + id;
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const safeStore = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* A full browser store must not block editing. */
  }
};

/** The destination is captured before every await. Uploads and receipts never
 * use whichever conversation happens to be selected when they finish. */
export function useChatComposer(options: {
  projectId?: string;
  sessionId?: string;
  authenticated?: boolean;
  onAccepted: (run: Run) => void;
  onError: (message: string) => void;
}) {
  const records = useRef(new Map<string, DraftRecord>());
  const callbacks = useRef(options);
  callbacks.current = options;
  const files = useRef(new Map<string, File>());
  const controllers = useRef(new Map<string, AbortController>());
  const sending = useRef(new Set<string>());
  const [, redraw] = useState(0);
  const { projectId, sessionId, authenticated = true } = options;
  const get = (id: string, pid?: string): DraftRecord => {
    const cached = records.current.get(id);
    if (cached) return cached;
    let record = empty();
    try {
      const saved = JSON.parse(localStorage.getItem(keyFor(id)) || "null");
      if (
        saved &&
        typeof saved.text === "string" &&
        Array.isArray(saved.attachments)
      ) {
        record = {
          ...empty(),
          ...saved,
          uploads: (saved.uploads || []).map((u: ChatUpload) => ({
            ...u,
            status: "failed",
            error: "页面已刷新，请移除此项后重新选择原文件。",
          })),
          outbox: saved.outbox
            ? {
                ...saved.outbox,
                status: "error",
                uncertain: true,
                error: "正在核对上一条消息的接收结果…",
              }
            : undefined,
        };
      } else if (pid) {
        const legacy = JSON.parse(
          localStorage.getItem("pilot-workspace:" + pid) || "null",
        );
        if (legacy?.sessionId === id)
          record = {
            ...record,
            text: legacy.draft || "",
            attachments: legacy.attachments || [],
          };
      }
    } catch {
      /* Ignore a malformed old draft, not the server conversation. */
    }
    records.current.set(id, record);
    return record;
  };
  const change = (id: string, update: (record: DraftRecord) => DraftRecord) => {
    const next = update(get(id));
    records.current.set(id, next);
    safeStore(keyFor(id), next);
    redraw((n) => n + 1);
  };
  const current = sessionId ? get(sessionId, projectId) : empty();
  useEffect(() => {
    if (!authenticated || !sessionId || !projectId) return;
    try {
      localStorage.setItem("pilot-chat-active:" + projectId, sessionId);
    } catch {}
    const pending = get(sessionId).outbox;
    if (!pending || sending.current.has(sessionId)) return;
    let cancelled = false;
    void api<{ run: Run | null }>(
      `/sessions/${sessionId}/requests/${pending.clientRequestId}`,
    )
      .then(({ run }) => {
        if (cancelled) return;
        if (run) {
          change(sessionId, (r) =>
            r.outbox?.clientRequestId === pending.clientRequestId
              ? { ...r, outbox: undefined }
              : r,
          );
          callbacks.current.onAccepted(run);
        } else
          change(sessionId, (r) =>
            r.outbox?.clientRequestId === pending.clientRequestId
              ? {
                  ...r,
                  outbox: {
                    ...pending,
                    status: "error",
                    uncertain: true,
                    error:
                      "尚未收到接收回执。重试会使用原消息编号，避免重复任务。",
                  },
                }
              : r,
          );
      })
      .catch(() => {
        if (!cancelled)
          change(sessionId, (r) =>
            r.outbox?.clientRequestId === pending.clientRequestId
              ? {
                  ...r,
                  outbox: {
                    ...r.outbox,
                    status: "error",
                    uncertain: true,
                    error: "暂时无法核对回执，请恢复连接后重试确认。",
                  },
                }
              : r,
          );
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, projectId, authenticated]);
  useEffect(() => () => controllers.current.forEach((c) => c.abort()), []);

  const setDraft: Dispatch<SetStateAction<string>> = (value) => {
    if (sessionId)
      change(sessionId, (r) => ({
        ...r,
        text: typeof value === "function" ? value(r.text) : value,
        revision: r.revision + 1,
      }));
  };
  const setAttachments: Dispatch<SetStateAction<ChatAttachment[]>> = (
    value,
  ) => {
    if (sessionId)
      change(sessionId, (r) => ({
        ...r,
        attachments: typeof value === "function" ? value(r.attachments) : value,
        revision: r.revision + 1,
      }));
  };
  const applyTemplate = (input: {
    projectId: string;
    sessionId: string;
    prompt: string;
    attachments: ChatAttachment[];
  }) => {
    if (
      callbacks.current.projectId !== input.projectId ||
      callbacks.current.sessionId !== input.sessionId
    )
      throw new Error("当前项目或对话已切换，请重新应用模板");
    // Read once at commit time: uploads or later edits may have completed while
    // the template was revalidating its files. Commit text and references together.
    change(input.sessionId, (record) => {
      if (record.outbox || sending.current.has(input.sessionId))
        throw new Error("请先确认上一条消息的接收结果，再应用模板");
      const text = record.text.trim()
        ? `${record.text}\n\n${input.prompt}`
        : input.prompt;
      if (text.length > MAX_CHAT_PROMPT_CHARS)
        throw new Error(
          `模板与当前草稿合计超过 ${MAX_CHAT_PROMPT_CHARS} 字符，请缩短后重试；当前草稿已保留`,
        );
      const byId = new Map(record.attachments.map((ref) => [ref.id, ref]));
      for (const ref of input.attachments)
        if (!byId.has(ref.id)) byId.set(ref.id, ref);
      if (byId.size + record.uploads.length > MAX_CHAT_ATTACHMENTS)
        throw new Error(
          `模板、当前附件与待完成上传合计超过 ${MAX_CHAT_ATTACHMENTS} 项，请减少引用；当前草稿已保留`,
        );
      return {
        ...record,
        text,
        attachments: [...byId.values()],
        revision: record.revision + 1,
      };
    });
  };
  const accepted = (id: string, pending: ChatOutbox, run: Run) => {
    change(id, (r) =>
      r.outbox?.clientRequestId === pending.clientRequestId
        ? { ...r, outbox: undefined }
        : r,
    );
    callbacks.current.onAccepted(run);
  };
  const deliver = async (pending: ChatOutbox) => {
    const id = pending.sessionId;
    if (sending.current.has(id)) return;
    sending.current.add(id);
    change(id, (r) => ({
      ...r,
      outbox: { ...pending, status: "sending", error: undefined },
    }));
    let receiptUnconfirmed = pending.uncertain === true;
    try {
      if (pending.uncertain) {
        const found = await api<{ run: Run | null }>(
          `/sessions/${id}/requests/${pending.clientRequestId}`,
        );
        if (found.run) {
          accepted(id, pending, found.run);
          return;
        }
        receiptUnconfirmed = false;
      }
      const run = await post<Run>(`/sessions/${id}/turns`, {
        text: pending.text,
        assetIds: pending.attachments
          .filter((a) => a.kind !== "library")
          .map((a) => a.id),
        libraryAssetIds: pending.attachments
          .filter((a) => a.kind === "library")
          .map((a) => a.id),
        clientRequestId: pending.clientRequestId,
      });
      accepted(id, pending, run);
    } catch (e) {
      const uncertain =
        receiptUnconfirmed ||
        !(
          e instanceof ApiError &&
          e.status >= 400 &&
          e.status < 500 &&
          e.status !== 408 &&
          e.status !== 429
        );
      change(id, (r) =>
        r.outbox?.clientRequestId === pending.clientRequestId
          ? {
              ...r,
              outbox: {
                ...pending,
                status: "error",
                uncertain,
                error: messageOf(e),
              },
            }
          : r,
      );
    } finally {
      sending.current.delete(id);
    }
  };
  const send = async () => {
    if (!sessionId || !projectId || sending.current.has(sessionId)) return;
    const record = get(sessionId);
    if (record.text.length > MAX_CHAT_PROMPT_CHARS) {
      callbacks.current.onError(
        `消息不能超过 ${MAX_CHAT_PROMPT_CHARS} 字符，请缩短后发送。`,
      );
      return;
    }
    if (
      record.outbox ||
      record.uploads.length ||
      !record.text.trim() ||
      record.attachments.length > 12
    )
      return;
    const pending: ChatOutbox = {
      clientRequestId: crypto.randomUUID(),
      text: record.text,
      attachments: [...record.attachments],
      projectId,
      sessionId,
      createdAt: new Date().toISOString(),
      status: "sending",
    };
    // Clear only the submitted revision, synchronously. Later typing is a new draft.
    change(sessionId, (r) => ({
      ...r,
      text: "",
      attachments: [],
      outbox: pending,
      revision: r.revision + 1,
    }));
    await deliver(pending);
  };
  const retry = async () => {
    if (sessionId && get(sessionId).outbox)
      await deliver(get(sessionId).outbox!);
  };
  const moveBack = () => {
    if (!sessionId) return;
    change(sessionId, (r) => {
      if (!r.outbox || r.outbox.uncertain || r.outbox.status === "sending")
        return r;
      const old = r.outbox;
      const attachments = [
        ...old.attachments,
        ...r.attachments.filter(
          (a) => !old.attachments.some((b) => a.id === b.id),
        ),
      ];
      return {
        ...r,
        text: [old.text, r.text].filter(Boolean).join("\n\n"),
        attachments,
        outbox: undefined,
        revision: r.revision + 1,
      };
    });
  };
  const performUpload = async (
    sid: string,
    pid: string,
    row: ChatUpload,
    file: File,
  ) => {
    const controller = new AbortController();
    controllers.current.set(row.id, controller);
    change(sid, (r) => ({
      ...r,
      uploads: r.uploads.map((u) =>
        u.id === row.id ? { ...u, status: "uploading", error: undefined } : u,
      ),
    }));
    try {
      const asset = await upload(
        file,
        pid,
        (progress) =>
          change(sid, (r) => ({
            ...r,
            uploads: r.uploads.map((u) =>
              u.id === row.id ? { ...u, progress } : u,
            ),
          })),
        undefined,
        { signal: controller.signal, scope: sid },
      );
      if (controller.signal.aborted) return;
      change(sid, (r) => ({
        ...r,
        uploads: r.uploads.filter((u) => u.id !== row.id),
        attachments: r.attachments.some((a) => a.id === asset.id)
          ? r.attachments
          : [
              ...r.attachments,
              {
                id: asset.id,
                name: asset.name || file.name,
                kind: "asset",
                mime: asset.mime || file.type,
                documentInfo: asset.documentInfo,
              },
            ],
      }));
      files.current.delete(row.id);
    } catch (e) {
      if (!controller.signal.aborted)
        change(sid, (r) => ({
          ...r,
          uploads: r.uploads.map((u) =>
            u.id === row.id
              ? { ...u, status: "failed", error: messageOf(e) }
              : u,
          ),
        }));
    } finally {
      controllers.current.delete(row.id);
    }
  };
  const uploadFiles = (list: FileList | File[]) => {
    if (!sessionId || !projectId) return;
    const listFiles = Array.from(list),
      record = get(sessionId);
    if (
      record.attachments.length + record.uploads.length + listFiles.length >
      12
    ) {
      callbacks.current.onError("每条消息最多引用 12 个附件，请减少选择。");
      return;
    }
    for (const file of listFiles) {
      const row: ChatUpload = {
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        progress: 0,
        status: "uploading",
      };
      files.current.set(row.id, file);
      change(sessionId, (r) => ({ ...r, uploads: [...r.uploads, row] }));
      void performUpload(sessionId, projectId, row, file);
    }
  };
  const removeUpload = (id: string) => {
    if (!sessionId) return;
    controllers.current.get(id)?.abort();
    files.current.delete(id);
    change(sessionId, (r) => ({
      ...r,
      uploads: r.uploads.filter((u) => u.id !== id),
    }));
  };
  const retryUpload = (id: string) => {
    if (!sessionId || !projectId) return;
    if (controllers.current.has(id)) return;
    const file = files.current.get(id),
      row = get(sessionId).uploads.find((u) => u.id === id);
    if (file && row) void performUpload(sessionId, projectId, row, file);
    else
      callbacks.current.onError(
        "请移除此项后重新选择原文件；服务器已收到的分片会继续复用。",
      );
  };
  return {
    draft: current.text,
    setDraft,
    attachments: current.attachments,
    setAttachments,
    applyTemplate,
    uploads: current.uploads,
    outbox: current.outbox,
    loading: current.outbox?.status === "sending",
    send,
    retry,
    moveBack,
    uploadFiles,
    removeUpload,
    retryUpload,
  };
}
