# 验证方法与记录

## 当前版本：聊天协议与输入（2026-10-24）

| 检查                  | 结果与范围                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| 应用、数据库与协议    | 40 项测试通过；原生事件隔离、启动前事件竞态、最终快照、幂等回执、1207 条事件恢复、文档正文、启动取消与日志故障 |
| 部署参数              | 7 项 Python 测试通过；本轮没有更改部署架构                                                                     |
| 浏览器                | 15 项通过，6 次独立任务（5 完成、1 主动取消）；真实 Fastify + PostgreSQL TCP，Runner 为明确标注的协议夹具      |
| 输入与附件            | 中文 IME、换行、自动引用、上传中切换会话、失败禁发、截断回执、稳定编号重试与新草稿保护                         |
| 恢复与展示            | 消息/工具顺序、Markdown/GFM、SSE 断线恢复、刷新后回执核对、停止后续聊、智能滚动                                |
| 布局                  | 1280px 窗口、340px 侧栏无横向溢出；长代码和宽表格只在块内滚动；收放保留消息/草稿/附件；CDP 核实实际字体        |
| TypeScript / 正式构建 | 通过；增加 Markdown/GFM 后主 JS bundle 约 741 kB，仍有大于 500 kB 提示                                         |

浏览器机器证据：[聊天交互验收](validation/chat-protocol-2026-10-24.json)。截图包含明确的协议夹具说明，不把预设回复称为模型推理。源码参考版本、事件合同与附件边界见 [对话协议](chat-protocol.md)。

完整原生回归通过：Blender 5.2.3 LTS、Codex 0.164.0、MCP 2.2.2、gpt-5.6-luna，6 次任务（5 完成、1 主动取消），13 张任务截图、19 次工具调用。浏览器真实模型对话、真实 VNC、素材分类/搜索/编辑/导入/引用/保存/刷新、截图引用、设置连接、快照恢复、导出与 1280px 布局均通过。

原生链路增加了 Markdown 独立检验：随机组件名称、坐标和尺寸只保存在上传文档中，对话不重复这些参数；模型执行后由控制器直接回读 Blender，证明正文实际送入了 Codex。真实模型结果与完整浏览器工作台回归在本轮独立记录中保存。

机器证据：[本轮汇总](validation/chat-core-2026-10-24.json) · [完整原生结果](validation/chat-native-2026-10-24.json)。Markdown 组件回读的位置为 `(1.75, -2.25, 0.65)`，尺寸为 `(0.6, 0.8, 1.3)`。本轮完整原生脚本最后以 `ALL NATIVE CHECKS PASSED` 结束，`reusedLiveChecks: false`。

验收中曾修正旧脚本对同步日志创建和单文件选择器的假设，并补齐本地 VNC 运行依赖。两套原生脚本并行曾触发 8 GiB 云端上限与一次 OOM；最终改为串行从空目录完整重跑。以上失败不计为通过，汇总保留原因。文档重命名后的正文传递，以及文档禁止误导入/入库，另由 API 和原生 JSON-RPC 输入夹具回归验证。

生产继续使用 PostgreSQL。此云端 SQL 检查使用显式 PostgreSQL WASM / TCP 模式，不能据此宣称原生 PostgreSQL 的并发性能、落盘持久性或 Docker 整机启动已经验证。日志写入故障采用明确错误和重启后中断恢复，不承诺磁盘故障期间自动继续执行。

## 前次版本：部署与 PostgreSQL（2026-10-23）

| 检查                     | 结果与范围                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| TypeScript / 生产构建    | 通过；主 JS bundle 仍有大于 500 kB 的构建提示                                                                               |
| 应用与数据库             | 15 项测试通过，含归属约束、每项目活动任务唯一性、幂等、事务回滚、旧数据迁移、上传失败恢复和就绪状态                         |
| 一键部署参数             | 7 项 Python 测试通过；参数校验、密码字面值、重复执行保留配置、外部数据库、稳定版/校验和、模型 Key 不入 dotenv、旧卷只读迁移 |
| 安装与配置               | 官方稳定版解析得到 Blender 5.2.3；下载包 SHA256 验证通过；npm ci 锁文件检查、Compose 内置/外部/GPU 配置与 shell 语法通过    |
| 最新 Blender / MCP       | 真实 Blender 5.2.3 GUI 与 MCP 2.2.2；双实例素材组合、贴图、独立副本、并发 Codex 协议、故障与关闭重开均通过                  |
| 服务恢复与启动检查       | 重启 Web 后登录、项目、素材、任务保留；一键脚本的真实 smoke 函数对运行中服务验证了数据库、场景、截图下载、保存              |
| 真实模型                 | gpt-5.6-luna：参考图片、颜色/位置独立核对、截图报告、多轮续聊、流式取消、取消后继续、浏览器对话通过                         |
| SQL / 驱动验证环境       | 云端使用 PostgreSQL 18.6 的 WASM 引擎，通过 TCP PostgreSQL 协议和 pg 驱动；显式 test-only 模式，不是部署后端                |
| Docker / 原生 PostgreSQL | **未完成整机验证**：云端无可运行 Docker daemon，用户切换/ptrace 等也受限；未伪造为 Docker 或原生 PG 并发持久性验收          |
| GPU / 大型场景           | 未测试                                                                                                                      |

