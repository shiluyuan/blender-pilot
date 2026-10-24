# 对话、协议与附件

Blender Pilot 的聊天使用 Codex 原生 app-server JSON-RPC，经过版本化应用事件与 SSE 连接到浏览器。MCP 负责 Blender 工具，应用负责会话归属、投递回执、事件持久化和聊天展示。没有解析终端输出，也不需要再启动一层 ACP 服务。

## 实现参考

本轮直接阅读了以下项目的源码；采用其协议与交互设计原则，组件由本项目实现：

| 项目                                                                                                            | 参考版本   | 采用的设计                                                       |
| --------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------- |
| [Loom](https://github.com/shiluyuan/loom/tree/5c6b5ca94f296ba058555d7c5c8a8827ceeaa016)                         | `5c6b5ca`  | Codex 原生会话、投递幂等、事件游标和恢复重放                     |
| [AionUi](https://github.com/iOfficeAI/AionUi/tree/11cd2a9a20d1e033157636efc570b41384c66d85)                     | `11cd2a9`  | 独立输入组件、中文输入法、按会话草稿与上传状态、消息归并         |
| [ComfyUI MCP Panel](https://github.com/artokun/comfyui-mcp-panel/tree/cbadda173d3dd9e75ec53da395bb18e85de00f40) | `cbadda17` | 发送时固定会话归属、保留工具前后消息顺序、用户滚动意图与上传错误 |

Loom 的现有 Chat 不包含文件上传；AionUi 的通用文件接受逻辑也不代替格式验证。本项目独立实现文档校验及正文传递，并继续保持每个 Blender 项目的会话隔离。

## 协议分层

1. 浏览器发送 `clientRequestId + text + assetIds + libraryAssetIds`，在确认收到回执前保留原请求编号和完整附件快照。
2. API 在 PostgreSQL 中原子保存请求与 Run。同编号、相同内容返回原 Run；同编号不同内容返回 409。
3. Runner 使用项目独立的 Blender 实例和 Codex 会话。原生流程为 `initialize → thread/start|resume → turn/start`，取消使用 `turn/interrupt`。
4. 原生通知由 `normalizeCodexEvent` 转换为应用事件。事件落盘后通过 API 写入 PostgreSQL，再经 SSE 推送到浏览器。
5. 浏览器实时显示与刷新重放使用同一纯 reducer，按 `runId + seq` 去重，按 `itemId/callId` 更新原有内容块。

API 保存消息后立即返回排队回执，桌面准备在后台进行。Runner 会先保存排队事件，再启动 Blender；启动期间的取消会留下持久化标记，即使取消先于提交到达，迟到任务也不会执行。重启后不自动重放场景写入。不确定的日志写入失败明确返回 503；修复磁盘并重启后将未完成记录恢复为中断，不能把不存在的持久事件宣称为完成。

新事件信封包含 `schemaVersion: 1`、`projectId`、`sessionId`、`runId`、递增 `seq`、`type`、`payload`、`time`。旧事件缺少项目/会话字段时仍可重放；API 根据 Run 确定归属。

| 应用事件                           | 展示与语义                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `message.started/delta/completed`  | 按 itemId 归并；completed 正文是权威快照，不能当新增 delta 重复追加              |
| `plan.updated`                     | 更新原位置的计划和步骤状态                                                       |
| `tool.started/completed/failed`    | Blender 工具输入、结果与明确终态；未收到完成回执不能显示成功                     |
| `runtime.item.started/completed`   | 原生工具诊断；本地 Blender MCP 与桥接工具重复的卡片不重复展示                    |
| `capture.created` / `verification` | 保留当时顺序的真实截图和检查结论                                                 |
| `snapshot.created`                 | 当前项目的恢复点，支持下载与显式恢复；任务运行中禁止恢复，恢复前保留当前场景备份 |
| `scene.receipt`                    | 按 callId 附加到工具卡片的有限对象变化；后续失败不会抹去已经发生的变化           |
| `artifact.created`                 | 可下载的场景或模型产物                                                           |
| `attachment.context`               | 文档实际纳入上下文的字符数、截断及未纳入状态                                     |
| `usage`                            | 使用量快照，不能把多次快照重复累加                                               |
| `runtime.capabilities/notice`      | 内核能力、错误与不支持交互的明确说明                                             |
| `run.status`                       | 排队、执行、停止、成功、失败或中断                                               |

SSE 支持 `Last-Event-ID` 与 `after` 游标，服务端分页排空历史后才发送 `done`。原生适配器同时按 threadId/turnId 过滤历史重放，处理 `turn/start` 回执之前到达的事件，并等待异步事件消费者落盘后再报告完成。

## 输入与恢复

- Enter 发送，Shift+Enter 换行，中文输入法选词期间 Enter 不发送。
- 文件选择、拖拽、粘贴图片会直接成为当前会话引用，显示预览、上传进度、失败和重试。上传未完成时不能静默漏掉附件发送。
- 草稿、附件和待确认消息按 sessionId 保存。发送只清空当时提交的内容，随后输入的新草稿不受旧异步回调影响。
- 会话切换后，旧请求、上传和事件继续属于原会话。刷新通过请求回执查询恢复，重试复用原编号。
- 消息按实际顺序展示说明、工具、截图和结果。Markdown 支持代码块、复制、列表、链接和表格，不执行原始 HTML。
- 用户上翻历史时停止自动跟随；使用“回到最新消息”恢复跟随。
- 模板参数与素材校验后，在同一次草稿更新中追加文字和引用；使用最新草稿及已完成/待完成上传计数，统一执行 16,000 字符、12 项附件上限。项目/会话改变、超限或发送回执待确认时明确阻止套用。

工具耗时来自持久事件的开始/结束时间。连续三次同名同参数调用失败后，阻止再次重复但允许修正参数；超过 40 次调用会中断当前 Codex turn，任务标记 `interrupted` 并说明预算原因。MCP 初始化失败和关闭期间的握手会回收子进程；最终日志写入失败会撤销活动 token，存储错误继续阻止新任务。正在执行的阻塞 bpy 算子不保证立即抢占，取消会停止后续调用并等待场景队列释放。

`GET /api/sessions/:id/requests/:requestId` 返回 `{run: Run|null}`，用于核对不确定投递。任务历史保存附件名称、类型和引用 ID，用户可以回看原始参考。

## 文档附件

支持 `.md`、`.markdown`、`.txt`、`.json`、`.csv`。它们作为项目对话的参考资料，不作为三维共享素材导入 Blender。

- UTF-8 编码，每个文档最大 2 MiB；二进制控制字符及非法编码会被拒绝。
- 原始文件保存在本地目录，上传完成及发送前均校验；仅放开扩展名不算完成支持。
- 文档类型由不可编辑的原始文件路径确定，修改显示名不会丢失正文引用；文档不能通过资源“导入”或“入库”操作误当作三维素材。
- 每份文档最多纳入 20,000 个 UTF-16 字符，每轮文档总预算 60,000 个字符，保留完整原件；边界不会拆开代理对。
- 正文由 Runner 明确附加到 Codex 的文本输入中，并标明用户参考资料身份。超额截断及未纳入正文都有可见回执。
- JSON/CSV 作为文本参考，不承诺表格计算、PDF/OCR、DOCX 解析或网页外链抓取。

## 能力边界与验证

当前内核为 Codex。原生终端权限审批与 `requestUserInput` 表单尚未提供网页交互卡；执行端会明确拒绝并显示说明，模型应在普通对话中提问，用户下一轮补充。Blender MCP 工具、截图、素材与导出继续使用现有独立通道。

运行 `npm run check` 检查类型、应用/协议/数据库测试、部署参数和生产构建。执行 `npm run build && npm run verify:chat` 检查真实 Fastify、PostgreSQL 驱动和浏览器交互；其中 Runner 是明确标注的协议夹具，不证明模型理解或 Blender 几何正确。真实模型与 Blender 检查使用 `npm run verify:blender`，包括图片及只在 Markdown 中给出的组件参数，再独立回读场景核对。详细结果见 [验收记录](validation.md)。
