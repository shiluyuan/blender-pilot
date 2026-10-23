# Third-party notices

Blender Pilot integrates separately maintained components. Their licenses remain applicable; see each upstream distribution and installed package's license files.

| Component                                       | Pinned version / reference         | License / use                                                                                                  |
| ----------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Blender                                         | 4.5.4 LTS                          | GNU GPL; bundled official Linux executable; source: https://projects.blender.org/blender/blender               |
| mcp-for-blender                                 | 2.2.2                              | MIT; installed from PyPI, addon from the same Python distribution; https://github.com/ahujasid/mcp-for-blender |
| OpenAI Codex                                    | 0.164.0                            | Apache-2.0; native CLI/app-server; https://github.com/openai/codex                                             |
| noVNC                                           | 1.7.0                              | MPL-2.0; imported without source changes; https://github.com/novnc/noVNC                                       |
| React                                           | 19.3.1                             | MIT                                                                                                            |
| Fastify                                         | 5.12.7                             | MIT                                                                                                            |
| PGlite                                          | 0.5.11                             | Apache-2.0, with PostgreSQL components under their own license                                                 |
| MCP TypeScript SDK                              | 1.32.1                             | MIT                                                                                                            |
| DM Sans                                         | @fontsource-variable/dm-sans 5.3.0 | SIL Open Font License; bundled locally                                                                         |
| Lucide                                          | lucide-react 1.61.0                | ISC                                                                                                            |
| Xvfb, x11vnc, Openbox, Mesa and Ubuntu packages | Ubuntu 24.04 packages              | See /usr/share/doc/*/copyright inside the studio image                                                         |

The UI's compact workbench layout is inspired by https://github.com/debpalash/VoiceStudio (AGPL-3.0). No source code, screenshots, logos or other assets from that project are copied into this repository. The Blender sidebar architecture also considers https://github.com/XEonAX/blender-copilot as a reference; no source copied.

This notice is not a license grant for Blender Pilot's own code. Select a project license before distributing it as an open-source project. When redistributing container images, satisfy all bundled components' attribution and source-availability obligations.
