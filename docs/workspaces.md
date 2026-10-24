# 项目工作区与界面参考

## 创作流程

左侧项目空间列出所有项目，顶部标签保留打开的项目。中央显示当前项目的真实 Blender。右侧助手只显示该项目选中的会话；草稿、素材引用和会话选择按项目保存在浏览器本地。收起助手不会断开桌面或停止任务。

共享素材库独立于项目：先选择人物、道具和场景部件，再在当前项目组合与创作，最后把组合保存回库。项目资源库继续存放本项目上传文件。两个项目可同时开着，分别拥有 Blender 进程与 Codex 原生会话；并发数量由服务器配置约束。

## VoiceStudio 参考依据

本轮对照 [VoiceStudio](https://github.com/debpalash/VoiceStudio) commit [`80a01e5`](https://github.com/debpalash/VoiceStudio/tree/80a01e595b5ae060e47fdeaa128d21f3a38de0df) 的真实 README 界面截图与 Electron 源码，重点查看：

- 当前 README 的 `voice-cloning.png` 截图：紫黑主画布、深色侧栏、玫红主要操作、底部圆角输入区。
- `electron/src/renderer/src/styles/globals.css`：14px 界面正文、13px 标签、12px 辅助信息、52px 标题栏。
- `electron/src/renderer/src/styles/t3-palettes.ts`：Original / `signal` 主题的紫色表面层次。
- `electron/src/renderer/src/styles/tauri-palette.ts`：Classic / `heritage` 的配套浅色主题。
- 工作区 `workspace-sidebar.tsx`、`top-bar.tsx`、`app-shell.tsx` 与 `status-bar.tsx`：可收起导航、细分隔线、分区标题和独立状态区。

Blender Pilot 的深色视觉以该 README 截图为目标：主画布约 `#211a25`、侧栏 `#1a131c`、主要按钮 `#a3004c`。链接和键盘焦点采用当前源码较亮的玫瑰色 `#f09bb8`，保证深色背景上可读；绿色、琥珀色和红色分别表示正常、待处理和异常，不与品牌主色混用。浅色采用 Classic 源码的浅紫表面与 `#8f3f71` 操作色。项目、素材、模板、对话、设置和控制台共用这些 CSS 变量。

这是一套针对 Blender 工作台的实现，不是 VoiceStudio 的完整克隆。参考项目支持多套主题，当前默认的中性蓝色主题、Original 当前源码的浅玫瑰按钮与 README 截图的深玫红按钮也存在差异；这里明确选择截图的可见风格，不把截图当成默认主题或宣称逐像素一致。保留 Blender Pilot 的中央原生 Blender、右侧可收起助手与项目标签：左栏 255px / 收起 48px，顶栏 52px，项目标签 38px，小屏自适应收缩。Blender 原生画面保持自身主题。

## 并发边界

同一项目只允许一个活动 AI 任务；其他项目可以同时执行。任务运行期间该项目网页视口只读，切换项目不改变任务目标。关闭项目需先停止其任务，未执行任务的项目关闭时保存场景。

当前是一个可信操作者的工作台。不同项目隔离场景状态、会话和执行目标，但运行在同一容器、共享全局库和文件系统，不能作为不可信用户之间的安全边界。
