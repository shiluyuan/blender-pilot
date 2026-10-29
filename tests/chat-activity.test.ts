import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCard } from "../apps/web/chat/ActivityGroup.js";
import { TurnTrace } from "../apps/web/chat/TurnTrace.js";
import type { ChatBlock } from "../apps/web/chat/timeline.js";
import type { Run } from "../packages/contracts/index.js";
const tool: Extract<ChatBlock, { kind: "tool" }> = {
  kind: "tool",
  id: "tool-1",
  callId: "call-1",
  name: "save_scene",
  status: "completed",
  args: { privatePayload: "payload-only-on-expand" },
};

test("tool payload stays lazy and an unfinished tool never receives a success label", () => {
  for (const [status, label] of [
    ["completed", "完成"],
    ["failed", "失败"],
    ["running", "未收到完成回执"],
  ] as const) {
    const markup = renderToStaticMarkup(
      createElement(ToolCard, { block: { ...tool, status }, finished: true }),
    );
    assert(markup.includes(label));
    assert(!markup.includes("payload-only-on-expand"));
  }
});

test("one collapsed turn trace distinguishes historical failures, missing receipts and current execution", () => {
  for (const status of [
    "succeeded",
    "failed",
    "cancelled",
    "running",
  ] as const) {
    const markup = renderToStaticMarkup(
      createElement(TurnTrace, {
        run: { id: "run", status } as Run,
        busy: false,
        lightbox: () => {},
        blocks: [
          { ...tool, status: "failed" },
          { ...tool, id: "tool-2", callId: "call-2", status: "running" },
          {
            kind: "notice",
            id: "notice",
            severity: "error",
            message: "payload-error",
          },
        ],
      }),
    );
    assert(markup.includes('aria-expanded="false"'));
    assert(markup.includes("2 次操作"));
    assert(markup.includes("1 次失败记录"));
    assert(markup.includes("1 条异常记录"));
    assert(!markup.includes("payload-error"));
    assert(!markup.includes('data-call-id="call-1"'));
    if (status === "running") assert(markup.includes("保存场景"));
    else assert(markup.includes("1 次未回执"));
    assert(
      !markup.includes("操作需要检查"),
      "failed attempts do not redefine terminal outcome",
    );
  }
});
