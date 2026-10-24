# 目标服务器部署验收

`docker-up.sh` 仍然是安装入口：它安装容器内 Blender、配置 PostgreSQL 和本地文件目录，启动服务，并检查登录、MCP、截图与保存。宿主机不必预先安装 Blender。

本轮补充了 `scripts/verify-production.ts`，用于在**实际部署的服务器**上留下可核对的 Docker、原生 PostgreSQL、共享文件和重启恢复证据。它不调用模型，不替换模型设置，也不会把“已配置模型”计为推理成功。

## 已有实例：默认只读检查

在安装目录执行（测试工具需要 `npm ci` 安装开发依赖；正常使用仍只需要部署脚本）：

```bash
npm ci
npm run verify:production -- --env-file .env --output artifacts/production-read-only.json
```

检查命令使用 `.env` 和 `docker-up.sh` 相同的 Compose 配置，包括外置 PostgreSQL、GPU 和 Docker 免密码 sudo 的选择。文件里的部署变量会覆盖当前终端遗留的同名变量，避免误连另一套配置。密码只在容器内用于独立的检查会话，报告不输出模型 Key、数据库连接串或登录 Cookie；会话在检查后退出。

默认模式会：

1. 连接实际 Linux Docker daemon，检查当前 Compose 项目的 `web`、`studio` 及启用时的 `db` 容器健康状态。
2. 在 Web 容器内连接 PostgreSQL，要求两个独立 backend PID，并验证一个连接持有的事务 advisory lock 会阻止另一连接获得同一把锁，回滚后锁可重新获得。WASM 或共享 backend 不能算通过。
3. 检查登录、API、Runner、数据库、故障实例、磁盘可用空间和检查会话退出。模型是否配置单独列出；尚未配置模型不会被误报为“推理通过”。

默认模式不重启服务、不创建素材或 Blender 场景、不创建持久 SQL 表，不修改模型设置。数据库连接和事务锁会关闭；认证使用的临时检查会话会退出。它验证当前安装状态，**不能证明镜像是在本次检查中新构建的**。

## 独立验收环境：首次安装及重启持久化

在独立测试服务器或独立部署目录中运行。为避免影响正常任务，使用专用数据目录和 `.env`；关闭接入此测试实例的其他客户端。不要对生产实例设置 `PILOT_TEST_DISPOSABLE=1`。

```bash
# 第一次部署会构建镜像并安装 Blender；参数说明见 docker-up.sh --help。
./docker-up.sh

# 在同一部署目录执行，明确允许重启这套可丢弃的测试实例。
PILOT_TEST_DISPOSABLE=1 npm run verify:production -- \
  --env-file .env \
  --restart \
  --output artifacts/production-restart.json
```

重启模式在以上检查通过后，检查 Runner 活跃任务、Gateway 排队任务和正在启动或关闭的项目。只有空闲实例才继续。它创建随机命名的独立 SQL schema 和本地 `.acceptance/<run-id>.json` 文件，验证 Web 与 Runner 能读到相同内容，然后在重启前再次检查任务为空。

随后重启应用容器；使用内置数据库时也重启 `db` 容器。等待所有容器健康，要求容器启动时间确实改变，再核对数据库和本地文件标记仍然存在、原生数据库与登录检查恢复。最后只清理本次生成的 SQL schema 和文件。清理失败会令整次验收失败，报告的 `observed.cleanupRequired` 给出精确的清理目标。

外置 PostgreSQL 不会由此命令重启，报告中的 `databaseServerRestart` 为 `false`。其数据库进程重启、备份恢复和存储可靠性应由数据库管理员在专用验收实例补测。

`docker-up.sh` 的首次构建日志与 JSON 报告应一起保留。`freshImageBuild` 始终为 `false`，因为后续健康检查不能替代构建日志；`modelInference` 始终为 `false`，真实模型对话、视觉反馈和浏览器交互另行验收。

## 报告与退出码

| 字段                         | 含义                                                              |
| ---------------------------- | ----------------------------------------------------------------- |
| `status: passed` / 退出码 0  | 本次所选模式的所有检查及清理通过                                  |
| `status: failed` / 退出码 1  | 已连接目标环境，但某个服务、原生数据库、恢复或清理检查失败        |
| `status: blocked` / 退出码 1 | 缺少 Docker、无法读取部署配置，或未为重启模式显式声明独立测试实例 |
| `exercised`                  | 本次确实执行的范围；未运行的项目保持 `false`                      |

JSON 报告文件以 `0600` 写入。外部命令失败时省略原始命令输出，避免 Compose 插值或驱动错误带出凭据；在目标服务器本地检查服务日志即可定位具体错误。

## 本轮云端结果

当前云端没有 Docker/Podman、Docker socket 或 PostgreSQL 二进制。进程虽显示 uid 0，但 capabilities 为 0；用户命名空间映射与切换非 root 用户均被运行环境拒绝。不能把安装依赖、Compose 配置解析或 PostgreSQL WASM 测试写成实际容器/原生 PostgreSQL 验收。

已实际执行新命令，[本轮报告](validation/production-host-blocked-2026-10-24.json)结果为 `blocked`，原因是 `Required executable is unavailable: docker`，所有 `exercised` 字段均为 `false`。新增 9 组编排测试通过，覆盖无授权不得重启、只读边界、WASM/共享 backend 拒绝、空闲检查、重启时间核对、外置数据库范围、标记清理、凭据不泄露及容器内脚本语法。还连接实际 PostgreSQL WASM-over-TCP 执行了负向检查，确认它被原生数据库证据检查拒绝。编排测试使用明确的命令 fixture，**不计入真实 Docker 或原生 PostgreSQL 通过数量**。

正式上线前，仍需在目标服务器执行上述验收，并补齐真实模型浏览器验收。当前文件完善了可重复执行的验收入口，没有把尚未发生的部署写成已完成。
