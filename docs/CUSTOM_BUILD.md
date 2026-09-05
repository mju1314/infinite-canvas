# Canvas Patch Images

[中文部署与维护手册](CUSTOM_BUILD.zh-CN.md)

This branch preserves the local Canvas fixes, including resumable Grok video generation through Sub2API. The MIT license and upstream attribution remain intact.

Repository: https://github.com/mju1314/infinite-canvas/tree/patch/grok-video

Actions: https://github.com/mju1314/infinite-canvas/actions

## Branches

- `main`: the official repository branch, without personal patches.
- `patch/grok-video`: the maintained application and image workflow.
- `grok-video-r1`, `grok-video-r2`, and later tags: tested custom releases. Do not move an existing release tag.

The first patch version is based on upstream `v0.17.0`. In addition to Grok request and response adaptation, it retains the existing task recovery, credential import, reference image, asset download, and prompt labeling fixes in the local source snapshot.

## Image Publishing

The `Canvas patch image` workflow runs on patch branch pushes, `grok-video-*` tags, and manual dispatches. It tests video requests before building Linux amd64 and arm64 images with the existing Dockerfile and pinned Bun lockfile.

Images are published to `ghcr.io/mju1314/infinite-canvas`, using the workflow's built-in `GITHUB_TOKEN`. No personal token is stored in the repository. Tags include:

- `grok-video`: the latest successful patch branch build, for testing.
- `sha-<commit>`: identifies the source revision.
- `grok-video-r1`: the first tagged patch release.

Production should select a tested release tag or an image digest. Tags can technically be overwritten; a `sha256` image digest identifies immutable image content.

GitHub may initially create a private container package. Make the intended package public in its package settings for unauthenticated server pulls, or log the server into GHCR using a token with `read:packages`. Do not put that token in Compose or commit it to Git.

## Server Deployment

Use `deploy/compose.yaml` and `deploy/.env.example` in a dedicated deployment directory. Set `CANVAS_IMAGE` to your actual image address and `CANVAS_NETWORK` to the existing Caddy network. The container remains named `infinite-canvas` and listens on port 3000.

Pull the selected image before replacing the old container:

```bash
docker pull ghcr.io/mju1314/infinite-canvas:grok-video-r1
```

For the initial replacement only, remove the old `infinite-canvas` container after the image is ready. The user has chosen not to back up the old official Canvas. Keep Sub2API, Caddy, databases, and the shared network running.

```bash
docker rm -f infinite-canvas
docker compose -f compose.yaml --env-file .env config
docker compose -f compose.yaml --env-file .env up -d --no-deps infinite-canvas
docker compose -f compose.yaml --env-file .env ps
```

Compose deliberately uses `pull_policy: never`; `docker pull` above selects the image explicitly. Subsequent updates only need a new image pull, a change to `CANVAS_IMAGE`, and the same `up` command. Keep the previous tested patch image to roll back by selecting its tag again.

Use an OpenAI-format channel pointing to Sub2API, select `grok-imagine-video`, and leave the model script empty. Verify creation, refresh recovery after the task ID has been persisted, authenticated downloads, first-frame generation, and billing against the real upstream. Local tests use simulated upstream responses.

## Upstream Updates

On GitHub, syncing the fork's `main` branch updates the official tracking branch only. Merge those updates into `patch/grok-video` before expecting the patch image to change. Updating the official container image directly does not preserve custom changes.

Use a clean maintenance checkout:

```bash
git fetch upstream --tags
git switch patch/grok-video
git merge upstream/main
```

Resolve conflicts in context rather than copying entire old files over new files. The task recovery code in `project.tsx`, `canvas-generation-helpers.ts`, and `types/canvas.ts` must remain consistent with `services/api/video.ts`.

```bash
cd web
bun install --frozen-lockfile
bun test ./tests/video.test.ts
bun run build
cd ..
git push origin patch/grok-video
```

After reviewing the successful build and testing task recovery, tag that commit with the next `grok-video-rN` version and push the tag. The workflow publishes the corresponding versioned image. If upstream incorporates equivalent fixes, remove the redundant patch only after validation.
