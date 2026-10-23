# 架构与维护

## 边界

应用维护工作台体验和执行可靠性：用户会话、资源、事件、场景锁、截图预算、快照、状态展示。Codex 维护模型推理、原生会话和工具循环；上游 MCP 维护与 Blender 的命令通道。三个版本分别固定，升级不需要重写整个产品。

| 目录                        | 职责                                                      |
| --------------------------- | --------------------------------------------------------- |
| `apps/web`                  | React 工作台、资源库、设置与原生 noVNC 视口               |
| `apps/server`               | Fastify 网关、PostgreSQL 实体、鉴权、上传、SSE 与桌面代理 |
| `apps/runner`               | 每项目桌面池、任务调度、取消、截图/验证、持久日志         |
| `packages/runtime-adapters` | Codex app-server 协议转换；未来 Claude 独立接入           |
| `packages/blender-bridge`   | 上游 MCP client、供 Codex 使用的工具门面、场景生命周期    |
| `packages/storage`          | pg 连接池、版本化 PostgreSQL 表结构与素材目录             |
| `packages/contracts`        | 前后端事件、实体类型、路径和配置校验                      |
| `deploy`                    | 固定版本镜像、桌面启动、上游 addon 加载                   |

## 每项目实例池

`StudioPool` 按需分配独立 Xvfb、openbox、Blender、x11vnc 和 MCP client。display、Blender TCP 端口、VNC 端口按 slot 分开，均留在 studio 容器内。`/desktop?projectId=…` 经鉴权后路由到指定实例。Web 网关按资源所属项目排队，不同项目的启动或导入不会互相阻塞。

每个项目自己的 `Jobs` 保存活动任务与 token；只共享已持久化的任务索引和事件索引。MCP 请求通过本次运行的随机 token 路由，前端的活动 tab 不参与执行目标判断。会话目录继续按 sessionId 隔离。共享库保持不可变内容文件，组合对象的 `pilot_asset_id` 用于保存来源关系。

达到实例上限返回 409，不会自动驱逐正在工作的项目。关闭活动任务对应的实例被拒；正常关闭先保存，异常进程使本实例失败并中断其任务，其他实例保留。故障可在项目页关闭后重新打开。服务退出先停止任务并尝试保存。浏览器本地保存各项目的草稿、引用 ID 和选中会话；这些草稿不跨设备同步。

这属于单用户的执行目标隔离，不是 Python 安全沙箱或多租户隔离。一个项目的任意 Python 仍可访问同一容器的数据。实例健康由 `/health.studios` 单独报告；容器健康只表示 Runner API 可接受请求，不表示每个 Blender 已启动。

## 一个请求怎样完成

1. 网关验证项目、会话、资源归属和配置；同一 `clientRequestId` 只产生一个任务。
2. 请求记录先写数据库。Runner 以相同 runId 幂等接受任务，并取得该项目的场景写锁。
3. 切换或加载 `.blend`，保存操作前快照，取得基线截图。
4. 为会话启动原生 Codex app-server；新会话 `thread/start`，已有会话 `thread/resume`。密钥只通过子进程环境传递。Codex 文件沙箱使用 read-only，禁用 shell、其他 apps/plugins 和多 agent；场景写入由显式提供的 Blender MCP 工具执行。
5. 将用户消息、引用资源信息和真实图像输入送入 `turn/start`。Codex 通过 stdio MCP 门面调用 Runner，由项目对应的 Runner worker 串行调用该实例的上游 MCP。
6. 每次 Python 写入前后读取场景，产生有限范围的变化回执，并自动附上新截图。
7. 模型检查图像，用 `report_verification` 引用当前 captureId。截图版本过期会被拒绝。没有有效视觉结论不会变成「已完成」。
8. 保存场景与操作结果快照，释放锁。浏览器读取持久事件，断线后按序号续传。

Python 执行异常可能发生在部分修改之后，因此操作失败也会尝试回读、截图；不自动重复执行不确定是否完成的写入。恢复使用完整 `.blend` 快照，不冒充 Blender 跨文件、跨操作符的原子 Undo。

Codex 使用应用自己的 Blender 指令，不自动扫描项目说明文件和宿主机 Skills；隔离这些无关发现流程解决了开发云端的 `thread/start` 阻塞。保留 Codex 内置 Code Mode host，让使用 `exec` 编排 MCP 的模型正常调用工具；这不启用 shell，也不改变只读文件沙箱。MCP 仍只连接当前任务授权的 Blender 门面。

## 自动截图与视觉判断

