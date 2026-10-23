# 项目工作区与界面参考

## 创作流程

左侧项目空间列出所有项目，顶部标签保留打开的项目。中央显示当前项目的真实 Blender。右侧助手只显示该项目选中的会话；草稿、素材引用和会话选择按项目保存在浏览器本地。收起助手不会断开桌面或停止任务。

共享素材库独立于项目：先选择人物、道具和场景部件，再在当前项目组合与创作，最后把组合保存回库。项目资源库继续存放本项目上传文件。两个项目可同时开着，分别拥有 Blender 进程与 Codex 原生会话；并发数量由服务器配置约束。

## VoiceStudio 参考依据

本轮实际读取了 [VoiceStudio](https://github.com/debpalash/VoiceStudio) 的源码，参考定位到 commit [`48e85106`](https://github.com/debpalash/VoiceStudio/tree/48e85106eb00a69c9beea3bdbf0a23692c7aa8ca)。重点查看：

- `electron/src/renderer/src/styles/globals.css`
- `electron/src/renderer/src/styles/t3-theme.css`
- `electron/src/renderer/src/components/app-shell/workspace-sidebar.tsx`
- `electron/src/renderer/src/components/app-shell/top-bar.tsx`
- `electron/src/renderer/src/components/app-shell/app-shell.tsx`

参考当前 Electron 界面的中性色、蓝色主要操作、52px 顶栏、可收起导航、细分隔线、紧凑文字和工作区结构。Blender Pilot 使用自己的 React/CSS 实现，并针对 Blender 画面与右侧对话布局调整：左栏 224px / 收起 48px，项目标签 38px。没有复制 VoiceStudio 的源码、商标图形或业务功能。

仓库里的 `docs/screenshot-studio.png` 是早期 v0.3.9 黑色/玫红界面，和当前 Electron 样式不同。本轮按当前源代码方向调整，不宣称与旧截图逐像素一致。Blender 原生界面使用自己的主题，不随外层工作台的浅深主题重新着色。

## 并发边界

同一项目只允许一个活动 AI 任务；其他项目可以同时执行。任务运行期间该项目网页视口只读，切换项目不改变任务目标。关闭项目需先停止其任务，未执行任务的项目关闭时保存场景。

当前是一个可信操作者的工作台。不同项目隔离场景状态、会话和执行目标，但运行在同一容器、共享全局库和文件系统，不能作为不可信用户之间的安全边界。