机器证据：[本轮完整结果](validation/deployment-postgresql-2026-10-23.json)。代码和文档使用 `pg` 连接 PostgreSQL，生产配置不会回退到 PGlite。PGlite 仅保留作旧库离线迁移及明确选用的测试引擎。测试协议适配器按完整 SQL 查询周期串行化 WASM 后端，不能用于评估原生 PostgreSQL 并发吞吐或锁等待。

真实模型本轮从新测试目录完整执行，`reusedLiveChecks: false`。模型首次 Python 操作在视图设置中出错，但部分建模已执行；通过回读场景、后续修正和最新截图检查完成任务，没有自动重放不确定的写入。临时测试凭据已删除，提交内容不含 API Key。

部署入口是 `./docker-up.sh`。脚本默认执行真实服务 smoke，适合在实际标准 Linux 主机补齐 Docker / PostgreSQL 原生验收；模型推理需配置支持图片和工具的真实接口。开发测试默认连接临时 Docker PostgreSQL，或使用专用 `PILOT_TEST_DATABASE_URL`。只有受限云端检查显式设置 `PILOT_TEST_POSTGRES_MODE=wasm-wire`，不能把这个模式作为生产部署配置。

本轮截图均为实际 UI：工作区、素材库、控制台、资源、模型设置和快照已经更新到 README。下面保留早期版本验收记录，包含的旧 Blender 4.5 / PGlite 信息仅代表当时版本。

## 快速检查

```bash
npm ci
npm run check
```

覆盖严格 TypeScript 检查、PostgreSQL 驱动/API 测试、密码/密钥加密、路径与符号链接边界、上传偏移/恢复/去重、跨项目引用、重启持久化、变化回执以及正式构建。测试不会调用付费模型。

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

`.github/workflows/check.yml` 只允许手动触发；它的目标是在独立 Ubuntu runner 构建并启动 Compose，再使用 `scripts/verify-deployment.ts` 验证容器中的真实二进制。没有将其配置存在视为本轮执行通过。

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

| 检查                       | 结果             | 范围                                                                                                                             |
| -------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript、正式构建       | 通过             | Web、网关、Runner 与适配层                                                                                                       |
| 11 项自动化测试            | 通过             | 加密、鉴权、上传、项目隔离、持久化、SSE 续传、重启中断、结束竞态、MCP 图像内容、Codex 协议夹具                                   |
| Blender 4.5.4 + MCP 2.2.2  | 通过             | 真实 GUI、Python 修改、截图、RNA、GLB/glTF/blend 导出、快照恢复                                                                  |
| 浏览器端实际工作台         | 通过             | 登录、真实 VNC、侧栏保持连接、明暗主题、截图引用、上传/引用、设置测试、恢复、下载、刷新和 1280px 布局                            |
| Compose 与启动脚本         | 通过静态检查     | Compose v2.39.4 config、GPU override 合并、shell 语法；不是镜像启动验证                                                          |
| 原生 Codex 0.164.0 全链路  | **通过**         | 原生 app-server、MCP、真实 Blender、图像回传、会话续接、取消；素材库新增工具也已验证；最新协议测试含 19 处图像输入（含历史重发） |
| Docker 整机启动            | **未完成**       | 开发云端没有 Docker daemon；GitHub Actions 两个 job 都在任何 step 前失败，无可读取的 job 日志                                    |
| 用户模型真实推理与视觉链路 | **通过限定场景** | `gpt-5.6-luna` 真实接口；参考图颜色、材质/坐标独立核对、截图检查、续聊、取消与恢复、浏览器发消息                                 |
| NVIDIA / 大型生产场景      | **未测试**       | 无相应 GPU 与生产数据                                                                                                            |

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

## 可复用素材库验收（2026-10-23 UTC）

新增分类素材库使用同一套真实 Blender 4.5.4、MCP 2.2.2、Codex 0.164.0 与浏览器进行验收：

- 只保存选中的父子对象，不携带默认相机/灯光；源场景对象数据保持一致。
- 将文件贴图打包后删除原图片，再在新项目导入，验证贴图仍打包在素材内。
- 验证父子关系、对象坐标和材质；修改第一个副本后再次导入，核对网格和材质数据分别独立，原始变换仍可恢复。
- 保存并合并场景集合，验证新增对象数量；空选择明确拒绝。
- 通过原生 Codex 依次调用保存、搜索、预览、导入工具；模型端接收到真实图像，导入产生场景回执及当前截图。
- 浏览器验证分类、标签搜索、编辑、导入、对话引用、保存场景、刷新持久化、明暗主题以及 1280px 布局。
- 自动化 API 测试覆盖登录、上传资源入库、收藏更新不重置分类/标签、分类校验、文件鉴权、重启与符号链接限制。

