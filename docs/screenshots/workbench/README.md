# Current real Blender workbench

Captured on **2026-10-29** from application revision [`9b4f575`](https://github.com/shiluyuan/blender-pilot/commit/9b4f57598d0d7d036c1559666ee55da2314d9076). These are the two images used at the top of the English and Chinese README galleries.

- Actual **Blender 4.0.2**, mcp-for-blender 2.2.2 and native Codex app-server, viewed through the application's authenticated VNC connection.
- Current frontend and its default **400px** assistant. The screenshot starts at the successful creative turn: the reply and one result card are foregrounded; intermediate screenshots, restore points and historical failures remain available in the per-turn execution disclosure. Later negative acceptance cases can also be seen in the conversation.
- The local Responses fixture drives real tool calls and scene changes. It is **not live model inference**. PostgreSQL uses the explicitly selected WASM-over-TCP test engine, not a native database installation.
- The scene contains real created Blender objects. The browser waits for a painted framebuffer before capture. No UI or scene is composited, retouched or replaced.
- Full original 1600 × 1000 browser screenshots, converted to lossless WebP. [Manifest](manifest.json) records hashes and source paths. [Native acceptance report](../../validation/reply-native.json) records the passed checks.

## Reproduce

With Blender, the pinned MCP addon, Codex and the Linux desktop dependencies installed, run:

```bash
npm run build
# Use a fresh test directory; the native suite intentionally creates and saves scenes.
PILOT_TEST_DATA=.data/readme-native \
PILOT_RESOLUTION=1000x850x24 \
PILOT_BROWSER_BIN=/absolute/path/to/chromium \
npm run verify:blender

PILOT_NATIVE_CAPTURE_DATA=.data/readme-native \
PILOT_SCREENSHOT_REVISION="$(git rev-parse HEAD)" \
node --import tsx scripts/package-workbench-screenshots.ts
```

Set `BLENDER_BIN`, `MCP_BIN`, `PILOT_ADDON_PATH`, `XVFB_BIN`, `X11VNC_BIN` and the database configuration as appropriate for the host. The packaging command refuses a failed native acceptance report. No real API key is needed for this deterministic acceptance run.
