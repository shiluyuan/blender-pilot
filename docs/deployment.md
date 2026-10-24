# 部署与运维

## 一键启动

Linux x86_64，建议从 8 GB RAM、15 GB 空闲磁盘起步。大型场景、贴图和多个 Blender 实例需更多资源。宿主机需要 Bash、Python 3.9+、curl；Blender、Node 和 MCP 安装在容器中。

```bash
./docker-up.sh
# Ubuntu / Debian 未安装 Docker：
sudo ./docker-up.sh --install-docker
```

脚本从官方目录解析稳定版 Blender，排除 alpha/beta/rc 名称，获取 SHA256；首次生成随机访问密码、内部 token 和数据库密码。数据默认存于仓库下 `data/` 与 `postgres-data/`。再次运行保留已有参数，只有显式传入的选项会覆盖对应设置；`--blender-version latest` 显式重新解析版本。

常用示例：

```bash
./docker-up.sh --port 8090 --bind 0.0.0.0 \
  --data-dir /srv/blender-pilot/files --database-dir /srv/blender-pilot/pgsql \
  --max-studios 2 --blender-version 5.2.3
```

普通用户须可使用 Docker；脚本可以复用已授权的免密 `sudo docker`。不会修改 Docker socket 权限。`--install-docker` 通过 Ubuntu/Debian 官方发行对应的 Docker apt 仓库安装，其他发行版自行安装 Docker。默认构建和健康等待后，还会启动一个项目并验证真实 MCP 场景、截图文件和保存。

## PostgreSQL 与本地文件

默认服务：`web`、`studio`、`db`。PostgreSQL、Runner、MCP、X11 和 VNC 不发布宿主机端口；网页默认监听 `0.0.0.0:8090`。`db` 使用 `bundled-db` Compose profile；一键脚本自动选择。已有数据库可用 `--database-url`，不启用该 profile。

PostgreSQL 18 的本地目录挂载到 `/var/lib/postgresql`，使用该主版本的目录布局。不要直接把其他 PostgreSQL 主版本的数据目录作为 18 使用。连接串支持 `sslmode=require` 等 pg 驱动参数；外部数据库角色需能创建应用 schema。完整表结构见 [数据库设计](database.md)。

工作台文件目录挂载到 `/data`。初始化将此目录所有权设为 uid/gid 1000，实际 Web 与场景任务以非 root 运行；不要把系统目录或其他项目数据作为 `--data-dir`。默认没有自动删除项目、素材或快照的保留策略。

## 模型配置

网页「模型设置」输入 Base URL、API Key、模型 ID。模型必须支持 Responses、SSE、工具和图片。也可在一键脚本中同时提供 `--model-url`、`--model`、`--api-key-file`；Key 从文件读入后通过本机 API 加密保存，不存 `.env`。Key 的任意前缀都可使用。

接口 URL 不加 `/responses`，是否包含 `/v1` 取决于提供方。容器中的 localhost 指向容器自身；访问宿主机模型网关时使用可路由地址，或自行配置 `host.docker.internal:host-gateway`。

## HTTPS 与访问

通过域名访问时使用现有 Caddy/Nginx 反向代理，然后：

```bash
./docker-up.sh --bind 127.0.0.1 --secure-cookie
```

代理保留 Host，支持 `/desktop` WebSocket；`/api/` 关闭 SSE 缓冲，允许长连接，API 超时大于 180 秒。分块上传 4 MiB，代理单请求限制至少 5 MiB。HTTP 直连保留 `--no-secure-cookie`；默认访问密码由脚本生成。

浏览器登录由 PostgreSQL 保存令牌哈希。退出只撤销当前登录；正在打开的 SSE 与桌面连接会关闭。登录过期后页面要求重新登录，保留本地草稿、附件和待确认消息，继续核对原发送编号。升级到迁移 v3 后旧 Cookie 需重新登录一次，vault 加密密钥和已保存模型 Key 不变。

## 检查已部署实例

配置模型后，在已有容器中执行：

```bash
docker compose --env-file .env exec -T web \
  node dist/server/apps/server/readiness.js
```

检查服务就绪、独立登录、PostgreSQL 连接、Runner、故障实例、可用空间和模型配置。命令使用独立临时登录，结束时只退出该登录，不改写模型配置或场景；宿主机无需安装 Node。可用 `--url https://your-host.example` 检查反向代理地址，`--min-free-gb 2` 调整空间阈值。

开发环境可执行 `PILOT_PASSWORD_FILE=/secure/password.txt npm run verify:readiness -- --url https://your-host.example --output .data/readiness.json`。输出仅包含过滤后的健康信息，没有模型 Key、登录 Cookie 或密码。健康通过表示实例基础服务可用；模型视觉、建模和导出能力继续通过真实任务验收。