截图来自 Blender MCP 的 `look`，经过 JPEG 尺寸/体积限制后保存到项目。MCP 工具结果直接包含 `image` 内容；基线/最终检查图通过 Codex `localImage` 进入模型上下文。前端展示截图不等于模型看到了截图，因此集成测试检查实际 Responses 请求中的图片内容。

默认每任务最多 8 张自动截图、40 次工具调用、最多 3 次最终检查 turn；每个 Codex turn 最多 15 分钟。达到预算时明确结束为需要检查。图片只是外观证据，不能证明拓扑、法线、UV 或物理正确；对象回执也只覆盖名称、类型、变换、尺寸、材质关联和顶点数。

原生 Codex 会话可能进行上下文压缩；预算限制当前任务新图像数量，不是跨会话总 token 上限。

## 事件与状态

`PilotEvent` 包含 `schemaVersion=1`、runId、递增 seq、type、payload 和 time。Runner 先写 NDJSON 与状态文件，网关在事务中同步到 PostgreSQL；前端只依赖应用事件，不依赖 Codex 的内部对象直接渲染。

主要事件：`run.status`、`session.bound`、`message.delta`、`message.completed`、`tool.started/completed/failed`、`scene.receipt`、`capture.created`、`verification`、`snapshot.created`、`artifact.created`。

任务状态：queued → running → succeeded / failed / interrupted；取消时 running → cancelling → cancelled。取消会调用 `turn/interrupt`，不能强行回滚已开始的 Blender Python。任务退出仍等待当前场景队列结束。

执行服务重启把遗留活动任务标记 interrupted，不自动重放。项目重新打开时加载该项目最近保存的场景；尚未保存的手动修改不能保证恢复。

## 数据布局

```text
/data/
  database/                  仅旧版迁移源，在线业务表位于 PostgreSQL
  config/vault.key            AES-GCM 主密钥，0600
  projects/<projectId>/
    scene.blend              当前保存场景
    runtime-scene.json       本项目场景绑定与 generation
    runtime/                Xvfb / Blender / VNC 进程日志
    assets/<assetId>/         原始资源与预览
    captures/                截图
    snapshots/               恢复文件
    exports/                 导出文件
  library/<assetId>/         全局素材内容文件与预览（元数据在 PostgreSQL）
  uploads/                   未完成分块上传
  runtime/<sessionId>/       Codex 原生会话与配置
  jobs/                      Runner 状态与 NDJSON
  scene.json                 仅旧版外置桌面验收兼容模式使用
```

备份 PostgreSQL 与整个文件目录。Codex 会话、模型输出及图片路径属于用户数据。不要上传到公开诊断日志。

## 跨项目素材

`AssetLibrary` 使用共享本地目录中的不可变内容文件和 PostgreSQL 元数据。新条目在文件、预览完成后提交数据库；列表、分类、标签与收藏查询数据库。Web 和 Runner 使用同一份素材目录，写入通过 SQL 事务与行锁保护。旧版 JSON 仅作迁移源，详见 [数据库设计](database.md)。

`SceneBridge.saveLibraryAsset` 使用 Blender 原生集合写入；`importLibraryAsset` append 独立集合。MCP 门面增加 search/get/save/import 四个库工具，运行时白名单同步登记。导入使用既有场景变化回执、自动截图和最终视觉验证。列表不加载模型内容，图片按需获取。详见 [素材库设计与限制](asset-library.md)。

## 安全和限制

访问密码、签名 HttpOnly cookie、同源校验、加密 key、鉴权 WS、资源归属、路径/符号链接检查和日志脱敏构成单用户工作台的基本保护。任意 Python 仍可访问执行容器和挂载的数据，不能用它隔离恶意租户。Web 与 studio 共享数据卷，也不是互不信任的安全域。

NoVNC 的只读是用户交互保护，不是恶意客户端隔离机制。只有一个可信操作者；避免同时从多个标签页手动修改同一场景。

## 升级流程

- Codex：只改固定包版本和 runtime adapter；重新生成官方 app-server 协议检查 `initialize/thread/turn`，运行原生续接、取消和工具图像测试。
- MCP：升级 Python lock，重取该版本随包 addon；检查 `look/execute_blender_code/get_scene_info`，运行真实场景操作和截图测试。不要替换一个组件而保留另一个旧版。
- Blender：一起改版本和 SHA256；验证 RNA、导入导出、截图、文件加载后的 addon 存活。
- UI：依赖应用事件，不追随上游协议字段直接改组件。

升级前停机备份，使用测试 volume 验证旧项目能加载。PostgreSQL 或 Blender 文件格式升级不承诺原地降级，回滚应使用升级前的整卷备份。
