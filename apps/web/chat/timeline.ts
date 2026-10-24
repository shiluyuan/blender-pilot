import type {
  Capture,
  PilotEvent,
  Snapshot,
} from "../../../packages/contracts/index";

export type ChatBlock =
  | {
      kind: "message";
      id: string;
      itemId: string;
      text: string;
      phase?: string;
      status: "streaming" | "completed";
    }
  | {
      kind: "tool";
      id: string;
      callId: string;
      name: string;
      args?: unknown;
      result?: unknown;
      error?: string;
      startedAt?: string;
      completedAt?: string;
      receipt?: Record<string, unknown>;
      status: "running" | "completed" | "failed";
    }
  | {
      kind: "plan";
      id: string;
      itemId?: string;
      explanation?: string;
      steps: Array<{ step: string; status: string }>;
    }
  | { kind: "capture"; id: string; capture: Capture }
  | { kind: "snapshot"; id: string; snapshot: Snapshot }
  | { kind: "artifact"; id: string; artifact: Record<string, unknown> }
  | {
      kind: "verification";
      id: string;
      passed: boolean;
      observations: string;
      captureId?: string;
    }
  | { kind: "notice"; id: string; message: string; severity: "info" | "error" };

type MessageBlock = Extract<ChatBlock, { kind: "message" }>;
type ToolBlock = Extract<ChatBlock, { kind: "tool" }>;
const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Replay and live delivery share the same sequence identity, never array indices. */
export function mergePilotEvents(
  current: readonly PilotEvent[],
  incoming: readonly PilotEvent[],
): PilotEvent[] {
  const bySequence = new Map<string, PilotEvent>();
  for (const event of [...current, ...incoming]) {
    if (!Number.isSafeInteger(event.seq) || event.seq < 1 || !event.runId)
      continue;
    const key = `${event.runId}:${event.seq}`;
    // The persisted first occurrence wins if a reconnect repeats an event.
    if (!bySequence.has(key)) bySequence.set(key, event);
  }
  return [...bySequence.values()].sort(
    (a, b) => a.seq - b.seq || a.runId.localeCompare(b.runId),
  );
}

