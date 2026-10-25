# Blender Pilot

在浏览器里打开真正的 Blender，用对话组合素材、创作场景，并把成果存回共享素材库。

独立项目空间、可收起的 AI 侧栏、共享素材库、截图检查、快照和控制台。采用 **Codex CLI app-server + 自研 Blender Pilot MCP + mcp-for-blender**。前后端使用 TypeScript，Blender 场景操作使用 Python。

聊天按 **Loom、AionUi、ComfyUI MCP Panel** 的协议与交互设计重构：独立会话草稿、附件直接引用、Markdown 与代码块、按顺序展示工具和截图、稳定发送回执、断线续传和取消。详见 [对话协议与附件](docs/chat-protocol.md)。

**模板 → 素材 → 再创作**：内置 9 个创作配方（保留原有 6 个，并增加书桌、置物架与办公室布局），填写参数、绑定共享素材，保存为自己的模板，在不同项目重复使用。应用时追加到当前对话草稿，保留已有文字和附件，确认发送后才执行。对话直接展示恢复点、对象变化回执和工具耗时。详见 [创作模板](docs/templates.md) 与 [Blender Copilot 对照](docs/competitor-review.md)。

**技能与质量闭环**：技能中心支持上传 `SKILL.md`／ZIP 和固定版本 npx 安装，按项目选用并接入 Codex 原生技能。复杂任务可记录阶段与恢复点；结果包含结构检查、多角度画面、对象变更和保存状态。详见 [技能中心](docs/skills.md) 与 [创作阶段和质量检查](docs/quality-workflow.md)。

当前截图统一采用 voicestudio.sh 官网的中性黑灰／暖白风格。Blender 原生窗口保留自身主题。以下实拍来自真实 Blender、MCP 和 Codex 进程；模型响应是本地协议夹具，不代表真实模型作品。

![Blender 工作区](docs/screenshots/current/workbench-dark.png)

## 一条命令部署

支持 **Linux x86_64**。服务器无需预先安装 Blender、Node.js、Python 插件或 PostgreSQL；Blender 与应用依赖安装在 Docker 镜像内，数据库独立运行。宿主机需要 Bash、Python 3.9+、curl 和 Docker Engine / Compose v2。

```bash
git clone https://github.com/shiluyuan/blender-pilot.git
cd blender-pilot
./docker-up.sh
```

Ubuntu / Debian 尚未安装 Docker 时：

```bash
sudo ./docker-up.sh --install-docker
```

脚本会生成随机访问密码与内部密钥，准备本地存储目录，构建并启动三个服务：**Web、Blender Studio、PostgreSQL**。首次部署从 Blender 官方目录选择最新稳定版，取得官方 SHA256 并校验安装包；已保存的版本在再次执行时保留。默认数据库镜像固定为 PostgreSQL 18.6。

启动后自动验证 **PostgreSQL → 登录 → 启动 Blender → MCP 读取场景 → 截图下载 → 保存**，失败会以非零状态退出。首次进入会创建一个入门项目。默认打开 `http://服务器IP:8090`，使用终端打印的密码登录，在「模型设置」中填写接口和模型。

**最新通过 116 项 Node 检查、11 项部署脚本检查，并重跑技能界面与原生 Blender 完整链路。** 12 种模型格式和两种带依赖 ZIP 素材包的实际 Blender 验收见 [素材与配色验收](docs/asset-formats-and-theme.md)。此前的双项目与完整浏览器报告保留为历史记录。 公开仓库的真实 npx 安装也已通过。完整记录和当前截图见 [技能与创作质量验收](docs/skills-quality-acceptance.md)。Codex 联合测试使用本地模型协议夹具；真实模型能力单独验收，不混计。

