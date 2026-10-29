# Reply-focused conversation workspace

The workspace keeps real Blender in the center and its collapsible assistant on the right. This revision reorganizes the conversation itself: the user request, the assistant's answer and one result are the default reading surface. It supersedes the adjacent-tool grouping in [the earlier compact layout](compact-conversation-review.md).

## Interaction

- Each user turn has **one execution disclosure**. Opening it reveals the chronological commentary, plans, tools, automatic captures, verification attempts and recovery points. Closing it unmounts the receipts and tool payloads.
- Completed traces default to collapsed. While working, the current tool and latest progress remain visible without opening the full log. Expanding or closing the trace respects the reader's scroll position.
- A failed attempt is labeled as a historical failure, independently of the run's final status. Missing tool receipts and error notices are counted explicitly. Failed, interrupted and cancelled run states remain visible; the final run error is never moved inside the disclosure.
- Final answers stay outside the execution trace. Verification retries can start several native Codex turns within one user run: only the latest native turn supplies the foreground answer, and earlier answers remain inspectable in the trace. Copy reply copies the displayed answer.
- One result card shows a current preview, object changes and save status. **Compare, inspect and restore** opens the before/after evidence, structural findings and recovery action. Missing post-operation images and incomplete stages remain visible. Result files keep direct download links.
- The input frame contains references, upload progress, model identity, attachment/capture controls and send/stop. The attachment menu supports arrow keys, Escape with focus restoration, and outside-click dismissal. IME composition, paste/drop, retry and session-owned drafts retain the existing behavior.
- Default width is 400px, adjustable from 340 to 640px. Reading text remains 14px with 21px line height. VoiceStudio's neutral light/dark palette and the main Blender canvas remain intact.

The interaction hierarchy draws on the previously inspected AionUi MessageList/SendBox and ComfyUI MCP panel references. This is a Blender-specific implementation, not a claim of pixel-identical cloning or full feature parity.

## Implementation and compatibility

`timeline.ts` remains the chronological protocol reducer. It now retains native `turnId` on message blocks. `presentation.ts` makes a pure, linear projection into reply, trace and files; it never rewrites persisted events. `RunView.tsx` composes these surfaces. `TurnTrace.tsx` owns disclosure state, `TraceBlock.tsx` renders receipts, and `ActivityGroup.tsx` contains the reusable tool/plan rows. No new runtime dependency or database migration was added.

The Codex adapter previously assigned `commentary` when a provider omitted its message phase. That could hide a compatible provider's actual answer inside the new trace. The adapter now preserves a missing phase. Explicit `final_answer` and `commentary` remain authoritative; unphased trailing output is the fallback. Older persisted messages explicitly labeled as commentary stay available in the execution trace rather than being reclassified without evidence.

## Acceptance and limits

- 132 Node tests and 16 Python deployment tests; TypeScript and production build pass.
- 24 conversation browser checks, including menu keyboard interaction, final reply visibility, ordered trace expansion, uploads, IME, cancellation, reconnect/replay, uncertain receipts, session ownership, scroll intent, resizing and narrow layouts.
- 18 interface checks cover project switching, stale activation responses, duplicate activation suppression, drafts and system status. 18 skills/workflow checks cover skill installation and selection, result evidence and recovery confirmation.
- Real Blender 4.0.2, mcp-for-blender 2.2.2 and native Codex app-server pass mesh mutation, library asset reuse, snapshots, exports, image transport, thread resume, cancellation, authenticated VNC and sidebar continuity. Browser acceptance checks that the real native answer is visible, the trace starts collapsed and the result preview appears once.
- The native suite uses deterministic local model responses, **not live inference**. Database tests use the explicitly selected PostgreSQL WASM engine over TCP; native PostgreSQL and Docker were not rerun in this environment. The existing production bundle-size advisory remains.

Machine-readable results are in [`validation/reply-chat.json`](validation/reply-chat.json), [`reply-interface.json`](validation/reply-interface.json), [`reply-skills.json`](validation/reply-skills.json) and [`reply-native.json`](validation/reply-native.json). Current README screenshots are actual browser captures; their manifests record the application revision, dimensions and hashes. No image is generated or composited.
