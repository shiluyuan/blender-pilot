import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityGroup } from "../apps/web/chat/ActivityGroup.js";
import { groupActivity, type ChatBlock } from "../apps/web/chat/timeline.js";

const tool: Extract<ChatBlock, { kind: "tool" }> = {
  kind: "tool",
  id: "tool-1",
  callId: "call-1",
  name: "get_scene_info",
  status: "completed",
  args: { detail: "payload-only-on-expand" },
};
const plan: Extract<ChatBlock, { kind: "plan" }> = {
  kind: "plan",
  id: "plan-1",
  steps: [{ step: "读取场景", status: "completed" }],
};
const message: ChatBlock = {
  kind: "message",
  id: "msg-1",
  itemId: "msg-1",
  text: "观察结果",
  status: "completed",
};

test("activity grouping never moves messages, notices or captures across tools", () => {
  const source: ChatBlock[] = [
    plan,
    tool,
    message,
    { ...tool, id: "tool-2" },
    { kind: "notice", id: "error", message: "需要检查", severity: "error" },
    { ...tool, id: "tool-3" },
  ];
  const groups = groupActivity(source);
  assert.deepEqual(
    groups.map((block) => block.kind),
    ["activity", "message", "activity", "notice", "activity"],
  );
  assert.deepEqual(
    groups.flatMap<ChatBlock>((block) =>
      block.kind === "activity" ? block.items : [block],
    ),
    source,
  );
  assert.equal(groups[0].id, "activity-plan-1");
  assert.equal(source.length, 6);
});

test("finished operations collapse without hiding failures or missing receipts", () => {
  for (const [status, finished, expanded] of [
    ["completed", true, false],
    ["running", false, true],
    ["failed", true, true],
    ["running", true, true],
  ] as const) {
    const markup = renderToStaticMarkup(
      createElement(ActivityGroup, {
        finished,
        group: {
          kind: "activity",
          id: "group",
          items: [plan, { ...tool, status }],
        },
      }),
    );
    assert(
      markup.includes(`aria-expanded="${expanded}"`),
      `${status}/${finished}`,
    );
    assert.equal(markup.includes('data-call-id="call-1"'), expanded);
    assert(
      !markup.includes("payload-only-on-expand"),
      "tool payload stays lazy even while the activity rail is open",
    );
    if (status === "failed" || (status === "running" && finished))
      assert(markup.includes("操作需要检查"));
  }
});
