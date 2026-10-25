# 素材格式与当前界面（2026-10-25）

## 支持哪些素材

平台支持把自己的 Blender 文件、资源网站下载的模型加入全局素材库，分类、引用，再导入不同项目作为独立副本。素材仍保留来源网址、作者和许可信息。

| 格式                                             | 使用方式                                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `.blend`                                         | 上传完整文件；导入时追加对象与关联数据，保留当前工程，不覆盖世界、渲染和工程设置。外部贴图请先 Pack Resources，或连同相对路径资源上传 ZIP。 |
| `.glb`                                           | 推荐的单文件交换格式，便于携带模型与贴图。                                                                                                  |
| `.gltf`                                          | 内嵌依赖可单独上传；外置 BIN／贴图请整体打包 ZIP。                                                                                          |
| `.fbx`、`.obj`                                   | 支持模型导入；OBJ 的 MTL、贴图与 FBX 的外部贴图应一同打包。不同格式对材质、动画的保真能力不同。                                             |
| `.stl`、`.ply`                                   | 支持几何模型导入；不应期待完整 Blender 材质与工程数据。                                                                                     |
| `.usd`、`.usda`、`.usdc`、`.usdz`                | 支持 Blender USD 导入；具体节点／材质／动画仍受 Blender 转换能力限制。                                                                      |
| `.abc`                                           | 支持 Alembic 导入，适合几何与缓存交换。                                                                                                     |
| `.png`、`.jpg`、`.jpeg`、`.webp`、`.hdr`、`.exr` | 已有图片／贴图／环境资源入口；导入图片数据块，不会自动把图片变成 3D 模型或搭建 PBR 材质。                                                   |
| `.zip`                                           | 新增多文件模型素材包，保留目录、入口和依赖；原 ZIP 可下载，解压内容用于导入。                                                               |

Blender 官方列出的交换格式包含 ABC、USD、OBJ、FBX、PLY、STL 等，见 [官方格式手册](https://docs.blender.org/manual/en/latest/files/import_export/index.html)。[Poly Haven 的模型规范](https://docs.polyhaven.com/en/technical-standards/models)以 `.blend` 为主，并采用 `textures` 子目录组织贴图；其 [FAQ](https://docs.polyhaven.com/en/faq)也说明下载会组合模型与依赖为 ZIP。因此本轮重点补齐完整素材包，而不是只扩大后缀白名单。

## ZIP 规则

压缩文件最多 100 MiB，解压最多 512 MiB、2000 个文件及目录，使用普通 ZIP。保留 `.gltf`／`.bin`／贴图或 `.obj`／`.mtl`／贴图的相对目录。拒绝路径穿越、符号链接、加密包、越界和损坏数据；glTF 与 OBJ/MTL 引用缺失或为外部地址时拒绝入库。不会自动访问外部网址下载文件。

默认按 `.blend`、GLB、glTF 等优先级寻找唯一入口；一个格式存在多个模型时，需要在 ZIP 根目录增加 `pilot-asset.json`：

```json
{ "entry": "models/room.blend" }
```

ZIP 需包含模型入口。纯贴图压缩包、分卷／RAR／7z、带复杂命令选项的 MTL 贴图声明暂不作为自动素材包导入；可先整理为 Blender 工程或 GLB。`.max`、`.ma/.mb`、`.c4d`、`.unitypackage`、`.uasset` 不是 Blender 通用模型交换格式，当前不接受它们冒充可导入模型。

上传 Blender 工程和在当前工程中复用素材是不同操作。本轮支持前者入库、后者追加模型数据；没有将任意上传工程直接替换当前项目的按钮。保存或再打开原工程时，仍要保留所有外部依赖。单个文件上传沿用 2 GiB 限制，实际大型工程可操作性受内存与任务超时限制；本轮没有大型项目压力测试。

## 配色纠正与截图

用户指定的参考是 [voicestudio.sh](https://voicestudio.sh/) 当前网站。已实际打开官网并查看其产品截图：黑色、炭灰、暖白文字与浅色主操作，产品图存在少量粉色强调，不能据此把整个工作台做成紫色。此前选用 plum／heritage 主题是参考选择错误。

当前统一为中性黑灰和暖白，浅色主题也使用中性灰白。导航、模板、素材、技能、聊天与控制台共享变量；Blender 原生窗口保持 Blender 自身主题。README 只引用 `screenshots/current/` 中本轮重新拍摄的图片，历史图片只保留在历史验收文档中。

![当前素材库与 ZIP 条目](screenshots/current/library-dark.png)

![当前工作台](screenshots/current/workbench-dark.png)

## 验证范围

- 116 项 Node、11 项 Python 检查通过；新增 API 测试验证 ZIP 入库、原包下载、入口读取、重试，以及缺失依赖和越界拒绝。
- 真实 Blender 5.2.3／MCP 对上述 12 种模型格式执行导出→导入；另有 glTF+BIN+贴图、OBJ+MTL+贴图两个 ZIP 入库→真实导入，检查对象增加、材质图像存在和资源无缺失。
- 原生 Codex→MCP→Blender 完整链路重跑，模型为本地 Responses 协议夹具；没有调用外部真实模型。
- 技能与结果界面 18 组浏览器检查通过；五个主要页面深浅主题及 1440／1280／1024 布局重新截图。实际截图已经查看，未混用旧的紫色图片。
- 数据库使用明确标识的 PostgreSQL WASM／TCP 测试环境；Docker、原生 PostgreSQL 和外部真实模型待办仍然保留。

机器报告位于 `validation/asset-formats-2026-10-25.json`、`validation/neutral-native-2026-10-25.json`、`validation/neutral-skills-2026-10-25.json` 和 `validation/neutral-interface-2026-10-25.json`。
