# Blender Pilot

在浏览器里打开真正的 Blender，用对话组合素材、创作场景，并把成果存回共享素材库。

独立项目空间、可收起的 AI 侧栏、共享素材库、截图检查、快照和控制台。采用 **Codex CLI app-server + 自研 Blender Pilot MCP + mcp-for-blender**。前后端使用 TypeScript，Blender 场景操作使用 Python。

聊天按 **Loom、AionUi、ComfyUI MCP Panel** 的协议与交互设计重构：独立会话草稿、附件直接引用、Markdown 与代码块、按顺序展示工具和截图、稳定发送回执、断线续传和取消。详见 [对话协议与附件](docs/chat-protocol.md)。

![真实 Blender 多项目工作区](docs/screenshots/workspaces-dark.png)

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

**聊天重构检查：40 项应用/协议测试 + 7 项部署脚本测试、15 项浏览器交互验收及生产构建通过。真实模型已验证图片创作、Markdown 正文驱动建模、续聊与取消后继续；详细范围和当前结果见验收记录。**

> 当前云端已完成的验证与限制详见 [验收记录](docs/validation.md)。生产配置使用 PostgreSQL；云端数据库检查使用明确标识的 PostgreSQL WASM / TCP 协议环境，Docker 整机启动与原生 PostgreSQL 18 尚未在此云端实测，不能将其称为 Docker 全量验收完成。

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

## 实际界面

以下均为真实运行截图。演示对象是验收用合成素材与公开 GLB 示例，不代表成品角色或场景质量。部分截图来自显式数据库协议测试环境。

**聊天侧栏：输入、文档引用、计划、工具与 Markdown 回复。以下两张是明确标注的协议验收界面，用于展示交互，不代表真实模型生成。**

![聊天侧栏浅色](docs/screenshots/chat-light.png)
![聊天侧栏深色](docs/screenshots/chat-dark.png)

**真实 Blender 与真实模型：参考图与 Markdown 组件说明驱动的合成验收场景，右侧显示工具、截图检查和结构化回复。**

![真实模型与 Blender 聊天链路](docs/screenshots/chat-blender-live.png)

**共享素材库：分类、预览、多选引用、批量导入与外部素材上传。**

![素材库深色界面](docs/screenshots/library-dark.png)

**浅色工作区：每个项目独立 Blender、对话、草稿与引用。**

![浅色多项目工作区](docs/screenshots/workspaces-light.png)

**控制台：执行环境、PostgreSQL、模型版本与本地存储。**

![运行控制台](docs/screenshots/console.png)

<details>
<summary>更多截图：素材库浅色、资源、模型配置与快照</summary>

![素材库浅色](docs/screenshots/library-light.png)
![真实模型对话与场景修改](docs/screenshots/workbench-light.png)
![项目资源](docs/screenshots/assets.png)
![模型设置](docs/screenshots/settings.png)
![快照与恢复](docs/screenshots/snapshots.png)

</details>

## 创作与复用

1. 创建或打开一个项目，中央显示服务器上的原生 Blender，可键鼠操作；右侧助手支持收起、调宽和 `Alt+J` 切换。
2. 在对话输入区选择、拖拽或粘贴参考图，上传后自动成为当前消息附件。也可上传 Markdown、TXT、JSON、CSV 说明，正文会提供给 Codex；单文档最大 2 MiB，超出上下文预算会明确提示截断。
3. 在共享素材库选择人物、道具和场景部件，批量引用到当前项目，描述摆放与修改要求。
4. Codex 通过我们的 MCP 搜索素材、读取预览、导入独立副本并编写 bpy 脚本。每次场景修改后回读对象信息、自动截图，并要求模型检查当前截图。
5. 新对象与现有素材组合后保存回库，保留源素材关系，再到另一个项目复用。

不同项目拥有独立 Blender 进程和原生 Codex 会话，可以同时执行；同一项目内操作串行。关闭项目会先保存再释放内存，活动任务需先停止。内存紧张时把 `--max-studios` 设为 1；同时打开多个大场景需要相应增加内存。

外部模型推荐 **含贴图 GLB** 或打包后的 `.blend`。支持来源、作者和许可记录，以及 Poly Haven、Blendkit、Fab 原站入口。多文件 ZIP 素材包需要先整理并打包；不会自动购买、抓取外链依赖或把参考图转换为高精度三维角色。

## 数据与架构

- **PostgreSQL**：项目、会话、任务、事件、上传记录、素材元数据、配置、素材来源关系。采用版本化迁移、外键、索引、事务和项目内活动任务唯一约束。
- **本地文件**：`.blend`、模型、纹理、截图、快照、导出、Codex 原生会话与 Runner 恢复日志，保存在 `--data-dir`。
- **MCP**：自研 12 个工具封装素材库、场景操作、自动截图与视觉报告；底层调用固定版 `mcp-for-blender 2.2.2`，配套 addon 来自同一发行包。
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
