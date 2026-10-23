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

## 首版验证记录

开发云端已完成：类型检查/生产构建、5 项自动化测试、Blender 4.5.4 GUI 与 MCP 2.2.2 的真实操作、截图、导出、快照恢复和 RNA 查询。

Codex 原生端到端与 Docker 镜像启动结果以本仓库后续提交的记录和 CI 检查为准。开发云端没有 Docker daemon，不能把原生运行结果称作 Docker 运行成功。

尚无用户模型密钥，未执行付费模型的真实推理或视觉质量验收。NVIDIA GPU、复杂人物、大型生产场景和长期稳定性尚未验证。
