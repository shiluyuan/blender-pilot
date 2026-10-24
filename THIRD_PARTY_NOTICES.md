# Third-party notices

Blender Pilot integrates separately maintained components. Their licenses remain applicable; see each upstream distribution and installed package's license files.

| Component                                       | Pinned version / reference        | License / use                                                                                              |
| ----------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Blender                                         | 5.2.3 LTS (default; configurable) | GNU GPL; bundled official Linux executable; source: https://projects.blender.org/blender/blender           |
| mcp-for-blender                                 | 2.2.2                             | MIT; installed from PyPI, addon from the same Python distribution; https://github.com/ahujasid/blender-mcp |
| OpenAI Codex                                    | 0.164.0                           | Apache-2.0; native CLI/app-server; https://github.com/openai/codex                                         |
| noVNC                                           | 1.7.0                             | MPL-2.0; imported without source changes; https://github.com/novnc/noVNC                                   |
| React                                           | 19.3.1                            | MIT                                                                                                        |
| react-markdown                                  | 10.1.0                            | MIT; https://github.com/remarkjs/react-markdown                                                            |
| remark-gfm                                      | 4.0.1                             | MIT; https://github.com/remarkjs/remark-gfm                                                                |
| Fastify                                         | 5.12.7                            | MIT                                                                                                        |
| PostgreSQL                                      | 18.6 (default image)              | PostgreSQL License; https://www.postgresql.org                                                             |
| node-postgres                                   | pg 8.23.1                         | MIT; https://github.com/brianc/node-postgres                                                               |
| PGlite                                          | 0.5.11                            | Apache-2.0; legacy migration and explicitly selected test-only WASM engine; production uses PostgreSQL     |
| MCP TypeScript SDK                              | 1.32.1                            | MIT                                                                                                        |
| Lucide                                          | lucide-react 1.61.0               | ISC                                                                                                        |
| Xvfb, x11vnc, Openbox, Mesa and Ubuntu packages | Ubuntu 24.04 packages             | See /usr/share/doc/*/copyright inside the studio image                                                     |

The UI's compact workbench layout is inspired by https://github.com/debpalash/VoiceStudio (AGPL-3.0). No source code, screenshots, logos or other assets from that project are copied into this repository. The Blender sidebar architecture also considers https://github.com/XEonAX/blender-copilot as a reference; no source copied.

The chat protocol and interaction design also reference AionUi (Apache-2.0, https://github.com/iOfficeAI/AionUi), ComfyUI MCP Panel (MIT, https://github.com/artokun/comfyui-mcp-panel), and the user's Loom project (https://github.com/shiluyuan/loom). This is an independent implementation, not a source-code vendoring of these projects. Reviewed revisions and relevant design choices are documented in [chat-protocol.md](docs/chat-protocol.md).

This notice is not a license grant for Blender Pilot's own code. Select a project license before distributing it as an open-source project. When redistributing container images, satisfy all bundled components' attribution and source-availability obligations.

Workspace acceptance downloads (but does not redistribute) Khronos glTF-Sample-Assets `BoxTextured`, credited to Cesium under CC BY 4.0, with a separate Cesium logo trademark notice. See https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/BoxTextured. Visual reference source paths and commit are documented in [workspaces.md](docs/workspaces.md).

`@electric-sql/pglite-socket` 0.2.14 is a development-only SQL protocol test dependency (Apache-2.0). It is pruned from production images.
