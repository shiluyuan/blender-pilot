<div align="center">

# Blender Pilot

**通过对话创造 Blender 场景，让素材、项目与创作过程掌握在自己手中。**

[![Version](https://img.shields.io/badge/version-0.1.0-242424)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-242424)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-full_stack-3178C6)](docs/architecture.md)

[English](README.md) · **简体中文**

[快速开始](#快速开始) · [界面展示](#界面展示) · [文档](#文档) · [参与贡献](CONTRIBUTING.md)

![真实 Blender 画布与右侧 AI 创作助手同屏](docs/screenshots/current/workbench-light.png)

**中央操作真实 Blender，右侧通过对话创作、观察与检查。**

</div>

Blender Pilot 是一个可自行部署的 Blender 创作工作台。通过右侧对话栏描述需求、上传参考图、引用素材，由 Codex 通过 MCP 操作 Blender。每个项目独立保存场景与对话，共享素材库让作品可以持续复用。

**v0.1.0 为初始预览版本。** 当前支持 Codex 内核，Claude 适配仍在计划中。部署选项与接口可能继续调整；实际验证范围见 [版本验收说明](docs/release-0.1.0.md)。

## 核心能力

- **对话创作**：流式回复、工具执行记录、中断与继续、参考图片和 Markdown 文件。
- **视觉反馈**：Blender 截图、多视角检查、保存与快照恢复。
- **可复用素材库**：上传自己的模型、人物、物品与场景，分类管理，跨项目引用与组合。
- **多项目工作**：独立 Blender 实例与对话，支持项目重命名；创建请求可安全重试。
- **直接利用本机 Blender**：本机后端、本机文件、本机 Blender，也保留 Docker 部署。
- **模板与技能**：参数化模板、技能文件上传和支持的公共 GitHub/npx 安装流程。

## 快速开始

### 已安装 Blender：原生部署

需要 **Node.js 22.12+ / 24 LTS、Python 3.12+、PostgreSQL 和 Blender**。无桌面的 Linux 还需要 Xvfb、Openbox、x11vnc。完整环境准备见 [原生部署指南](docs/native-deployment.md)。

```bash
git clone https://github.com/shiluyuan/blender-pilot.git
cd blender-pilot
export DATABASE_URL='postgresql://pilot:你的密码@127.0.0.1:5432/pilot'
./local-up.sh --setup
```

打开 **http://localhost:8090**，使用脚本输出的密码登录，在「设置」填写模型 Base URL、API Key 和模型名。首次 `--setup` 安装锁定版本的项目依赖并构建；后续直接运行 `./local-up.sh`。脚本会复用已有 Blender 可执行文件，不重新安装 Blender，也不会接管你其他未保存的 Blender 窗口。

```bash
# 指定已有 Blender
./local-up.sh --blender /path/to/blender

# Linux 服务器：网页内嵌 Blender 桌面
./local-up.sh --desktop embedded --host 0.0.0.0

# 笔记本：本机 Blender 窗口，网页对话与截图预览
./local-up.sh --desktop native-window

# 只检查依赖和数据库
./local-up.sh --check
```

默认只监听本机。远程访问使用 `--host 0.0.0.0` 并配置 HTTPS 反向代理。模型请求会发送到你配置的服务商。直接复用本机环境能减少安装和文件映射，但不保证渲染速度必然高于 Docker。

统一脚本也支持 `./docker-up.sh --native --setup`，同样直接使用本机 Blender。

### 没有安装 Blender：Docker 部署

适用于 Linux x86-64，自动构建独立 Blender 环境并启动 PostgreSQL、API 和执行服务：

```bash
./docker-up.sh
```

Ubuntu/Debian 尚未安装 Docker：

```bash
sudo ./docker-up.sh --install-docker
```

访问 **http://服务器IP:8090**。GPU、端口、备份和升级见 [Docker 部署文档](docs/deployment.md)。现有容器只包含 Linux x86-64 Blender，不应当作 Apple Silicon 原生镜像使用。

### 平台与显示方式

| 环境                        | 运行方式                   | 画面                             | 验证范围                                                  |
| --------------------------- | -------------------------- | -------------------------------- | --------------------------------------------------------- |
| Linux x86-64 服务器         | Docker / 原生              | 网页内嵌桌面                     | 已有真实 Linux Blender 测试；目标机器 Docker 验收仍需执行 |
| Linux 笔记本                | 原生                       | 本机窗口 / 内嵌桌面              | 新增启动器与实例生命周期回归                              |
| macOS Intel / Apple Silicon | 原生，使用对应架构 Blender | 本机窗口 + 网页截图              | 已实现，尚未进行实体 Mac 验收                             |
| Windows                     | WSL2 Linux 环境            | 内嵌桌面；具备 WSLg 时可本机窗口 | 尚未实体机验收；没有 Windows 原生启动器                   |

## 素材库

支持 `.blend`、`.glb/.gltf`、`.fbx`、`.obj`、`.stl/.ply`、`.usd/.usda/.usdc/.usdz`、`.abc`，以及 PNG、JPEG、WebP、EXR、HDR 图片。包含贴图、BIN、MTL 等依赖的素材可打包 ZIP 上传，保留目录结构。

ZIP 上限为压缩 100 MiB / 解压 512 MiB；`.blend` 素材以追加对象方式导入当前场景。不同格式的材质、骨骼和动画保真度取决于 Blender 导入器。[详细格式与限制 →](docs/asset-formats-and-theme.md)

## 界面展示

主图首先展示产品的核心：**真实 Blender 视口与右侧对话助手同屏**。工作台主图来自已记录的真实 Blender 联调；下方素材、项目、技能和侧栏细节图来自 2026-10-29 最新前端验收，使用明确的演示数据。两类图片分别标注来源，不将管理界面截图代替 Blender 创作体验。

### Blender + AI 创作助手

保留 Blender 的原生视口、对象树和编辑工具，在同一工作台中通过右侧助手提出需求、查看执行记录和场景截图。

![真实 Blender 深色工作台与对话助手](docs/screenshots/current/workbench-dark.png)

<details>
<summary>查看最新侧栏细节：深浅主题、文档引用、任务计划与窄屏布局</summary>

以下是当前侧栏的界面验收截图，消息使用本地协议夹具，用于展示排版与交互。

| 浅色助手                                                       | 深色助手                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------- |
| ![浅色侧栏及文档引用](docs/screenshots/latest/chat-light.webp) | ![深色侧栏及工具记录](docs/screenshots/latest/chat-dark.webp) |

<img src="docs/screenshots/latest/chat-narrow.webp" width="327" alt="375px 窗口中的侧栏、附件与发送入口" />

</details>

[截图来源与复现步骤](docs/screenshots/latest/README.md) · [最新界面截图清单](docs/screenshots/latest/manifest.json)

### 素材与模板

共享素材分类管理、跨项目引用，以及可配置的场景创作模板。

| 素材库 · 浅色                                                             | 模板中心 · 浅色                                                               |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| ![共享素材库、分类与导入入口](docs/screenshots/latest/library-light.webp) | ![模板参数、素材引用与任务预览](docs/screenshots/latest/templates-light.webp) |

<details>
<summary>查看深色素材库与模板中心</summary>

![深色素材库](docs/screenshots/latest/library-dark.webp)
![深色模板中心](docs/screenshots/latest/templates-dark.webp)

</details>

### 项目管理

每个项目独立保存场景与对话；列表中可以打开项目、修改名称。

| 多项目列表                                                           | 项目重命名                                                                   |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| ![项目列表与多项目导航](docs/screenshots/latest/projects-light.webp) | ![修改项目名称的实际弹窗](docs/screenshots/latest/project-rename-light.webp) |

### 技能中心

查看已安装技能、为项目选择技能，通过上传或 npx 安装入口扩展创作方法。

![技能详情、项目选择与安装入口](docs/screenshots/latest/skills-light.webp)

<details>
<summary>查看深色技能中心与 npx 安装配置</summary>

![深色技能中心](docs/screenshots/latest/skills-dark.webp)
![npx 安装表单，截图未执行公共包安装](docs/screenshots/latest/skills-install-light.webp)

</details>

### 模型配置与系统状态

| 自定义 URL、Key 与模型                                                   | 执行环境、存储与服务状态                                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| ![模型设置，不展示真实密钥](docs/screenshots/latest/settings-light.webp) | ![系统状态控制台，执行器为本地验收夹具](docs/screenshots/latest/console-dark.webp) |

## 技术架构

React + TypeScript 前端连接 Fastify API，独立 Runner 管理各项目 Blender 实例与 Codex app-server 会话。通过 MCP 连接 Blender，PostgreSQL 保存元数据，素材、场景、截图保存在本地文件系统。复用现有 Agent 内核与 MCP 生态，避免重新实现一套 Agent 核心。

## 开发与验证

```bash
npm ci
npm run check
```

测试使用 `PILOT_TEST_DATABASE_URL` 指向真实 PostgreSQL，或启动临时 Docker 数据库。受限环境可显式使用 `PILOT_TEST_POSTGRES_MODE=wasm-wire`，但这不代表原生 PostgreSQL 验收。真实 Blender、真实模型与 Docker 验收单独执行。[贡献指南 →](CONTRIBUTING.md)

## 文档

- [原生部署](docs/native-deployment.md) · [Docker 部署](docs/deployment.md) · [部署验收](docs/deployment-acceptance.md)
- [素材库](docs/asset-library.md) · [格式支持](docs/asset-formats-and-theme.md)
- [对话协议](docs/chat-protocol.md) · [技能](docs/skills.md) · [质量检查](docs/quality-workflow.md)
- [架构](docs/architecture.md) · [数据库](docs/database.md)
- [v0.1.0 验收](docs/release-0.1.0.md) · [更新日志](CHANGELOG.md) · [安全](SECURITY.md)

## 后续计划

实体 Mac / Windows-WSL 与目标 Docker 部署验收、更多 Agent 内核、大型素材库性能优化、更多可复现模板与技能示例。计划中的功能不代表已经交付。

## 开源许可与致谢

项目原创代码使用 **[MIT 开源许可证](LICENSE)**，允许使用、修改和分发。Blender、依赖组件、模型服务与上传素材分别保留自身许可与条款，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。

感谢 [Blender](https://www.blender.org/)、[Codex](https://github.com/openai/codex)、[Blender MCP](https://github.com/ahujasid/blender-mcp)、[noVNC](https://github.com/novnc/noVNC)。界面独立实现，视觉参考 [VoiceStudio](https://voicestudio.sh/)。
