# Canvas 个人分支、镜像部署与更新

本仓库：<https://github.com/mju1314/infinite-canvas>，维护分支：`patch/grok-video`。

第一版基于官方 `v0.17.0`，镜像版本为 `grok-video-r1`。应用内版本号沿用上游，个人补丁版本以 Git 标签和镜像标签为准。保留 Grok 视频创建、刷新后自动恢复、手动获取任务状态，以及原有渠道导入、参考图和素材下载等修改。Sub2API 后端无需为本方案打补丁。

## 首次替换旧 Canvas

以下命令在服务器的 Bash 终端执行。默认旧容器名为 `infinite-canvas`，Caddy 容器名为 `caddy`，共享网络名为 `sub2api_sub2api-network`。先查看实际名称；如不同，修改命令和 `.env` 中对应值。

```bash
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
docker inspect caddy --format '{{json .NetworkSettings.Networks}}'
docker network inspect sub2api_sub2api-network >/dev/null
```

先准备镜像和部署文件，成功后再删除旧容器。GHCR 镜像支持 Linux amd64 和 arm64，服务器无需安装 Bun、Node 或编译源码。

```bash
mkdir -p /root/canvas-grok
cd /root/canvas-grok
curl -fL --retry 3 https://raw.githubusercontent.com/mju1314/infinite-canvas/grok-video-r1/deploy/compose.yaml -o compose.yaml
curl -fL --retry 3 https://raw.githubusercontent.com/mju1314/infinite-canvas/grok-video-r1/deploy/.env.example -o .env
docker pull ghcr.io/mju1314/infinite-canvas:grok-video-r1
docker compose --env-file .env config
```

上述任一命令失败，先处理失败再继续。首次下载 `.env` 会覆盖同名文件；已有个人配置时应编辑现有文件。确认网络配置正确后执行：

```bash
CANVAS_OLD_IMAGE=$(docker inspect infinite-canvas --format '{{.Image}}')
docker rm -f infinite-canvas
docker compose --env-file .env up -d --no-deps infinite-canvas
docker compose ps
docker logs --tail 50 infinite-canvas
```

沿用现有 Caddy 的 `infinite-canvas:3000` 反向代理，不修改 Sub2API、数据库或共享网络。本次按用户要求不备份旧 Canvas。旧官方镜像可在新页面正常访问后清理；若仍有容器引用，Docker 会拒绝普通删除，不要加 `-f`：

```bash
docker image rm "$CANVAS_OLD_IMAGE"
```

不要使用全局 `docker system prune` 或在 Sub2API 的 Compose 目录执行 `down`。保留旧部署文件时，不要再用它启动官方 Canvas。若配置了自动更新工具，应将此容器排除，版本更新由下面的步骤管理。

画布、素材和渠道配置主要保存在浏览器本地。服务器容器删除不会清空这些数据；继续使用原域名和原浏览器，避免清理该站点存储。

## 后续部署与回退

开发修改推送到 `patch/grok-video` 后，GitHub Actions 自动执行视频测试并发布浮动标签 `grok-video` 和源码标签 `sha-<commit>`。服务器不会自动更新。

验收后创建下一个 `grok-video-rN` 标签，等待该标签的 Actions 全部通过，再手动部署。不要移动或覆盖已发布版本标签。以第二版为例：

```bash
cd /root/canvas-grok
docker pull ghcr.io/mju1314/infinite-canvas:grok-video-r2
sed -i 's|^CANVAS_IMAGE=.*|CANVAS_IMAGE=ghcr.io/mju1314/infinite-canvas:grok-video-r2|' .env
docker compose --env-file .env config
docker compose --env-file .env up -d --no-deps infinite-canvas
docker compose ps
```

`r2` 只是后续版本示例，发布前不可拉取。Compose 使用 `pull_policy: never`，因此每次先显式拉取，再修改版本和启动。保留上一版补丁镜像；回退时把 `.env` 改回上一版并执行相同的 `up` 命令即可。需要完全固定镜像内容时，`CANVAS_IMAGE` 可填写 `ghcr.io/mju1314/infinite-canvas@sha256:实际摘要`。

## GitHub 维护

默认分支 `patch/grok-video` 是个人应用版本，`main` 保留用于跟进官方代码。GitHub 网页编辑或 Codespaces 均可用于维护；无需再手工传输本地源码包。更新官方代码应先合入个人分支，解决冲突后由 Actions 验证，不能直接换用官方镜像。

已有维护检出中的命令如下；新克隆先添加 `upstream` 指向 `https://github.com/basketikun/infinite-canvas.git`：

```bash
git fetch upstream --tags
git switch patch/grok-video
git merge upstream/main
git push origin patch/grok-video
```

合并后重点核对 `project.tsx`、`canvas-generation-helpers.ts`、`types/canvas.ts` 和 `services/api/video.ts` 的任务恢复逻辑，不要整文件覆盖个人补丁。Actions 成功且验收通过后，在相应提交创建并推送新标签，例如：

```bash
git tag -a grok-video-r2 -m "Canvas Grok video patch r2"
git push origin grok-video-r2
```

## 验收边界

自动测试覆盖 JSON 创建、远端任务 ID、恢复查询、鉴权下载和错误处理；已有浏览器模拟验收覆盖刷新恢复与视频播放。真实上游生成、首帧支持与计费仍需上线后验收。

使用 OpenAI 格式渠道，Base URL 指向 Sub2API，模型选择 `grok-imagine-video`，模型脚本留空。任务 ID 保存后刷新页面，应继续查询原任务，不应再次创建任务；下载失败后可手动重新获取状态。