/** Build a transcript in event order; tool updates settle their original card. */
export function reduceTimeline(events: readonly PilotEvent[]): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  const messages = new Map<string, MessageBlock[]>();
  const tools = new Map<string, ToolBlock>();
  const plans = new Map<string, Extract<ChatBlock, { kind: "plan" }>>();
  const emitted = new Set<string>();

  const message = (
    event: PilotEvent,
    p: Record<string, unknown>,
    completed = false,
  ) => {
    const itemId = string(p.itemId) || `${event.runId}:legacy-message`;
    const key = `${event.runId}:${itemId}`;
    const parts = messages.get(key) || [];
    let last = parts.at(-1);
    const delta = string(p.delta);
    const snapshot = string(p.text);
    if (
      !last ||
      (!completed &&
        blocks.at(-1) !== last &&
        (delta || event.type === "message.started"))
    ) {
      last = {
        kind: "message",
        id: `${key}:${event.seq}`,
        itemId,
        text: "",
        phase: string(p.phase) || undefined,
        status: "streaming",
      };
      parts.push(last);
      messages.set(key, parts);
      blocks.push(last);
    }
    if (string(p.phase)) last.phase = string(p.phase);
    if (completed) {
      // Completion is an authoritative snapshot, not another delta. Preserve
      // tool-separated boundaries when the snapshot extends the streamed prefix.
      const prefix = parts
        .slice(0, -1)
        .map((part) => part.text)
        .join("");
      if (snapshot.startsWith(prefix))
        last.text = snapshot.slice(prefix.length);
      else {
        // A provider can correct a previously emitted prefix. Replace the old
        // text once, retaining the existing block locations in the transcript.
        let offset = 0;
        for (const part of parts.slice(0, -1)) {
          const length = part.text.length;
          part.text = snapshot.slice(offset, offset + length);
          offset += length;
        }
        last.text = snapshot.slice(offset);
      }
      for (const part of parts) part.status = "completed";
    } else if (delta) last.text += delta;
  };

  const tool = (
    event: PilotEvent,
    p: Record<string, unknown>,
    status: ToolBlock["status"],
  ) => {
    const callId =
      string(p.callId) ||
      string(p.itemId) ||
      `${event.runId}:tool:${event.seq}`;
    const key = `${event.runId}:${callId}`;
    let block = tools.get(key);
    if (!block) {
      block = {
        kind: "tool",
        id: key,
        callId,
        name: string(p.name) || "工具调用",
        status,
      };
      tools.set(key, block);
      blocks.push(block);
    }
    if (string(p.name)) block.name = string(p.name);
    if (p.args !== undefined) block.args = p.args;
    if (p.result !== undefined) block.result = p.result;
    if (status === "running" && !block.startedAt) block.startedAt = event.time;
    if (status !== "running") block.completedAt = event.time;
    if (p.error !== undefined)
      block.error =
        string(p.error) || string(record(p.error).message) || "工具执行失败";
    // A late duplicate start must never put a settled card back into running.
    if (status !== "running" || block.status === "running")
      block.status = status;
  };

  for (const event of mergePilotEvents([], events)) {
    const p = record(event.payload);
    if (
      ["message.started", "message.delta", "message.completed"].includes(
        event.type,
      )
    ) {
      message(event, p, event.type === "message.completed");
    } else if (
      event.type === "tool.started" ||
      event.type === "tool.completed" ||
      event.type === "tool.failed"
    ) {
      tool(
        event,
        p,
        event.type === "tool.started"
          ? "running"
          : event.type === "tool.completed"
            ? "completed"
            : "failed",
      );
    } else if (event.type === "plan.updated") {
      const key = `${event.runId}:plan:${string(p.itemId) || string(p.turnId) || "current"}`;
      let block = plans.get(key);
      if (!block) {
        block = {
          kind: "plan",
          id: key,
          itemId: string(p.itemId) || undefined,
          steps: [],
        };
        plans.set(key, block);
        blocks.push(block);
      }
      if (p.explanation !== undefined)
        block.explanation = string(p.explanation);
      const steps = Array.isArray(p.plan)
        ? p.plan
        : Array.isArray(p.steps)
          ? p.steps
          : undefined;
      if (steps)
        block.steps = steps
          .map((value) => {
            const step = record(value);
            return {
              step: string(step.step) || string(step.text),
              status: string(step.status) || "pending",
            };
          })
          .filter((step) => step.step);
    } else if (event.type === "capture.created") {
      const capture = record(p.capture);
      const id = string(capture.id);
      if (id && !emitted.has(`capture:${id}`)) {
        emitted.add(`capture:${id}`);
        blocks.push({
          kind: "capture",
          id: `capture:${id}`,
          capture: capture as unknown as Capture,
        });
      }
    } else if (event.type === "snapshot.created") {
      const snapshot = record(p.snapshot),
        id = string(snapshot.id);
      if (id && string(snapshot.projectId) && !emitted.has(`snapshot:${id}`)) {
        emitted.add(`snapshot:${id}`);
        blocks.push({
          kind: "snapshot",
          id: `snapshot:${id}`,
          snapshot: snapshot as unknown as Snapshot,
        });
      }
    } else if (event.type === "scene.receipt") {
      const block = tools.get(`${event.runId}:${string(p.callId)}`);
      if (block) block.receipt = record(p.receipt);
    } else if (event.type === "artifact.created") {
      const artifact = record(p.artifact);
      const id = string(artifact.id);
      if (id && !emitted.has(`artifact:${id}`)) {
        emitted.add(`artifact:${id}`);
        blocks.push({ kind: "artifact", id: `artifact:${id}`, artifact });
      }
    } else if (event.type === "verification") {
      blocks.push({
        kind: "verification",
        id: `${event.runId}:verification:${event.seq}`,
        passed: p.passed === true,
        observations: string(p.observations),
        captureId: string(p.captureId) || undefined,
      });
    } else if (event.type === "attachment.context") {
      const count = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0
          ? Math.floor(value)
          : 0;
      const characters = count(p.characters);
      const contextCharacters = Math.min(
        count(p.contextCharacters),
        characters,
      );
      const name = string(p.name) || "上传文档";
      const message =
        contextCharacters === 0
          ? `文档「${name}」正文未载入（总预算不足），已读取 0/${characters} 字符。`
          : p.truncated === true || contextCharacters < characters
            ? `文档「${name}」已读取 ${contextCharacters}/${characters} 字符，超出上下文预算的部分未载入。`
            : `已读取文档「${name}」${contextCharacters} 字符。`;
      blocks.push({
        kind: "notice",
        id: `${event.runId}:attachment:${event.seq}`,
        message,
        severity: contextCharacters === 0 ? "error" : "info",
      });
    } else if (event.type === "runtime.notice" || event.type === "diagnostic") {
      const text = string(p.message) || string(p.error) || string(p.text);
      if (text)
        blocks.push({
          kind: "notice",
          id: `${event.runId}:notice:${event.seq}`,
          message: text,
          severity:
            p.severity === "error" || p.level === "error" ? "error" : "info",
        });
    } else if (
      event.type === "runtime.item.started" ||
      event.type === "runtime.item.completed"
    ) {
      const item = record(p.item);
      const itemType = string(p.itemType) || string(item.type);
      // Native items also contain user grounding, reasoning and other control
      // records. Keep those in the journal and render only known operations.
      // Local MCP calls have their richer bridge lifecycle above.
      const server = string(p.server) || string(item.server);
      if (
        ![
          "commandExecution",
          "fileChange",
          "webSearch",
          "mcpToolCall",
        ].includes(itemType) ||
        (itemType === "mcpToolCall" &&
          ["blender", "blender-pilot", "blender_pilot"].includes(server))
      )
        continue;
      tool(
        event,
        {
          callId: string(p.callId) || string(p.itemId) || string(item.id),
          name: string(p.name) || string(item.tool) || itemType || "Agent 操作",
          args: item.command ?? item.query ?? item.arguments,
          result:
            item.output ?? item.aggregatedOutput ?? item.changes ?? item.result,
          error: item.error,
        },
        event.type === "runtime.item.started"
          ? "running"
          : item.status === "failed" || p.status === "failed"
            ? "failed"
            : "completed",
      );
    }
  }
  return blocks.filter(
    (block) =>
      block.kind !== "message" || block.text || block.status === "streaming",
  );
}
