import test from "node:test";
import assert from "node:assert/strict";
import type { PilotEvent } from "../packages/contracts/index.js";
import { mergePilotEvents, reduceTimeline } from "../apps/web/chat/timeline.js";

function event(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  runId = "run-a",
): PilotEvent {
  return {
    schemaVersion: 1,
    runId,
    seq,
    type,
    payload,
    time: "2026-10-24T00:00:00Z",
  };
}

test("transcript preserves text, tool, screenshot and reply order on replay", () => {
  const events = [
    event(1, "message.started", { itemId: "before", phase: "commentary" }),
    event(2, "message.delta", { itemId: "before", delta: "先创建" }),
    event(3, "message.completed", { itemId: "before", text: "先创建立方体。" }),
    event(4, "tool.started", {
      callId: "python",
      name: "execute_blender_code",
      args: { code: "create_cube()" },
    }),
    event(5, "capture.created", { capture: { id: "picture" } }),
    event(6, "tool.completed", { callId: "python", result: { objects: 1 } }),
    event(7, "message.delta", { itemId: "after", delta: "已经" }),
    event(8, "message.completed", {
      itemId: "after",
      phase: "final_answer",
      text: "已经创建完成。",
    }),
  ];
  const blocks = reduceTimeline([
    ...events.slice(5),
    ...events.slice(0, 5),
    events[1],
  ]);
  assert.deepEqual(
    blocks.map((x) => x.kind),
    ["message", "tool", "capture", "message"],
  );
  assert.equal(
    blocks[0].kind === "message" && blocks[0].text,
    "先创建立方体。",
  );
  assert.equal(blocks[1].kind === "tool" && blocks[1].status, "completed");
  assert.equal(
    blocks[3].kind === "message" && blocks[3].text,
    "已经创建完成。",
  );
});

test("completion replaces streamed snapshot without duplicating tool-separated text", () => {
  const blocks = reduceTimeline([
    event(1, "message.delta", { itemId: "shared", delta: "前文" }),
    event(2, "tool.started", { callId: "read", name: "get_scene_info" }),
    event(3, "message.delta", { itemId: "shared", delta: "后文" }),
    event(4, "message.completed", { itemId: "shared", text: "前文后文补充" }),
  ]);
  assert.deepEqual(
    blocks.map((x) => x.kind),
    ["message", "tool", "message"],
  );
  assert.deepEqual(
    blocks.filter((x) => x.kind === "message").map((x) => x.text),
    ["前文", "后文补充"],
  );
});

test("orphan tool terminal events display failure and a late start cannot resurrect them", () => {
  const blocks = reduceTimeline([
    event(1, "tool.failed", {
      callId: "broken",
      name: "import_asset",
      error: { message: "文件损坏" },
    }),
    event(2, "tool.started", { callId: "broken", name: "import_asset" }),
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind === "tool" && blocks[0].status, "failed");
  assert.equal(blocks[0].kind === "tool" && blocks[0].error, "文件损坏");
});

test("plan and tool updates keep their original transcript slots", () => {
  const blocks = reduceTimeline([
    event(1, "plan.updated", {
      plan: [{ step: "建模", status: "inProgress" }],
    }),
    event(2, "message.delta", { itemId: "m", delta: "执行中" }),
    event(3, "plan.updated", {
      explanation: "已完成",
      plan: [{ step: "建模", status: "completed" }],
    }),
    event(4, "runtime.notice", { message: "已恢复连接", severity: "info" }),
    event(5, "runtime.item.started", {
      itemId: "native",
      itemType: "commandExecution",
      item: { command: "inspect" },
    }),
    event(6, "runtime.item.completed", {
      itemId: "native",
      itemType: "commandExecution",
      item: { aggregatedOutput: "done" },
    }),
  ]);
  assert.deepEqual(
    blocks.map((x) => x.kind),
    ["plan", "message", "notice", "tool"],
  );
  assert.equal(
    blocks[0].kind === "plan" && blocks[0].steps[0].status,
    "completed",
  );
  assert.equal(blocks[3].kind === "tool" && blocks[3].result, "done");
});

test("replayed event sequences are deduplicated per run without trusting conflicting frames", () => {
  const first = event(1, "message.delta", { itemId: "a", delta: "one" });
  const duplicate = event(1, "message.delta", {
    itemId: "a",
    delta: "corrupt",
  });
  const other = event(
    1,
    "message.delta",
    { itemId: "b", delta: "other" },
    "run-b",
  );
  assert.deepEqual(mergePilotEvents([first], [duplicate, other]), [
    first,
    other,
  ]);
  assert.equal(
    reduceTimeline([first, duplicate])[0].kind === "message" &&
      (reduceTimeline([first, duplicate])[0] as { text: string }).text,
    "one",
  );
});

test("malformed text never renders object coercions and duplicate MCP runtime items stay hidden", () => {
  const blocks = reduceTimeline([
    event(1, "message.delta", { itemId: "m", delta: { text: "not a string" } }),
    event(2, "message.completed", { itemId: "m", text: { invalid: true } }),
    event(3, "runtime.item.completed", {
      itemId: "mcp",
      itemType: "mcpToolCall",
      server: "blender",
      item: {},
    }),
    event(4, "capture.created", { capture: { id: "same" } }),
    event(5, "capture.created", { capture: { id: "same" } }),
  ]);
  assert.deepEqual(
    blocks.map((x) => x.kind),
    ["capture"],
  );
  assert(!JSON.stringify(blocks).includes("[object Object]"));
});

test("other MCP servers retain their native tool lifecycle", () => {
  const blocks = reduceTimeline([
    event(1, "runtime.item.started", {
      itemId: "external",
      itemType: "mcpToolCall",
      server: "assets",
      name: "search",
      item: { arguments: { term: "chair" } },
    }),
    event(2, "runtime.item.completed", {
      itemId: "external",
      itemType: "mcpToolCall",
      server: "assets",
      name: "search",
      item: { result: { count: 4 } },
    }),
  ]);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], {
    kind: "tool",
    id: "run-a:external",
    callId: "external",
    name: "search",
    args: { term: "chair" },
    result: { count: 4 },
    status: "completed",
  });
});