新增工具的模型侧使用明确标识的 Responses 协议夹具，没有在本轮重跑付费模型推理。因此这证明工具执行与图像传输，并不证明任意自然语言素材检索或复杂人物资产质量。此前真实模型测试仍见上文。Docker 整机启动的验证缺口没有改变。

机器记录：[素材库原生验收](validation/asset-library-2026-10-23.json)。[深色界面](screenshots/library-dark.png) / [浅色界面](screenshots/library-light.png)。截图素材是验收用的合成立方体/球体，不是成品角色或道具。

开发中发现并修复了部分更新触发 Zod 默认值、重置标签的问题；编辑表单也增加明确的无障碍名称。最后从新建测试目录完整跑通，未复用先前模型或浏览器结果。截图禁用过渡动画，避免拍到主题切换的中间颜色。

## 多项目与外部素材组合验收（2026-10-23 UTC）

本轮以两个**同时运行的 Blender 4.5.4 GUI 进程**、两个独立 Xvfb/VNC 桌面、上游 MCP 与原生 Codex app-server 验证：

- 同时打开两个项目，修改 A 的对象不出现在 B；实例满额时第三个项目明确拒绝，不关闭已有项目。
- 从 Khronos 官方 glTF 示例下载 BoxTextured GLB，直接上传到全局库，无项目归属；来源、作者和许可保留，完成上传重试不产生重复条目。
- 在两个项目分别导入外部 GLB；验证 256×256 纹理实际加载并打包，修改 A 的副本不影响 B。
- 将外部模型、复用的座椅和新建装饰组合，保存 4 对象集合。条目记录 2 个直接来源素材 ID；在 B 导入组合并验证对象数量和贴图。
- A 的 Codex 请求保持等待时，B 通过原生 Codex 工具导入对话中明确引用的组合素材，并完成场景修改与截图报告；核对会话输入、对象状态、项目锁和任务取消。运行中的 A 不允许被关闭。
- 浏览器测试项目标签、两个 VNC 桌面、每项目草稿/引用切换与刷新持久化、批量引用、直接上传、批量导入、助手收起展开、明暗主题及 1280px 布局。
- 保存并关闭 A 后，只释放 A 的进程；重新打开恢复对象数量，B 保持在线。
- 主动结束 A 的 Blender 进程后，A 独立标记失败；B 仍可读写，A 的故障实例可关闭释放。
- 浏览器验收等待实际非空 VNC 像素后截图，避免把“已连接但未收到首帧”当作可用视口。
- 原有完整原生链路回归通过：导入导出、快照恢复、MCP 图像、原生会话续接与取消、库搜索/编辑/保存及浏览器交互。

`npm run check` 通过：TypeScript 检查、**12 项测试**、生产构建。新增 API 测试检查无项目全局上传、来源保留、幂等完成及拒绝带外链依赖的 glTF。构建仍有主 bundle 超过 500 kB 的提示，不影响构建结果。

本轮模型侧使用确定性的 Responses 协议夹具，包含原生 Codex 运行和真实 Blender 操作，**没有重新调用付费模型做自然语言创作评估**。外部 GLB 与组合链路是真实文件和进程验证。Docker 整机启动、NVIDIA、大型场景与复杂人物资产仍未完成验收。

结果：[多项目与组合链路记录](validation/workspaces-2026-10-23.json)。界面截图：[深色工作区](screenshots/workspaces-dark.png)、[浅色工作区](screenshots/workspaces-light.png)、[素材库](screenshots/library-dark.png)、[1280px](screenshots/workspaces-1280.png)。测试对象为合成与官方示例素材，不代表生成品质。

复现需要先安装文档中固定版本的 Blender、MCP、Codex、Xvfb、openbox、x11vnc 和 Playwright 浏览器，并在一个进程环境内执行：

```bash
curl -fL https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/BoxTextured/glTF-Binary/BoxTextured.glb -o /tmp/pilot-BoxTextured.glb
export PILOT_EXTERNAL_TEST_GLB=/tmp/pilot-BoxTextured.glb
export PILOT_ADDON_PATH=/absolute/path/to/mcp-for-blender/bundled/addon.py
# Default is TCP X11 for restricted test hosts; normal Linux can use Unix X11.
export PILOT_X11_TCP=false
npm run build
npm run verify:workspaces
```

可用 `BLENDER_BIN`、`MCP_BIN`、`XVFB_BIN`、`OPENBOX_BIN`、`X11VNC_BIN`、`PILOT_BROWSER_BIN` 覆盖可执行文件路径。`PILOT_TEST_DATA` 应指向新的空测试目录；模型接口由脚本在 localhost 启动，无需真实 Key。Khronos BoxTextured 原始说明标注 Cesium / CC BY 4.0，并有 Cesium 商标说明；模型不随本仓库分发，使用前阅读其原始 README。
