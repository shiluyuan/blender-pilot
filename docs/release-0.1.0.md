# v0.1.0 validation and scope

Source verification date: 2026-10-29. This is the initial version, not a blanket production certification.

## Changes in this iteration

- Native host deployment using an existing Blender executable, a supervised local API/runner, PostgreSQL and pinned MCP/Codex dependencies.
- Linux embedded desktop and native-window display paths; macOS executable discovery; explicit WSL2 guidance rather than an unsupported native Windows claim.
- Project rename UI, synchronous submit guard, durable PostgreSQL create-request receipts, and independent handling of creation success versus activation failure.
- HTTP-origin-safe UUID generation shared by project creation and chat.
- English/Chinese project homepage, MIT license, changelog, contributor/security guidance.

## Executed checks

- TypeScript typecheck and production build passed. The existing Vite bundle-size advisory remains (~823 KB uncompressed main JS); it is not a build failure.
- Complete Node regression suite: **119 passed, zero failures**. This includes request replay after application restart, rename persistence, conflicting request rejection, HTTP-compatible UUID generation and native-window process ownership.
- Python deployment tests: 13 passed, including existing executable discovery with spaces and actionable missing-Blender errors.
- Native-window lifecycle fixture: starts only its owned Blender substitute process, preserves the instance handshake, coalesces duplicate opens, and reaps that process. This is process-control validation, not a real Blender render.
- Chromium + real Fastify/SQL-driver browser regression: double form submission sends one request; activation failure leaves one created project; rename updates the UI and survives refresh; native-window mode shows screenshot controls without attempting VNC. Zero uncaught browser errors. Runner responses are explicit fixtures.
- Shell syntax, native help delegation, Python compilation and whitespace checks passed.

## Boundaries

The SQL tests explicitly used PostgreSQL WASM over TCP in this restricted cloud environment. They do not replace native PostgreSQL concurrency or target-host acceptance. This iteration did not run a Docker daemon, physical Mac, Windows/WSL machine, real Blender executable or external model endpoint. Historical real Linux Blender checks are retained in earlier reports but are not presented as acceptance of the new launcher.

Before a production release claim, run `./local-up.sh --setup` and `--check` on each target OS, create/open two projects, rename/reload, import an asset, execute an authorized real-model task with screenshots, save/restart/reopen, and verify clean process teardown. For Docker deployments run the documented production acceptance procedure against the actual target.

The README gallery retains the neutral real application captures from the previous acceptance build. It does not claim to show this iteration's new controls. Browser fixture screenshots are diagnostic evidence, not promotional real-Blender renders.

## Reproduce

```bash
npm ci
PILOT_TEST_POSTGRES_MODE=wasm-wire npm run check
PILOT_TEST_POSTGRES_MODE=wasm-wire node --import tsx scripts/with-postgres.ts -- node --import tsx scripts/verify-project-ui.ts
./docker-up.sh --native --help
```

Install Playwright Chromium before the browser command (`npx playwright install chromium`); a custom Chromium executable can be supplied with `PILOT_BROWSER_BIN`. Use a native PostgreSQL URL instead of the WASM flag for target-host SQL validation. No model credentials are used by these fixture suites.
