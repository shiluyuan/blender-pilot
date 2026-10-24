/** Stable UI events derived from Codex app-server notifications. Native wire
 * names stay inside the adapter; the same envelope is persisted and replayed. */
export interface ChatProtocolEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface ChatRuntimeCapabilities {
  engine: "codex";
  protocol: "app-server";
  resume: boolean;
  cancel: boolean;
  userInput: boolean;
  permissions: boolean;
  images: boolean;
  textAttachments: boolean;
}

// Native MCP results may repeat image payloads already delivered through the
// Blender bridge. Keep references and text without writing base64 into events.
function eventValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(eventValue);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (object.type === "image")
      return { type: "image", mimeType: object.mimeType, omitted: true };
    return Object.fromEntries(
      Object.entries(object).map(([key, child]) => [key, eventValue(child)]),
    );
  }
  return value;
}

export function normalizeCodexEvent(
  method: string,
  params: Record<string, any>,
): ChatProtocolEvent[] {
  const context = {
    ...(typeof params.threadId === "string"
      ? { threadId: params.threadId }
      : {}),
    ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
  };
  if (method === "item/agentMessage/delta")
    return [
      {
        type: "message.delta",
        payload: {
          ...context,
          itemId: params.itemId ?? "assistant-" + (params.turnId ?? "current"),
          delta: typeof params.delta === "string" ? params.delta : "",
        },
      },
    ];
  if (["item/started", "item/completed"].includes(method)) {
    const item = params.item;
    if (!item || typeof item.id !== "string") return [];
    const completed = method === "item/completed";
    if (item.type === "agentMessage")
      return [
        {
          type: completed ? "message.completed" : "message.started",
          payload: {
            ...context,
            itemId: item.id,
            phase: item.phase ?? "commentary",
            text: typeof item.text === "string" ? item.text : "",
          },
        },
      ];
    return [
      {
        type: completed ? "runtime.item.completed" : "runtime.item.started",
        payload: {
          ...context,
          itemId: item.id,
          callId: item.id,
          itemType: item.type,
          name: item.tool ?? item.type,
          server: item.server,
          status: item.status ?? (completed ? "completed" : "inProgress"),
          item: eventValue(item),
        },
      },
    ];
  }
  if (method === "turn/plan/updated")
    return [
      {
        type: "plan.updated",
        payload: {
          ...context,
          explanation: params.explanation ?? "",
          steps: Array.isArray(params.plan) ? params.plan : [],
        },
      },
    ];
  if (method === "thread/tokenUsage/updated")
    return [
      {
        type: "usage",
        payload: { ...context, kind: "snapshot", usage: params.tokenUsage },
      },
    ];
  if (method === "runtime/capabilities")
    return [{ type: "runtime.capabilities", payload: params }];
  if (method === "runtime/notice")
    return [{ type: "runtime.notice", payload: params }];
  if (method === "error")
    return [
      {
        type: "runtime.notice",
        payload: {
          ...context,
          level: params.willRetry ? "warning" : "error",
          message: params.error?.message ?? "Codex 执行错误",
          willRetry: params.willRetry === true,
        },
      },
    ];
  return [];
}
