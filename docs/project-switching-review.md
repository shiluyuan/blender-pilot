# Project switching and compact sidebar

This pass improves the web workspace's project/conversation switching and reading density. The central Blender viewport and right-hand, collapsible assistant remain the primary product layout. The neutral light/dark palette is unchanged.

## Findings and changes

Previously, the browser waited for project activation, then requested sessions, cleared the conversation, fetched its runs, and replayed its events. The existing per-project Blender viewports already stayed mounted; this change preserves that behavior.

- Activation and session reads now run concurrently. The workspace changes ownership only after both succeed. Failure keeps the original project and its draft usable.
- Repeated clicks on the pending project are coalesced. Selecting the current project is a no-op. Request sequencing prevents a late activation response from replacing a newer selection.
- A dedicated `useConversationState` hook owns an in-memory working set of six session transcripts. Returning to a cached session displays it immediately, refreshes run receipts, and resumes incomplete event streams from their last sequence number. Completed event streams are not replayed unnecessarily.
- Inactive histories above 5,000 events are evicted on session changes. Authentication loss clears the cache. No transcripts are added to browser persistent storage, and the server remains authoritative. Drafts and attachments retain their existing session ownership.
- Fresh server run receipts replace unchanged cached receipts, while events received during a refresh are preserved. This prevents a cached running status from overriding a completed server receipt.
- Memoized message and Markdown components avoid reparsing unchanged replies on each keystroke. Collapsed tool details no longer format and mount hidden JSON payloads.

This does not eliminate cold Blender startup, large `.blend` loading, remote-desktop network latency, or GPU/rendering costs. No end-to-end latency improvement percentage is claimed from fixture measurements.

## Density and reference review

The reference sources were read directly, not inferred from project names:

- [AionUi MessageList](https://github.com/iOfficeAI/AionUi/blob/11cd2a9a20d1e033157636efc570b41384c66d85/packages/desktop/src/renderer/pages/conversation/Messages/MessageList.tsx): compact message spacing and memoized message rendering.
- [AionUi SendBox styles](https://github.com/iOfficeAI/AionUi/blob/11cd2a9a20d1e033157636efc570b41384c66d85/packages/desktop/src/renderer/components/chat/SendBox/sendbox.css): fixed action targets, shrinking metadata controls and compact tool grouping.
- [ComfyUI MCP Panel](https://github.com/artokun/comfyui-mcp-panel/blob/main/web/js/comfyui-mcp-panel.js): a shared text scale, compact line height, tool rows and progressive disclosure. Inspected blob: `bd6e7cd4dc1e9ebbc84b5584cacc60493350981a`.

These are interaction/layout references, not copied implementations or dependencies.

| Area                         | Before                     | Now                                                 |
| ---------------------------- | -------------------------- | --------------------------------------------------- |
| Body / composer text         | 14px, 1.75 line height     | 14px, 1.55 line height                              |
| Identity / supporting labels | 13px / 12px                | 13px / 12px                                         |
| Assistant header             | 44px                       | 40px, preserving 28px action targets                |
| Context row                  | At least 36px              | At least 28px                                       |
| Turn top spacing             | 22px                       | 12px                                                |
| User-to-assistant spacing    | 23px                       | 12px                                                |
| Composer minimum text height | 66px                       | 54px, still grows with the draft                    |
| Completed plan               | Expanded                   | Collapsed, expandable with native keyboard controls |
| Tool result                  | Hidden DOM still formatted | Mounted only while expanded                         |

The result groups status, message content, tool receipts and composer controls more closely without shrinking reading text to caption size. Error states, attachments, tool results and restoration controls remain accessible.

## Validation

- `PILOT_TEST_POSTGRES_MODE=wasm-wire npm run check`: TypeScript, 126 Node tests, 16 Python deployment tests and production build.
- `npm run verify:chat`: 22 checks; real browser + Fastify/SQL, explicit local Runner fixtures; includes cached-history refresh blocking, completed-stream replay avoidance, lazy tool details, compact density, IME, draft/upload ownership, SSE reconnect, cancellation, resize and 375px layouts.
- `npm run verify:interface`: 18 checks; includes concurrent session/activation requests, repeated-click coalescing, no-op selection, activation failure/retry and late-response ownership.
- `scripts/verify-project-ui.ts`: 7 checks; project creation, duplicate submission, rename, activation failure and native-window interface coverage.

Machine-readable results accompany this review in `docs/validation/switching-*.json`. These are frontend/protocol acceptance tests. They do not represent a new live-model, real-Blender, Docker, or user-device performance run. The existing production bundle-size advisory remains.

The README's real-Blender workbench hero is retained. Updated assistant-only captures are supplementary, explicitly fixture-based UI details.
