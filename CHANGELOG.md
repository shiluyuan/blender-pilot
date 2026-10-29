# Changelog

## 0.1.0 — Initial release

### Creative workspace
- Codex-powered project conversations, reference attachments, Blender MCP tools, screenshots, snapshots and exports.
- Shared asset library, portable ZIP asset packages, templates, and installable skills.
- Neutral light and dark workbench with system status and execution history.

### Native deployment
- Reuse an installed Blender executable on the same host as the backend.
- Linux embedded desktops and local Blender windows; macOS native-window path detection.
- Native dependency setup, PostgreSQL connectivity checks, persistent local credentials and supervised service shutdown.
- Existing Docker deployment retained; no automatic replacement of host Blender.

### Fixes
- Scene restoration now propagates corruption/read failures and commits active bindings only after successful loading and metadata persistence.
- Studio closing reserves its lifecycle before saving, rejects reopening, coalesces duplicate close requests and allows retry after a save failure.
- Native configuration uses atomic private writes; explicit missing Blender paths no longer silently select another executable.
- Project forms retain pending state on Escape and support inline failure/retry.
- Project rename UI, persisted through the existing API and reflected across project tabs and lists.
- Synchronous create-submit guard and PostgreSQL-backed request receipts to prevent duplicate projects on retry.
- A failed Blender activation no longer leaves a successful project creation form ready to create another project.

### Project
- Project metadata service/routes/forms and asset contracts now have explicit module boundaries; MCP discovery definitions are separated from job execution.
- Added lifecycle fault-injection tests, source import-boundary checks and expanded browser regression coverage; see docs/code-quality-review.md.
- English and Simplified Chinese READMEs, MIT license, contribution/security guidance and explicit platform limitations.

This changelog records source changes, not proof that every deployment platform has passed acceptance. See [validation](docs/release-0.1.0.md).