test("native user grounding and non-operation items never become visible tool cards", () => {
  const internalText = "INTERNAL_GROUNDING_NOT_FOR_TRANSCRIPT";
  const events = [
    "userMessage",
    "reasoning",
    "agentMessage",
    "plan",
    "contextCompaction",
    "futureUnknownItem",
  ].flatMap((itemType, i) => [
    event(i * 2 + 1, "runtime.item.started", {
      itemId: `native-${itemType}`,
      itemType,
      item: { type: itemType, text: internalText, content: [internalText] },
    }),
    event(i * 2 + 2, "runtime.item.completed", {
      itemId: `native-${itemType}`,
      itemType,
      item: { type: itemType, text: internalText, content: [internalText] },
    }),
  ]);
  events.push(
    event(13, "message.completed", { itemId: "visible", text: "场景已保存。" }),
    event(14, "runtime.item.completed", {
      itemId: "file-operation",
      itemType: "fileChange",
      item: { changes: [{ path: "scene.py", kind: "update" }] },
    }),
  );
  const blocks = reduceTimeline(events);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["message", "tool"],
  );
  assert.equal(blocks[1].kind === "tool" && blocks[1].name, "fileChange");
  assert(!JSON.stringify(blocks).includes(internalText));
  assert.equal(
    events.length,
    14,
    "the persisted journal input remains untouched",
  );
});

test("document context receipts distinguish full, truncated and zero-budget reads", () => {
  const blocks = reduceTimeline([
    event(1, "attachment.context", {
      assetId: "brief",
      name: "场景说明.md",
      characters: 120,
      contextCharacters: 120,
      truncated: false,
    }),
    event(2, "attachment.context", {
      assetId: "long",
      name: "完整剧本.txt",
      characters: 50000,
      contextCharacters: 10000,
      truncated: true,
    }),
    event(3, "attachment.context", {
      assetId: "omitted",
      name: "补充要求.md",
      characters: 2000,
      contextCharacters: 0,
      truncated: true,
    }),
  ]);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["notice", "notice", "notice"],
  );
  const notices = blocks.filter((block) => block.kind === "notice");
  assert.equal(notices[0].message, "已读取文档「场景说明.md」120 字符。");
  assert.match(notices[1].message, /10000\/50000 字符/);
  assert.match(notices[1].message, /部分未载入/);
  assert.match(notices[2].message, /正文未载入（总预算不足）/);
  assert.match(notices[2].message, /0\/2000 字符/);
  assert.equal(notices[2].severity, "error");
  assert(!notices[2].message.startsWith("已读取文档"));
});
