# 验证方法与记录

## 快速检查

```bash
npm ci
npm run check
```

覆盖严格 TypeScript 检查、真实 PGlite API 测试、密码/密钥加密、路径与符号链接边界、上传偏移/恢复/去重、跨项目引用、重启持久化、变化回执以及正式构建。测试不会调用付费模型。

## 真实 Blender 原生链路

在有桌面依赖的 Linux 环境安装固定版 Blender、MCP 和 Codex，然后：

```bash
npm run build
# 以下变量按实际安装路径填写
export BLENDER_BIN=/opt/blender/blender
export MCP_BIN=/opt/mcp/bin/mcp-for-blender
export PILOT_ADDON_PATH=/opt/pilot/addon.py
# 可选：明确指定 Playwright Chromium 可执行文件
# export PILOT_BROWSER_BIN=/path/to/chrome
npm run verify:blender
```

脚本自行启动 Xvfb、Blender、VNC、Runner、Web 与本地 Responses 协议夹具，使用 `.data/integration` 保存日志/测试文件。需要 `Xvfb`、`x11vnc`、OpenGL 软件驱动和可用的 Chromium。可用 `XVFB_BIN/X11VNC_BIN/OPENBOX_BIN` 指定路径；`PILOT_TEST_DISPLAY` 默认 `127.0.0.1:98`。

真实执行部分包括：读取场景、创建对象、截图解码、RNA 查询、GLB/内嵌 glTF/`.blend` 导出、快照恢复、原生 Codex app-server 与 MCP 通信、图片进入 Responses 输入、原生会话续接、停止任务、浏览器里的真实 Blender 桌面。

**协议夹具不是 AI 模型。** 它返回预定工具调用，报告文本明确标注测试身份。它能验证工具与图像传输，不能证明模型理解图片、建模质量或你的第三方接口兼容。

## Docker 集成检查

`.github/workflows/check.yml` 在独立 Ubuntu runner 构建并启动 Compose，再使用 `scripts/verify-deployment.ts` 验证容器中的真实二进制。结果截图和 JSON 作为 workflow artifact 保存。

本地已有测试部署可运行：

```bash
# 仅在测试实例运行，会创建项目并把模型配置切换到协议夹具
PILOT_PASSWORD=your-test-password npm run test:e2e
```

容器中的模型请求需要访问测试主机：设置 `PILOT_FIXTURE_BIND=0.0.0.0`、`PILOT_FIXTURE_HOST=host.docker.internal`，并给 studio 添加 `extra_hosts: ["host.docker.internal:host-gateway"]`。不要对正在使用的实例运行此测试。

## 首版验证记录（2026-10-23）

| 检查                      | 结果         | 范围                                                                                                       |
| ------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| TypeScript、正式构建      | 通过         | Web、网关、Runner 与适配层                                                                                 |
| 10 项自动化测试           | 通过         | 加密、鉴权、上传、项目隔离、持久化、SSE 续传、重启中断、结束竞态、MCP 图像内容、Codex 协议夹具             |
| Blender 4.5.4 + MCP 2.2.2 | 通过         | 真实 GUI、Python 修改、截图、RNA、GLB/glTF/blend 导出、快照恢复                                            |
| 浏览器端实际工作台        | 通过         | 登录、真实 VNC、侧栏保持连接、明暗主题、截图引用、上传/引用、设置测试、恢复、下载、刷新和 1280px 布局      |
| Compose 与启动脚本        | 通过静态检查 | Compose v2.39.4 config、GPU override 合并、shell 语法；不是镜像启动验证                                    |
| 原生 Codex 0.164.0 全链路 | **未通过**   | `initialize` 成功，`thread/start` 在 45 秒超时。独立空工具诊断也复现；尚未确定根因，不能归因于缺少用户 Key |
| Docker 整机启动           | **未完成**   | 开发云端没有 Docker daemon；GitHub Actions 两个 job 都在任何 step 前失败，无可读取的 job 日志              |
| 用户模型真实推理/视觉质量 | **未测试**   | 未提供真实模型 Key，协议夹具不能代替模型效果验收                                                           |
| NVIDIA / 大型生产场景     | **未测试**   | 无相应 GPU 与生产数据                                                                                      |

Actions 初次尝试：[Validate #1](https://github.com/shiluyuan/blender-pilot/actions/runs/39960711569)。不能将该状态称作 CI 通过；需要在可执行 Docker 作业的环境重新运行。

可独立排查原生 Codex 启动，不需要真实 Key、不执行模型推理：

```bash
npm run doctor:codex
```

只运行已验证的 Blender/桌面部分时，显式设置 `PILOT_SKIP_CODEX=true npm run verify:blender`。脚本会在结果中写入 `codex: not-tested`，不会冒充原生 Codex 验收成功。

实测截图：

- [深色工作台](screenshots/workbench-dark.png)
- [浅色工作台](screenshots/workbench-light.png)

下一步验收顺序：排除原生 Codex 启动超时 → 在标准 Docker Linux 主机运行 `test:e2e` → 配置真实多模态接口 → 完成一次有图片引用、场景修改、自动截图和视觉结论的真实任务。全部通过前，首版不标记为完整验收完成。
