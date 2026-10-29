<div align="center">

# Blender Pilot

**Turn a conversation into a Blender scene. Keep your assets, projects, and creative control.**

[![Version](https://img.shields.io/badge/version-0.1.0-242424)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-242424)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-full_stack-3178C6)](docs/architecture.md)
[![Blender + MCP](https://img.shields.io/badge/Blender-MCP-E87D0D)](THIRD_PARTY_NOTICES.md)

**English** · [简体中文](README.zh-CN.md)

[Quick start](#quick-start) · [Screenshots](#screenshots) · [Documentation](#documentation) · [Contributing](CONTRIBUTING.md)

![Real Blender viewport with the AI conversation sidebar](docs/screenshots/current/workbench-light.png)

**Your Blender scene in the center. Your AI copilot beside it.**

</div>

Blender Pilot is a self-hosted creative workspace built around **Blender, Codex, and MCP**. Describe what you want, attach references, reuse assets, and inspect the result. Each project keeps its own scene and conversations; a shared asset library connects your work.

**v0.1.0 is an early preview / initial release.** APIs and deployment options may evolve. The supported agent integration is Codex; Claude integration is planned. See [validation and limitations](docs/release-0.1.0.md) before deploying.

## Why Blender Pilot?

- **Create through conversation.** Stream responses, inspect tool activity, stop a task, and continue in the same project. Configure your model URL, API key, and model in Settings.
- **See what the agent sees.** Capture Blender views, attach reference images and Markdown documents, and request multi-view checks before saving.
- **Build an asset collection.** Upload your own models, organize reusable characters, props, and scenes, then bring them into another project.
- **Work across projects.** Open independent Blender instances with separate conversations. Rename projects without changing their files or history.
- **Keep the runtime local.** Use an existing Blender installation with the native launcher, or let Docker provision an isolated environment.
- **Extend your workflow.** Install skills from uploads or the supported public GitHub/npx installation flow; reuse parameterized scene templates.

## Quick start

### Option A — use Blender already installed on your machine

Blender, the backend, MCP, and project files run on the same host. The launcher reuses the Blender **executable** and starts a separate managed process for each project. It does not take over an unrelated open Blender window.

Prerequisites: **Node.js 22.12+ / 24 LTS, Python 3.12+, PostgreSQL, and Blender**. On headless Linux, also install Xvfb, Openbox, and x11vnc. See the [native deployment guide](docs/native-deployment.md) for database setup and platform details.

```bash
git clone https://github.com/shiluyuan/blender-pilot.git
cd blender-pilot
export DATABASE_URL='postgresql://pilot:YOUR_PASSWORD@127.0.0.1:5432/pilot'
./local-up.sh --setup
```

Open **http://localhost:8090**, sign in with the password printed by the launcher, then configure your model in **Settings**. The first setup installs pinned project dependencies; it does not reinstall Blender. Subsequent starts use `./local-up.sh`.

```bash
# Blender installed in a custom location (paths with spaces are supported)
./local-up.sh --blender /path/to/blender

# Headless Linux: interactive Blender inside the browser
./local-up.sh --desktop embedded --host 0.0.0.0

# Laptop: local Blender windows + conversation and screenshot previews in the browser
./local-up.sh --desktop native-window

# Check dependencies and database connectivity without starting services
./local-up.sh --check
```

The native launcher binds to localhost by default. To access a server remotely, use `--host 0.0.0.0` behind your HTTPS reverse proxy. Model calls still go to the provider you configure.

The unified entry point also accepts `./docker-up.sh --native --setup`.

### Option B — Docker on Linux x86-64

No host Blender installation is required. Docker builds an independent Blender runtime and starts PostgreSQL, the API, and the execution service.

```bash
./docker-up.sh
```

On supported Ubuntu/Debian hosts without Docker:

```bash
sudo ./docker-up.sh --install-docker
```

Open **http://SERVER_IP:8090**. The script prints the login credentials. See [deployment](docs/deployment.md) for GPU configuration, ports, backups, and upgrade options. The current Blender container is Linux x86-64; do not use it as an Apple Silicon native image.

### Platform support

| Environment                 | Deployment                         | Blender display                                | Validation status                                                                            |
| --------------------------- | ---------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Linux x86-64 server         | Docker or native                   | Embedded browser desktop                       | Existing native Blender integration coverage; Docker target-host acceptance remains required |
| Linux laptop, X11/XWayland  | Native                             | Local windows or embedded desktop              | New launcher and lifecycle regression coverage                                               |
| macOS Intel / Apple Silicon | Native, installed matching Blender | Local windows + browser screenshots            | Implemented; physical Mac acceptance pending                                                 |
| Windows                     | WSL2 Linux environment             | Embedded desktop; WSLg windows where available | Physical Windows acceptance pending; native Windows launcher not provided                    |

## Asset library

| Content                          | Accepted formats                                                       |
| -------------------------------- | ---------------------------------------------------------------------- |
| Blender projects / components    | `.blend`                                                               |
| Portable models                  | `.glb`, `.gltf`, `.fbx`, `.obj`, `.stl`, `.ply`                        |
| Scene interchange                | `.usd`, `.usda`, `.usdc`, `.usdz`, `.abc`                              |
| References / textures / lighting | `.png`, `.jpg`, `.jpeg`, `.webp`, `.exr`, `.hdr`                       |
| Models with local dependencies   | `.zip` with models, textures, buffers, and optional `pilot-asset.json` |

Importing a `.blend` library asset appends objects to the current scene. ZIP uploads preserve relative dependencies (up to 100 MiB compressed / 512 MiB expanded). Format support does not imply perfect material, rig, or animation conversion. [Format details and limitations →](docs/asset-formats-and-theme.md)

## Screenshots

The main images show the core product: **a real Blender viewport and the conversation sidebar in one workspace**. These workbench captures come from the recorded real-Blender integration run. Asset, project, skill and sidebar-detail captures below were refreshed from the current frontend on 2026-10-29 with explicit demo fixtures. Their provenance is distinguished rather than presenting management pages as the Blender experience.

### Blender + AI copilot

Keep Blender's native viewport, object tree and editing tools. Describe changes, inspect tool activity and review scene captures in the assistant beside your scene.

![Real Blender dark workbench and conversation sidebar](docs/screenshots/current/workbench-dark.png)

<details>
<summary>Inspect current sidebar details: both themes, document references, task plans and narrow layout</summary>

These current sidebar captures use local protocol fixtures to demonstrate typography and interaction.

| Light assistant                                                                    | Dark assistant                                                             |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| ![Light sidebar with document references](docs/screenshots/latest/chat-light.webp) | ![Dark sidebar with tool activity](docs/screenshots/latest/chat-dark.webp) |

<img src="docs/screenshots/latest/chat-narrow.webp" width="327" alt="Assistant, document reference and send control in a 375px window" />

</details>

[Capture provenance and reproduction](docs/screenshots/latest/README.md) · [Current UI capture manifest](docs/screenshots/latest/manifest.json)

### Assets and templates

Organize reusable assets, reference them across projects and configure creation recipes.

| Shared library · light                                                                     | Templates · light                                                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| ![Shared asset categories and import controls](docs/screenshots/latest/library-light.webp) | ![Template parameters, asset references and task preview](docs/screenshots/latest/templates-light.webp) |

<details>
<summary>View the dark asset library and templates</summary>

![Dark asset library](docs/screenshots/latest/library-dark.webp)
![Dark template center](docs/screenshots/latest/templates-dark.webp)

</details>

### Project management

Each project keeps its own scene and conversations. Open and rename projects directly from the list.

| Multiple projects                                                                         | Rename a project                                                                   |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| ![Project list and multi-project navigation](docs/screenshots/latest/projects-light.webp) | ![Actual project rename dialog](docs/screenshots/latest/project-rename-light.webp) |

### Skills

Inspect installed skills, select them per project and access upload or npx installation.

![Skill details, project selection and installation controls](docs/screenshots/latest/skills-light.webp)

<details>
<summary>View dark skills and the npx installation form</summary>

![Dark skills center](docs/screenshots/latest/skills-dark.webp)
![npx installation form; no public package installed for this capture](docs/screenshots/latest/skills-install-light.webp)

</details>

### Model configuration and system health

| Custom URL, key and model                                                                    | Execution, storage and service health                                                           |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| ![Model configuration without real credentials](docs/screenshots/latest/settings-light.webp) | ![System health console with a local runner fixture](docs/screenshots/latest/console-dark.webp) |

## Architecture

The React workbench talks to a Fastify API. A separate runner manages project-specific Blender processes and Codex app-server sessions. The MCP adapter connects the agent to Blender; PostgreSQL stores metadata, while scenes, assets, and captures remain on the local filesystem.

| Layer           | Technology                                         |
| --------------- | -------------------------------------------------- |
| UI              | React, TypeScript, Vite, noVNC                     |
| API / execution | Fastify, Codex app-server, MCP                     |
| 3D runtime      | Existing native Blender or isolated Docker Blender |
| Storage         | PostgreSQL metadata + local files                  |

The project wraps existing agent and Blender integrations rather than implementing a new agent core. [Architecture →](docs/architecture.md)

## Development

```bash
npm ci
npm run check
```

Tests use a real PostgreSQL URL (`PILOT_TEST_DATABASE_URL`) or an isolated Docker database. Restricted environments can explicitly select `PILOT_TEST_POSTGRES_MODE=wasm-wire`; that is a test substitute and is **not native PostgreSQL acceptance**. Native Blender and model checks are separate from unit/API tests. [Contributing and validation →](CONTRIBUTING.md)

## Documentation

- [Native deployment: reuse installed Blender](docs/native-deployment.md)
- [Docker deployment](docs/deployment.md) · [Production acceptance](docs/deployment-acceptance.md)
- [Asset library](docs/asset-library.md) · [Supported formats](docs/asset-formats-and-theme.md)
- [Chat protocol](docs/chat-protocol.md) · [Skills](docs/skills.md) · [Quality workflow](docs/quality-workflow.md)
- [Architecture](docs/architecture.md) · [Database](docs/database.md)
- [v0.1.0 validation](docs/release-0.1.0.md) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md)

## Roadmap

- Complete physical macOS / Windows-WSL and target Docker deployment acceptance.
- Extend agent adapters beyond Codex.
- Improve large asset collections and preview performance.
- Expand template and skill examples from reproducible workflows.

Roadmap items are plans, not shipped features. Bug reports should include reproduction steps and sanitized logs; see [contributing](CONTRIBUTING.md).

## License and acknowledgments

Blender Pilot's original code is released under the **[MIT License](LICENSE)**. Blender and other dependencies retain their own licenses; model services and uploaded assets have their own terms. [Third-party notices](THIRD_PARTY_NOTICES.md) list upstream components and design references.

Built with [Blender](https://www.blender.org/), [Codex](https://github.com/openai/codex), [Blender MCP](https://github.com/ahujasid/blender-mcp), and [noVNC](https://github.com/novnc/noVNC). The interface is independently implemented with visual inspiration from [VoiceStudio](https://voicestudio.sh/).