本次以 [voicestudio.sh](https://voicestudio.sh/) 当前官网的黑灰、暖白为准，移除此前误选的紫色背景和强调色；README 只展示当前版本截图。之前的界面验收记录作为历史保留。

此前真实模型核心与模板子套件已通过；最终真实模型浏览器阶段因自动审批中断待补，没有计作通过。正式发布还需完成实际主机的 Docker / 原生 PostgreSQL 验收。

> 当前云端已完成的验证与限制详见 [验收记录](docs/validation.md)。生产配置使用 PostgreSQL；云端数据库检查使用明确标识的 PostgreSQL WASM / TCP 协议环境，Docker 整机启动与原生 PostgreSQL 18 尚未在此云端实测，不能将其称为 Docker 全量验收完成。

## 技能、模板与结果

![素材库](docs/screenshots/current/library-dark.png)

![模板中心](docs/screenshots/current/templates-dark.png)

在「技能中心」上传 `SKILL.md`／ZIP，或输入公开 GitHub 仓库通过 npx 安装，再选择用于当前项目。每轮固定技能内容与版本，技能资源通过 MCP 读取。

![技能中心](docs/screenshots/current/skills-dark.png)

![设置](docs/screenshots/current/settings.png)

![控制台](docs/screenshots/current/console-dark.png)

实际 Blender 三视角图及原生验收见 [报告](docs/skills-quality-acceptance.md)。目标服务器可运行新的 [Docker／PostgreSQL 验收命令](docs/deployment-acceptance.md)。

## 按参数配置

```bash
./docker-up.sh \
  --bind 0.0.0.0 --port 8090 \
  --data-dir /srv/blender-pilot/files \
  --database-dir /srv/blender-pilot/pgsql \
  --max-studios 2 \
  --blender-version latest
```

| 参数                          | 用途                                                           |
| ----------------------------- | -------------------------------------------------------------- |
| `--port` / `--bind`           | 网页端口与监听 IP，默认 `8090` / `0.0.0.0`                     |
| `--data-dir`                  | 模型、贴图、截图、导出、原生会话和运行日志目录，默认 `./data`  |
| `--database-dir`              | 内置 PostgreSQL 数据目录，默认 `./postgres-data`               |
| `--database-url`              | 使用已有 PostgreSQL，支持连接串中的 TLS 配置；不启动内置数据库 |
| `--blender-version latest`    | 显式更新到当前稳定版，也可指定 `5.2.3` 等准确版本              |
| `--max-studios`               | 同时打开的 Blender 实例数，默认 3，可设 1–16                   |
| `--password-file`             | 从本地文件读取工作台密码；也可使用 `--password`                |
| `--resolution`                | 桌面分辨率，例如 `1440x900x24`                                 |
| `--secure-cookie`             | 经 HTTPS 反向代理访问时启用                                    |
| `--gpu`                       | 启用 NVIDIA Compose 配置，宿主机需驱动与 Container Toolkit     |
| `--env-file`                  | 指定独立配置文件；默认仓库根目录 `.env`                        |
| `--configure-only`            | 只生成配置                                                     |
| `--no-build` / `--skip-smoke` | 复用现有镜像 / 显式跳过启动验证                                |

`./docker-up.sh --help` 查看完整参数。配置使用权限为 `0600` 的 `.env` 保存，重复执行保留已有密码、数据与固定版本。脚本不会执行 `.env` 中的 shell 代码。首次构建需要网络下载 Blender、npm、PyPI 和系统依赖。

已有 PostgreSQL：

```bash
./docker-up.sh \
  --database-url 'postgresql://pilot:your-password@postgres.internal:5432/blender_pilot?sslmode=require' \
  --data-dir /srv/blender-pilot/files
```

密钥也可在首次部署时配置，不写入 `.env`：

```bash
./docker-up.sh \
  --model-url 'https://your-provider.example/v1' \
  --model 'your-supported-model-id' \
  --api-key-file /secure/path/model-key.txt
```

模型接口需支持 **Responses API、流式响应、工具调用和图片输入**。填写服务商要求的 API 根地址，不追加 `/responses`。工作台会加密保存 Key；「测试连接」只验证协议连通，真实任务再验证视觉和工具能力。

配置完成后可检查正在运行的实例，宿主机无需 Node：

```bash
docker compose --env-file .env exec -T web node dist/server/apps/server/readiness.js
```

此命令使用独立临时登录，检查服务、数据库、执行端、模型配置和空间，保留已有模型配置、场景和其他登录。升级后旧 Cookie 需重新登录一次，已保存模型 Key 保留。

## 当前界面

以下图片全部来自本轮构建，使用同一套中性黑灰／暖白配色，没有混用旧主题。原生 Blender 保留它自己的配色；合成验收素材不代表最终作品质量。

![浅色工作区](docs/screenshots/current/workbench-light.png)

![素材库浅色](docs/screenshots/current/library-light.png)

![项目资源](docs/screenshots/current/assets.png)

## 创作与复用

1. 创建或打开一个项目，中央显示服务器上的原生 Blender，可键鼠操作；右侧助手支持收起、调宽和 `Alt+J` 切换。
2. 在对话输入区选择、拖拽或粘贴参考图，上传后自动成为当前消息附件。也可上传 Markdown、TXT、JSON、CSV 说明，正文会提供给 Codex；单文档最大 2 MiB，超出上下文预算会明确提示截断。
3. 在共享素材库选择人物、道具和场景部件，批量引用到当前项目，描述摆放与修改要求。
   常用组合可在「模板中心」保存成参数化配方，之后调整布局、配色与新增部件即可复用。
4. Codex 通过我们的 MCP 搜索素材、读取预览、导入独立副本并编写 bpy 脚本。每次场景修改后回读对象信息、自动截图，并要求模型检查当前截图。
5. 新对象与现有素材组合后保存回库，保留源素材关系，再到另一个项目复用。

每轮操作前保留 `.blend` 快照，可在聊天恢复点卡片下载或恢复；恢复前会再保存当前场景。失败工具仍保留已经回读的对象变化，便于判断是否产生了部分修改。连续 3 次相同参数失败会阻止再次重复，允许修正参数；超过 40 次工具调用会明确中断本轮，避免持续无效调用。已经进入 Blender 的阻塞算子不能保证立即抢占，取消期间仍会等待场景队列释放。

不同项目拥有独立 Blender 进程和原生 Codex 会话，可以同时执行；同一项目内操作串行。关闭项目会先保存再释放内存，活动任务需先停止。内存紧张时把 `--max-studios` 设为 1；同时打开多个大场景需要相应增加内存。

外部模型推荐 **含贴图 GLB** 或打包后的 `.blend`。支持来源、作者和许可记录，以及 Poly Haven、Blendkit、Fab 原站入口。多文件 ZIP 素材包可直接入库并保留相对依赖；支持类型和限制见 [格式说明](docs/asset-formats-and-theme.md)；不会自动购买、抓取外链依赖或把参考图转换为高精度三维角色。

## 数据与架构

- **PostgreSQL**：项目、会话、任务、事件、上传记录、素材元数据、配置、素材来源关系。采用版本化迁移、外键、索引、事务和项目内活动任务唯一约束。
- **本地文件**：`.blend`、模型、纹理、截图、快照、导出、Codex 原生会话与 Runner 恢复日志，保存在 `--data-dir`。
- **MCP**：自研 16 个工具封装素材库、场景操作、自动截图、阶段计划、质量报告与技能资源；底层调用固定版 `mcp-for-blender 2.2.2`，配套 addon 来自同一发行包。
- **运行内核**：Codex CLI 0.164.0 app-server；Claude 尚未接入。

数据库和本地目录必须一起备份。旧版 PGlite / JSON 元数据会在脚本检测到后离线导入 PostgreSQL；迁移在事务中完成，原始文件保留，非空目标数据库拒绝覆盖。详见 [数据库设计](docs/database.md) 与 [部署运维](docs/deployment.md)。

## 开发与验证

```bash
npm ci
npm run check
```

测试需要一个**可丢弃的 PostgreSQL 测试数据库**，可通过 `PILOT_TEST_DATABASE_URL` 提供；未提供时测试启动临时 Docker PostgreSQL。无需真实模型 Key 的协议测试不等于模型推理测试。

```bash
PILOT_TEST_DATABASE_URL='postgresql://postgres:test@127.0.0.1:5432/pilot_test' npm run check
npm run verify:workspaces
npm run verify:blender
npm run verify:chat
```

原生验收还需要 Blender / MCP / Xvfb / openbox / x11vnc 与 Playwright 浏览器，具体设置见 [验证文档](docs/validation.md)。Web 开发使用 `npm run dev`、`npm run runner`、`npm run web`；进程需要相同的 `DATABASE_URL`、`PILOT_DATA` 和内部 token。

## 文档与边界

[部署与升级](docs/deployment.md) · [对话协议与附件](docs/chat-protocol.md) · [数据库设计](docs/database.md) · [架构与维护](docs/architecture.md) · [素材库指南](docs/asset-library.md) · [项目与界面参考](docs/workspaces.md) · [使用边界](docs/product.md) · [实际验收记录](docs/validation.md) · [第三方说明](THIRD_PARTY_NOTICES.md)

面向单个可信操作者。Python 可访问执行容器与挂载数据，项目隔离用于避免误操作，不是多租户安全沙箱。当前不支持多人实时协作、资产回收站、完整世界/渲染设置素材预设、通用游戏编程或原生语音。大型场景、复杂绑定、模拟缓存和 NVIDIA 渲染需按实际资源继续验证。
