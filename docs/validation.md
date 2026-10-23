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

## 真实模型验收

使用隔离的测试目录和一个私有 JSON 文件提供真实配置。配置文件不要提交到 Git；运行会产生真实 API 费用：

```bash
mkdir -p .data
umask 077
cat > .data/live-provider.json <<'JSON'
{
  "baseUrl": "https://your-provider.example",
  "apiKey": "replace-with-your-key",
  "model": "your-vision-model",
  "effort": "low"
}
JSON
PILOT_MODEL_CONFIG_FILE=.data/live-provider.json \
PILOT_TEST_DATA=.data/live-acceptance npm run verify:blender
```

桌面依赖、Blender/MCP 路径和浏览器路径与上面的原生验证一致。有出站代理的环境为 Node 添加 `NODE_USE_ENV_PROXY=1`，保留环境原有代理并将 localhost 放在 `NO_PROXY` 中。Base URL 是否包含 `/v1` 取决于服务商；不会自动添加它。

测试控制器生成左右两个色块，提示词**不提供颜色名称或数值**。模型需要查看上传的参考图，创建球体和立方体、设置材质和位置。随后测试控制器直接读取真实 Blender 材质和坐标验证结果，不只相信模型自报成功。后续覆盖原生进程重启后的续聊、实际流式输出中取消、取消后继续，以及浏览器输入框发送的真实对话。

输出位于测试目录的 `result.json`、`live-model-result.json`、截图与任务日志中。`PILOT_REUSE_LIVE_RESULT=true` 仅用于已通过模型阶段、需要重启服务补跑浏览器检查的情况；会核对持久任务与原生会话，且结果显式标记 `reusedLiveChecks`。它不会把失败的模型任务改成通过。

测试结束删除私有配置文件。测试数据中有加密的模型配置和解密主密钥，因此整个测试目录也应按敏感数据处理；只分享经过检查的报告与合成场景截图。

## 验证记录（2026-10-23 更新）

| 检查                       | 结果             | 范围                                                                                                          |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------- |
| TypeScript、正式构建       | 通过             | Web、网关、Runner 与适配层                                                                                    |
| 10 项自动化测试            | 通过             | 加密、鉴权、上传、项目隔离、持久化、SSE 续传、重启中断、结束竞态、MCP 图像内容、Codex 协议夹具                |
| Blender 4.5.4 + MCP 2.2.2  | 通过             | 真实 GUI、Python 修改、截图、RNA、GLB/glTF/blend 导出、快照恢复                                               |
| 浏览器端实际工作台         | 通过             | 登录、真实 VNC、侧栏保持连接、明暗主题、截图引用、上传/引用、设置测试、恢复、下载、刷新和 1280px 布局         |
| Compose 与启动脚本         | 通过静态检查     | Compose v2.39.4 config、GPU override 合并、shell 语法；不是镜像启动验证                                       |
| 原生 Codex 0.164.0 全链路  | **通过**         | 原生 app-server、MCP、真实 Blender、图像回传、会话续接、取消；Responses 请求体包含 6 处图像输入（含历史重发） |
| Docker 整机启动            | **未完成**       | 开发云端没有 Docker daemon；GitHub Actions 两个 job 都在任何 step 前失败，无可读取的 job 日志                 |
| 用户模型真实推理与视觉链路 | **通过限定场景** | `gpt-5.6-luna` 真实接口；参考图颜色、材质/坐标独立核对、截图检查、续聊、取消与恢复、浏览器发消息              |
| NVIDIA / 大型生产场景      | **未测试**       | 无相应 GPU 与生产数据                                                                                         |

Actions 初次尝试：[Validate #1](https://github.com/shiluyuan/blender-pilot/actions/runs/39960711569)。不能将该状态称作 CI 通过；需要在可执行 Docker 作业的环境重新运行。

真实模型使用用户授权的 `https://coding.smartpaipai.com` 根地址，不加 `/v1`。报告中的 5 个验收任务包含 4 个成功任务和 1 个主动取消任务，共产生 11 张任务截图、15 次 Blender 工具调用和 4 份当前截图检查报告。实际球体位置从 `(-3,0,1)` 变为 `(-3,0,2)`，蓝色立方体保持 `(3,0,1)`。测试只验证这些具体行为，不代表复杂人物、拓扑或大型场景质量已通过。

本次首先完成全部模型任务及浏览器对话；资源库检查因测试选择器没有区分两张图片而退出。修正选择器后重启服务，复用已经通过的模型任务记录，并重新完成浏览器对话、资源库、设置、恢复与导出检查。完整结果如实保留 `reusedLiveChecks: true`。

机器可读证据：[真实模型验收结果](validation/live-model-2026-10-23.json)。报告只有合成场景、运行 ID 和观察结论，不包含密钥。

## 本次解决的问题

- `thread/start` 阻塞：关闭不属于 Blender 工作台的项目说明文件与宿主机 Skills 自动发现后，原生启动诊断约 0.5 秒通过。未修改宿主机托管策略或降低只读文件沙箱。
- 模型能答但不能操作：恢复 Codex 内置 Code Mode host，使模型可以通过 `exec` 编排当前 Blender MCP 工具；shell 等无关工具仍关闭。
- 连接测试：使用 Responses 的数组输入、`store:false` 和流式完成事件，与实际 Codex 接口要求一致。
- 开发模式 MCP：使用绝对 `tsx` loader 地址，避免 Codex 在项目目录启动子进程时找不到 loader。
- 协议夹具支持 Codex 0.164 的 MCP namespace；真实测试继续负责模型图像理解和任务行为验收。

可独立排查原生 Codex 启动，不需要真实 Key、不执行模型推理：

```bash
npm run doctor:codex
```

只运行已验证的 Blender/桌面部分时，显式设置 `PILOT_SKIP_CODEX=true npm run verify:blender`。脚本会在结果中写入 `codex: not-tested`，不会冒充原生 Codex 验收成功。

实测截图：

- [深色工作台](screenshots/workbench-dark.png)
- [浅色工作台](screenshots/workbench-light.png)

剩余部署验收：在具备 Docker daemon 的标准 Linux 主机执行 Compose 构建与 `test:e2e`；NVIDIA 和大型生产场景另行验证。原生真实模型链路已通过，不能据此声称 Docker 镜像整机启动也已实测通过。
