# 部署与运维

## 最小部署

支持 Linux amd64。建议从 8 GB RAM、15 GB 可用空间起步，小场景可使用 CPU；复杂场景建议 16–32 GB 或更多。快照会保存完整 Blender 文件并打包可打包资源，大量高分辨率贴图会明显增加磁盘消耗。

```bash
./scripts/setup.sh
docker compose up -d --build
docker compose logs --tail=100 studio web
```

默认地址只绑定 localhost。远程访问使用 SSH 转发，或 HTTPS 反向代理。初次下载 Blender 约数百 MB，镜像构建需要网络访问 npm、PyPI、Ubuntu 和 Blender 下载站。

模型配置保存于网页设置。官方或中转接口都要实现 Responses API 的 SSE、function tools 与 input_image。连接测试失败时看 HTTP 状态与明确错误，不要把 Chat Completions URL 直接填入。Docker 中的 `localhost` 指容器本身；如果模型网关在宿主机，使用可路由地址或配置 `host.docker.internal:host-gateway`。

## HTTPS

使用已有 Caddy/Nginx 更轻。Caddy 运行在宿主机时可使用：

```caddy
blender.example.com {
    reverse_proxy 127.0.0.1:8090
}
```

将 `.env` 中 `PILOT_SECURE_COOKIE=true`，重建 Web 容器配置：

```bash
docker compose up -d web
```

代理必须保留 Host、支持 WebSocket Upgrade、关闭 SSE 缓冲，并允许长连接。Nginx 的 `/desktop` 配置 Upgrade/Connection；`/api/` 使用 `proxy_buffering off` 和足够长的 `proxy_read_timeout`。大文件走 4 MiB 分块，代理单请求限制至少 5 MiB。

## GPU

默认 Xvfb + Mesa 适用于建模和低频预览，视口不是经过 NVIDIA 硬件加速调优的远程桌面。Cycles 的 CUDA/OptiX 可以额外使用 NVIDIA GPU：

```bash
docker compose -f compose.yaml -f compose.gpu.yaml up -d --build
```

宿主机需先安装驱动与 NVIDIA Container Toolkit。然后在 Blender Preferences → System 选择对应计算设备，在 Render Properties 选择 Cycles/GPU。GPU override 只透传设备，不保证自动启用 GPU，也不代表已针对你的 GPU 验证。大型实时视口可后续替换桌面传输适配层。

## 备份与恢复

先在 UI 保存场景，停止服务后备份整个命名卷。默认 Compose 项目名为 blender-pilot，卷名为 `blender-pilot_pilot-data`。

```bash
docker compose down
mkdir -p backups
docker run --rm -v blender-pilot_pilot-data:/data:ro \
  -v "$PWD/backups:/backup" alpine:3.22 \
  tar -czf /backup/pilot-backup.tar.gz -C /data .
docker compose up -d
```

备份包含加密 key 的解密主密钥及原生会话，按敏感文件保护。恢复到空卷后将文件所有权设置为 uid/gid 1000，再启动。同一套数据不要同时运行多个 Web/PGlite 实例。

不要执行 `docker compose down -v`，除非确定要删除所有项目。截图、快照、导出和未完成上传不会自动清理；首版需要定期查看控制台剩余容量并人工保留/归档数据。

## 升级

```bash
# 先完成整卷备份
git pull --ff-only
docker compose build
docker compose up -d
```

不要在有活动 AI 任务时升级。确认控制台健康、打开旧项目、发一个小型修改任务并检查截图后再继续生产工作。

## 故障处理

| 现象                    | 排查                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| 容器启动失败            | `.env` 的访问密码至少 12 字符、内部 token 至少 24 字符；检查磁盘和 `docker compose logs` |
| Blender 等待连接        | studio 健康检查、Blender 进程与插件；首次加载等待 1–2 分钟                               |
| 视口断开                | 点击重新连接；代理必须支持 `/desktop` WebSocket；检查 studio 中 x11vnc                   |
| 文字能答、图像失败      | 模型/中转需支持 Responses 的图像输入和工具图像结果；不能只看「测试连接」通过             |
| Codex thread/start 超时 | 运行 `npm run doctor:codex` 隔离原生内核启动问题；当前开发云端有此未解决问题，见验证记录 |
| 一直「需要检查」        | 展开工具错误与检查结论；模型未回报当前截图、图像预算耗尽或修改失败都会保留该状态         |
| 任务取消后场景已变      | 已执行的 Python 不会撤销；在快照页恢复操作前状态                                         |
| 重启后任务中断          | 这是防止重复修改的设计；检查当前场景后明确发起新任务                                     |
| FBX/OBJ 没有贴图        | 首版不解析多文件相对依赖，优先转换成含贴图 GLB；图片可另外上传并明确绑定                 |
| glTF 上传被拒           | 上传内嵌资源的 glTF 或 GLB，不接受任意外部 URI                                           |

日志不会有意输出模型密钥。分享诊断信息前仍请检查用户输入、Python 和文件名是否含有私人信息。
