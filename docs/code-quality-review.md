# Code quality review — 2026-10-29

This review covers module boundaries and failure behavior, rather than public-repository presentation. Changes preserve existing API routes and the initial 0.1.0 version.

## Findings fixed

| Finding                                                                      | Resulting behavior                                                                                                                                           | Regression evidence                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Scene recovery caught all errors and treated them as first startup           | Only absent metadata permits first startup; corrupt, unreadable or foreign-project state stops loading; a missing previously saved scene also stops recovery | Corrupt JSON, foreign project and invalid metadata-path tests; no Blender mutation                       |
| A failed scene load/metadata commit could leave an apparently usable binding | Clear binding before loading; publish the active project only after loading and metadata commit succeed                                                      | Failed restore and failed rename/commit injection; saving remains disabled and explicit retry succeeds   |
| A scene-file lookup swallowed errors                                         | Existing invalid scene paths fail instead of falling back to creating a new scene                                                                            | Directory in place of scene.blend does not send Blender commands                                         |
| Closing a ready studio yielded during save before reserving its lifecycle    | Mark closing before save; reject reopening; coalesce concurrent closes; retain a live instance if save fails                                                 | Delayed-save/reopen test, duplicate close test, failed save then retry                                   |
| Escape could close a native dialog even when its callback refused dismissal  | Modal cancel is controlled; project submit ownership remains synchronous                                                                                     | Browser submits twice, presses Escape while request is held, and confirms one request and an open dialog |
| Local configuration writes truncated the existing file                       | Write to a private temporary file, flush/fsync and atomically replace; clean temporary files on failure                                                      | Injected replacement failure preserves original credentials and owner-only mode                          |
| Invalid explicit Blender paths silently fell back to another executable      | An explicit choice fails clearly rather than using a different installation                                                                                  | Missing explicit path with another binary on PATH                                                        |
| Project and asset contracts were mixed into implementation modules           | Move shared schemas/types into contracts and project metadata into a dedicated service                                                                       | Existing API/asset suites plus source-level architecture guard                                           |

Atomic JSON writes also clean temporary files when writing or renaming fails. A project receipt whose target project is missing now returns a conflict instead of an empty success response.

## Module responsibilities

| Module                                | Responsibility                                                             |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `packages/contracts/projects.ts`      | Shared project input validation                                            |
| `packages/contracts/library.ts`       | Asset metadata schemas/types, independent of storage and Blender execution |
| `apps/server/projects.ts`             | Project metadata, durable creation receipts, rename persistence            |
| `apps/server/project-routes.ts`       | Typed HTTP binding for project metadata operations                         |
| `apps/web/projects/ProjectDialog.tsx` | Form state, pending guard, error display and retry                         |
| `apps/web/components/Modal.tsx`       | Controlled dialog dismissal                                                |
| `apps/runner/tool-definitions.ts`     | MCP discovery metadata, separate from run execution state                  |
| `apps/runner/pool.ts`                 | Blender process ownership and studio lifecycle                             |
| `packages/blender-bridge/scene.ts`    | Scene binding, persistence and Blender operations                          |

The library bridge retains exports for existing server consumers. The frontend and storage catalog now import types directly from contracts. A source-level import/export graph test includes type-only references, rejects cycles, and prevents frontend/storage imports of Blender execution implementation. Dynamic imports and third-party package internals are outside that guard.

## Executed verification

- **126 Node tests passed**, including seven additional lifecycle/architecture cases.
- **16 Python tests passed**, including three additional native-configuration/discovery cases.
- Typecheck, production build and whitespace checks passed.
- Project browser regression: duplicate submit, pending Escape, rename failure/retry, failed activation, rename, reload persistence and native-window UI.
- Chat browser regression rerun against the built app: delivery/replay, session isolation, attachment ownership, cancellation, history restoration, sidebar state and layout checks. See machine-readable reports for the exact list.
- Both browser suites reported zero uncaught application errors.

Reports: [summary](validation/code-quality-summary-0.1.0.json), [projects](validation/code-quality-projects-0.1.0.json), [chat](validation/code-quality-chat-0.1.0.json).

SQL coverage used the explicitly selected WASM-over-TCP test engine. Scene lifecycle tests inject failures at the Blender adapter boundary; browser runner responses are deterministic fixtures. These tests validate code behavior but do not constitute new real-model, real-Blender, physical macOS/Windows or native PostgreSQL acceptance.

## Remaining maintainability work

The API composition file, main workbench and run executor still contain substantial upload, view composition and workflow logic (approximately 1,600 / 1,784 / 980 lines). They are not fully decomposed. Future feature work should extract coherent responsibilities with regression coverage, especially uploads and run verification, rather than adding more unrelated behavior to those files. Broad file splitting solely to reduce line counts was deliberately avoided.

The existing browser bundle-size advisory remains. It is a performance improvement opportunity, not a failure of these checks. The recommendation remains an initial open-source preview, with the deployment limits stated in the README.

## Sidebar follow-up

The subsequent [sidebar review](sidebar-quality-review.md) extracts assistant presentation and width control, authentication/settings and shared view components, with typography and responsive interaction regression evidence.
