# Compact conversation layout

This pass replaces the previous spacing-only adjustment with a denser message structure. The central Blender viewport and collapsible right assistant remain the core workspace.

## Structure

- One 50px header contains assistant identity, session title, connection status and history/new/collapse actions. Automatic capture status remains available through its camera indicator and accessible label.
- The user identity sits beside the prompt instead of occupying another full row; its tooltip retains the timestamp. Attachments align with the prompt.
- Assistant name and execution status stay together instead of occupying opposite ends of the panel.
- Adjacent plans and tools share one **operation record**. Completed operations collapse into a 26px row; running, failed and missing-receipt operations open automatically. Users can expand the record and individual tool payloads with the keyboard or pointer.
- Grouping never moves operations across messages, screenshots or notices. The original event timeline stays authoritative; this is a presentation projection.
- Intermediate scene captures become 58px thumbnail rows with full-size lightbox access; final result previews remain large. This prevents repeated visual receipts from pushing the actual reply offscreen.
- A compact welcome heading and flat suggestion rows replace the larger emblem and separate prompt cards.
- Reading text remains 14px with 21px line height. Turn spacing is 10px and user-to-assistant spacing is 9px. Buttons retain usable targets and focus styling.

`ActivityGroup.tsx` owns operational rows and disclosure state; `groupActivity` in `timeline.ts` groups adjacent operational blocks without mutating input. `RunView.tsx` retains message and visual-result rendering. No new runtime dependency was added.

## Screenshot acceptance

Assistant detail captures now use the actual default **400px panel width**, rather than the earlier 600px documentation setting. Dark/light themes, expanded operation details, long content and narrow 375px windows are checked in Chromium. README images must identify their source revision and distinguish actual Blender desktops from protocol-fixture UI captures.

## Verification

- 128 Node tests, including order preservation and finished/running/failed/missing-receipt activity disclosure.
- 16 Python deployment tests; TypeScript and production build.
- 23 browser conversation checks, 18 interface checks and 18 skills checks, with no uncaught browser errors. These suites use a real Fastify application and PostgreSQL WASM over TCP with explicit Runner/model fixtures.
- Details and machine-readable reports: `docs/validation/compact-chat.json`, `compact-interface.json` and `compact-skills.json`.

The native run also passed with **real Blender 4.0.2, mcp-for-blender and the native Codex app-server**: mesh mutation, automatic screenshots, GLB/glTF/blend export, snapshots, reusable asset hierarchy and packed textures, library browser interactions, skills, thread resume, cancellation, authenticated VNC and sidebar continuity. Its model responses were deterministic local fixtures, not live inference. See `docs/validation/compact-native.json`.

Both README hero images are freshly captured from this current frontend and real Blender desktop. The capture waits for a painted VNC framebuffer and shows the successful creative turn. Source images retain their original pixels and dimensions; no Blender view is composited into another screenshot. The existing production bundle-size advisory remains.
