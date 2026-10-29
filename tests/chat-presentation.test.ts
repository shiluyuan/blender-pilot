import test from "node:test";
import assert from "node:assert/strict";
import { presentConversation } from "../apps/web/chat/presentation.js";
import type { ChatBlock } from "../apps/web/chat/timeline.js";

const message = (id: string, phase?: string): ChatBlock => ({
  kind: "message",
  id,
  itemId: id,
  text: id,
  phase,
  status: "completed",
});
const tool: ChatBlock = {
  kind: "tool",
  id: "tool",
  callId: "call",
  name: "save_scene",
  status: "completed",
};

test("explicit answers stay foreground while interleaved evidence retains exact trace order", () => {
  const blocks: ChatBlock[] = [
    message("observation", "commentary"),
    tool,
    message("answer-part-1", "final_answer"),
    {
      kind: "notice",
      id: "warning",
      severity: "error",
      message: "Important warning",
    },
    message("answer-part-2", "final_answer"),
    {
      kind: "artifact",
      id: "download",
      artifact: { id: "a", name: "scene.glb" },
    },
  ];
  const original = structuredClone(blocks);
  const result = presentConversation(blocks);
  assert.deepEqual(
    result.reply.map((b) => b.id),
    ["answer-part-1", "answer-part-2"],
  );
  assert.deepEqual(
    result.trace.map((b) => b.id),
    ["observation", "tool", "warning"],
  );
  assert.deepEqual(
    result.artifacts.map((b) => b.id),
    ["download"],
  );
  assert.deepEqual(
    blocks,
    original,
    "projection never mutates protocol history",
  );
  assert.equal(
    new Set(
      [...result.reply, ...result.trace, ...result.artifacts].map((b) => b.id),
    ).size,
    blocks.length,
  );
});

test("legacy and in-flight messages are retained without promoting commentary to a final answer", () => {
  const blocks = [
    message("intro"),
    tool,
    message("result"),
    message("details"),
  ];
  assert.deepEqual(
    presentConversation(blocks).reply.map((b) => b.id),
    ["details"],
  );
  assert.deepEqual(
    presentConversation([message("working", "commentary"), tool]).reply,
    [],
  );
  assert.equal(
    presentConversation([message("working", "commentary"), tool]).trace.length,
    2,
  );
  assert.deepEqual(
    presentConversation([message("plain-answer")]).reply.map((b) => b.id),
    ["plain-answer"],
  );
  assert.deepEqual(presentConversation([]), {
    reply: [],
    trace: [],
    artifacts: [],
  });
});

test("Codex messages without a phase remain eligible for the final reply", async () => {
  const { normalizeCodexEvent } =
    await import("../packages/contracts/chat-events.js");
  const { reduceTimeline } = await import("../apps/web/chat/timeline.js");
  for (const phase of [undefined, null, "final_answer", "commentary"]) {
    const event = normalizeCodexEvent("item/completed", {
      item: { id: "reply", type: "agentMessage", text: "Model answer", phase },
    })[0];
    if (phase == null) assert(!("phase" in event.payload));
    else assert.equal(event.payload.phase, phase);
    const blocks = reduceTimeline([
      {
        ...event,
        schemaVersion: 1,
        seq: 1,
        runId: "run",
        projectId: "project",
        sessionId: "session",
        time: new Date().toISOString(),
      },
    ]);
    assert.equal(
      presentConversation(blocks).reply.length,
      phase === "commentary" ? 0 : 1,
    );
  }
});

test("verification retries foreground only the latest native turn and keep earlier answers in the trace", () => {
  const blocks: ChatBlock[] = [
    { ...message("first", "final_answer"), turnId: "native-1" } as ChatBlock,
    tool,
    {
      ...message("retry-part-1", "final_answer"),
      turnId: "native-2",
    } as ChatBlock,
    {
      ...message("retry-part-2", "final_answer"),
      turnId: "native-2",
    } as ChatBlock,
  ];
  assert.deepEqual(
    presentConversation(blocks).reply.map((b) => b.id),
    ["retry-part-1", "retry-part-2"],
  );
  assert.deepEqual(
    presentConversation(blocks).trace.map((b) => b.id),
    ["first", "tool"],
  );
  const unphased = blocks.map((block) =>
    block.kind === "message" ? { ...block, phase: undefined } : block,
  );
  assert.deepEqual(
    presentConversation(unphased).reply.map((b) => b.id),
    ["retry-part-1", "retry-part-2"],
  );
});
