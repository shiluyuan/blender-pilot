# Current UI screenshots

Captured on **2026-10-29** from application revision [`44e6af9`](https://github.com/shiluyuan/blender-pilot/commit/44e6af9a188ad8b3bbcbf2f6c28df1f6b3de90b8), which includes the sidebar typography and module refactor. This documentation update changes capture scripts and documentation only, not application behavior.

The English and Chinese READMEs lead with **two real-Blender workbench images** from `../current/` (the recorded earlier integration run). They supplement those with **14 current UI-detail images** from this directory. The two disconnected workbench captures in this directory remain diagnostic evidence and are not embedded in either README. The earlier real-Blender images are not claimed to contain the newest sidebar typography.

## Provenance

- Actual Chromium screenshots of the production frontend, served by the real Fastify application with persisted SQL data.
- Deterministic local fixtures for model messages, runner health and asset metadata. No real API key appears in the screenshots. No live model, real Blender process or public npx package installation is claimed by this gallery.
- Workbench images visibly retain the disconnected viewport. Library thumbnails retain the application's own fallback icons when the fixture has no real model preview. Neither is replaced with an invented render.
- Light/dark surfaces use the current neutral palette. Screenshots preserve original pixels and dimensions, encoded as **lossless WebP** for smaller repository downloads; no retouching or compositing.
- [manifest.json](manifest.json) records the application revision, source captures, test environments, dimensions, file sizes and SHA-256 hashes. Browser reports contain zero uncaught application errors.

## Reproduce

Install dependencies and a supported Playwright Chromium browser, then run from the repository root. The commands below use the explicitly selected WASM-over-TCP PostgreSQL test mode. For native PostgreSQL testing, omit that variable and configure `PILOT_TEST_DATABASE_URL` instead.

```bash
npm ci
npm run build
export PILOT_TEST_POSTGRES_MODE=wasm-wire
# Optional: point to an already installed Chromium executable.
# export PILOT_BROWSER_BIN=/absolute/path/to/chromium

PILOT_INTERFACE_CAPTURE_ONLY=1 \
PILOT_INTERFACE_TEST_DATA=.data/readme-interface npm run verify:interface
PILOT_SKILLS_TEST_DATA=.data/readme-skills npm run verify:skills
npm run verify:chat

PILOT_SCREENSHOT_REVISION="$(git rev-parse HEAD)" \
node --import tsx scripts/package-readme-screenshots.ts
```

The packaging script refuses failed source suites. It produces the same gallery filenames so a future UI change can refresh both READMEs together. Update this file's recorded application revision when refreshing the gallery, and review the images before committing them.
