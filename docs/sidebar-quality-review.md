# Sidebar and frontend module review — 2026-10-29

This change focuses on the conversation sidebar and frontend maintainability. The user has verified Blender locally; this review does not claim a new real-Blender or live-model acceptance run.

## Module boundaries

The workbench entry file decreases from 2,245 to 1,784 lines. The extracted modules own distinct responsibilities:

| Module                                             | Responsibility                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/web/chat/ChatPanel.tsx`                      | Assistant header, connection context and resizable panel shell                        |
| `apps/web/chat/usePanelWidth.ts`                   | Persisted width, pointer capture, cancellation and keyboard sizing                    |
| `apps/web/chat/ChatWelcome.tsx`                    | Empty conversation, prompt suggestions and template entry                             |
| `apps/web/chat/conversation.css`                   | Transcript, Markdown, tool events, composer details and panel-local responsive styles |
| `apps/web/auth/Login.tsx`                          | Login form and authentication feedback                                                |
| `apps/web/settings/Settings.tsx`                   | Model connection configuration and settings presentation                              |
| `apps/web/components/{Mark,PageHeading,Empty}.tsx` | Shared presentational components                                                      |

Session state, drafts, attachment ownership and command dispatch stay in their existing owners. The shell receives typed callbacks and children; it does not introduce a second copy of conversation state. No runtime dependencies or new framework were added. This is source decomposition, not bundle splitting.

## Visual and interaction changes

The existing VoiceStudio-inspired neutral light/dark palette is retained. Current-run screenshots were captured before editing and after the change, including populated messages, long content and narrow layouts.

- Reading text and the composer use a shared **14px / 1.75** scale; identity labels use **13px**, auxiliary text **12px**. Markdown heading levels are **18/16/15/14px**, so a third-level heading no longer renders smaller than body text.
- Welcome content uses tighter vertical spacing, with a **20px** heading (**18px** in narrow panels), readable description text, wrapping suggestions and aligned trailing icons.
- Header action targets increase from **24px to 28px**. Buttons have explicit accessible names; the resize separator exposes its current value, bounds and controlled region, with visible keyboard focus.
- Composer corners are reduced to **12px**. Long model names truncate with a full-name tooltip; their status dot keeps its spacing. Code and wide tables scroll inside their own containers.
- Container queries respond to the actual sidebar width, including manual resizing. The narrowest tested viewport is **375 × 667**; the assistant, references and send controls remain inside the viewport.
- Pointer capture replaces global drag listeners. Pointer cancellation and lost capture stop resizing, and unmounting leaves no global listeners. Invalid saved widths fall back to 400px; finite positive widths are clamped to 340–640px.

Resize controls: drag the divider, use Left/Right for 20px steps, Home/End for the bounds, or double-click to restore 400px. Width survives collapse, navigation and reload. On narrow windows the panel fits the available space.

## Executed checks

| Check                                                              | Result                                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `npm run check` with explicit `PILOT_TEST_POSTGRES_MODE=wasm-wire` | 126 Node tests, 16 Python tests, typecheck and production build passed |
| Final production build after composer adjustment                   | Passed                                                                 |
| Chat browser suite                                                 | 19 checks passed; zero uncaught application errors                     |
| Interface/system-status browser suite                              | 16 checks passed; zero uncaught application errors                     |
| Project browser suite                                              | 7 checks passed; zero uncaught application errors                      |
| `git diff --check`                                                 | Passed                                                                 |

The chat suite exercises IME input, Markdown uploads, event replay, session isolation, attachment ownership, lost receipts without duplicate runs, scroll-follow behavior, cancellation, history recovery and sidebar collapse. New cases cover actual pointer dragging and cancellation, keyboard sizing, double-click reset, width persistence, corrupt saved preferences, computed typography and 900/768/375px windows. Existing coverage includes a 340px sidebar at a 1280px window, long filenames, code blocks and tables. Platform-font inspection verifies actual sans-serif glyph rendering rather than relying only on the CSS font-family declaration.

Machine-readable evidence: [chat](validation/sidebar-chat-0.1.0.json), [interface](validation/sidebar-interface-0.1.0.json), [projects](validation/sidebar-projects-0.1.0.json). Screenshots are generated by the suites under `.data/chat-acceptance/`, `.data/interface-acceptance/` and `.data/project-ui/`; they deliberately label runner/model fixtures and are not substituted for real Blender product screenshots in the README.

These browser tests use the real Fastify application and pg driver over an explicit PostgreSQL WASM/TCP test engine, with deterministic runner fixtures. Native PostgreSQL, physical-device browsers, real model inference and Blender execution were outside this pass. The existing bundle-size advisory and further workbench/API/executor decomposition remain documented in [code quality review](code-quality-review.md).
