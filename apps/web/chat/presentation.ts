import type { ChatBlock } from "./timeline";

type Message = Extract<ChatBlock, { kind: "message" }>;

/** UI projection only. The event reducer and original receipt order stay intact. */
export function presentConversation(blocks: readonly ChatBlock[]) {
  const messages = blocks.filter(
    (block): block is Message =>
      block.kind === "message" && !!block.text.trim(),
  );
  // Verification retries may invoke several native turns inside one user run.
  // Earlier answers are evidence, not additional final responses.
  const latestTurn = messages.at(-1)?.turnId;
  const currentMessages = latestTurn
    ? messages.filter((block) => block.turnId === latestTurn)
    : messages;
  const final = currentMessages.filter(
    (block) => block.phase === "final_answer",
  );
  // Legacy runners omit phase. Only trailing unphased messages are answers;
  // earlier observations remain available in the chronological trace.
  const lastOperation = blocks.findLastIndex(
    (block) => block.kind === "tool" || block.kind === "plan",
  );
  const candidates = final.length
    ? final
    : blocks
        .slice(lastOperation + 1)
        .filter(
          (block): block is Message =>
            block.kind === "message" && !block.phase && !!block.text.trim(),
        );
  const latestItem = candidates.at(-1)?.itemId;
  const reply = latestTurn
    ? candidates.filter((block) => block.turnId === latestTurn)
    : final.length
      ? final
      : candidates.filter((block) => block.itemId === latestItem);
  const answerIds = new Set(reply.map((block) => block.id));
  return {
    reply,
    trace: blocks.filter(
      (block) => !answerIds.has(block.id) && block.kind !== "artifact",
    ),
    artifacts: blocks.filter(
      (block): block is Extract<ChatBlock, { kind: "artifact" }> =>
        block.kind === "artifact",
    ),
  };
}