`npm run test:e2e` 会切换为协议夹具并创建场景，只允许明确指定的可丢弃测试实例。须设置 `PILOT_TEST_DISPOSABLE=1`；检测到活动或排队任务时，会在改写模型配置前退出。正常部署实例使用上面的健康检查。

## 并发与 GPU

每个打开的项目拥有独立 Blender / Xvfb / VNC，切换标签不释放内存。`--max-studios` 默认 3，上限 16 是并发控制，不是内存保障；8 GB 主机可从 1 个实例起步。关闭项目会保存并释放进程，运行中的任务先停止。

`--gpu` 使用 NVIDIA Compose 配置，宿主机需驱动与 Container Toolkit。此配置透传计算设备，不自动完成 Blender Preferences 的 Cycles / CUDA / OptiX 配置。默认远程视口使用 Xvfb / Mesa，没有宣称经过 NVIDIA 远程桌面加速验收。

## 备份与恢复

先结束任务、保存场景，停止 Web / Studio 后备份。示例使用内置数据库及 `/srv/blender-pilot/files`：

```bash
mkdir -p backups
docker compose --env-file .env --profile bundled-db stop web studio
docker compose --env-file .env --profile bundled-db exec -T db \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > backups/database.dump
tar -czf backups/files.tar.gz -C /srv/blender-pilot/files .
docker compose --env-file .env --profile bundled-db start studio web
```

恢复到空数据库时使用 `pg_restore`，恢复整个文件目录及 vault 主密钥。冷备 PostgreSQL 原始目录时应停止 db。备份含模型配置和原生会话，按敏感数据保护。`docker compose down` 不会删除这两个绑定目录；不要手工清空它们。

## 升级与迁移

结束任务并备份后 `git pull --ff-only`，重新执行 `./docker-up.sh`。旧 PGlite / 素材 JSON 会被检测并离线导入；目标数据库有数据时拒绝覆盖，原始库和资源文件保留。默认旧命名卷会先复制到空本地目录，自定义卷可传 `--legacy-volume`，源卷保留；迁移方法与约束见 [数据库文档](database.md)。

新 Blender 打开旧文件可能改变文件格式。回滚使用升级前的整套数据库/文件备份，不能承诺 Blender 或 PostgreSQL 跨大版本原地降级。

## 排障

| 现象               | 检查                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 一键脚本失败       | 看失败前命令；验证 `.env` 参数、磁盘、Docker daemon 和网络                                                         |
| 数据库未就绪       | `docker compose --env-file .env --profile bundled-db logs --tail=100 db web`；外部数据库检查 TLS、角色权限与连接串 |
| 发现旧 PGlite 数据 | 让一键脚本完成离线迁移；不要删除旧目录来跳过保护                                                                   |
| Blender 启动失败   | 查看 `<data-dir>/projects/<id>/runtime/`；项目页关闭故障实例后再开                                                 |
| 桌面端口已被占用   | Runner 单进程被强杀可能留下旧桌面；先结束其他任务并保存场景，再重启 `studio` 容器，重新打开项目                    |
| 视口断开           | 检查 WebSocket 代理，点击重新连接；只关闭有故障的项目                                                              |
| 模型能答但无法看图 | 检查 Responses 图片和工具能力；连接测试不能替代真实任务                                                            |
| 上传完成阶段失败   | 重新选择同一文件重试，服务器保留分块并恢复完成标记                                                                 |
| 外部素材没有贴图   | 优先使用含贴图 GLB 或打包后的 .blend；ZIP 和相对依赖未自动整理                                                     |

当前云端没有可运行的 Docker daemon，原生 PostgreSQL 所需用户操作也被环境禁止；云端 SQL/pg 驱动检查明确使用测试协议环境，不能代替标准主机的 Docker / PostgreSQL 验收。脚本的默认启动检查会在实际部署主机运行真实服务验证。

运行控制台按 10 秒检查，显示最近成功检查时间；网络失败后旧状态会标记过期。模型“已配置”只说明配置已保存，Codex/MCP 的构建版本也不代表本次实际运行验证。Blender 实例独立列出启动中、就绪、关闭中和失败状态。详细语义与场景见 [界面与系统状态验收](interface-acceptance.md)。

“项目桌面端口已被占用”时，程序不会终止不明进程或把遗留 MCP 当作新实例。完成其他项目的任务与保存后，可执行 `docker compose --env-file .env restart studio`；该操作会重启所有项目的桌面，再从网页重新打开已保存项目。非 Docker 开发模式应由进程管理器完整清理自己创建的桌面进程后重启，不能只重启 Runner Node 进程并依赖旧桌面。
