# 首次本地发布与后续自动发布

本仓库的五个包统一发布为 `1.0.0`。先在本地发布到 npm，使新包存在，再为每个包配置 Trusted Publisher，之后通过版本标签触发 GitHub Actions 自动发布。

| 顺序 | 目录                           | npm 包                           |
| ---- | ------------------------------ | -------------------------------- |
| 1    | `packages/decision`            | `@techs/dsh-decision`            |
| 2    | `packages/decision-jev`        | `@techs/dsh-decision-jev`        |
| 3    | `packages/decision-openai`     | `@techs/dsh-decision-openai`     |
| 4    | `packages/decision-openrouter` | `@techs/dsh-decision-openrouter` |
| 5    | `packages/pi-decision`         | `@techs/pi-decision`             |

根目录 monorepo 和 `profile` 是私有工作区，不发布。`workspace:~` 依赖由 **pnpm** 打包/发布时替换为 `~1.0.0`，因此不要对源码包直接使用 `npm publish`。

## 1. 在本机准备源码和 npm 登录

先将包含 `1.0.0` 版本号的 PR 合并，拉取已合并的代码。需要有 `@techs` scope 的发布权限。使用 Node 24、仓库指定的 pnpm；命令行配置 Trusted Publisher 还要求 npm >= 11.15.0、账号启用 2FA。

```sh
git switch main
git pull --ff-only
npm install --global pnpm@11.27.1 'npm@^11.15.0'
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run fmt
```

## 2. 本地发布 1.0.0

从仓库根目录执行。发布会公开到 npm，并可能要求浏览器或 2FA 验证。按包顺序执行，核心和 adapter 在 Pi 之前。

```sh
set -eu
for dir in decision decision-jev decision-openai decision-openrouter pi-decision; do
  (
    cd "packages/$dir"
    node --input-type=module -e '
      import fs from "node:fs";
      const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
      if (pkg.version !== "1.0.0") throw new Error(`${pkg.name}: expected version 1.0.0`);
    '
    pnpm publish --access public --tag latest
  )
done
```

若中途失败，已成功发布的版本不可覆盖。先用 `npm view @techs/包名@1.0.0 version` 确认已发布项，再仅重试剩余目录；不要通过 unpublish 重发同一版本。账号认证或 2FA 失败时，先在本机完成登录/验证。

可以在发布前执行 `pnpm --filter @techs/包名 pack --pack-destination /tmp/dsh-release-1.0.0` 检查 tarball。包内应包含构建后的入口、声明、README 和许可证；adapter 与 Pi 的内部依赖不应残留 `workspace:`。

## 3. 为五个包配置 Trusted Publisher

npm 要求包先存在。每个包都要单独绑定；五个包共用以下字段，但不会自动继承配置。

| 字段                 | 值                                                          |
| -------------------- | ----------------------------------------------------------- |
| Provider             | GitHub Actions                                              |
| Organization or user | `yourtion`                                                  |
| Repository           | `dsh-decision`                                              |
| Workflow filename    | `release.yml`，仅文件名                                     |
| Environment          | 留空，workflow 当前未配置 environment                       |
| Allowed action       | **Allow npm publish**；仅允许 stage 不足以运行现有 workflow |

可在 npm 网页的各包 Settings → Trusted publishing 配置，也可在本机登录后使用 CLI：

```sh
set -eu
for pkg in \
  @techs/dsh-decision \
  @techs/dsh-decision-jev \
  @techs/dsh-decision-openai \
  @techs/dsh-decision-openrouter \
  @techs/pi-decision; do
  npm trust github "$pkg" \
    --repo yourtion/dsh-decision \
    --file release.yml \
    --allow-publish \
    --yes
  sleep 2
done
```

CLI 可能要求交互式 2FA。已有相同配置时先 `npm trust list @techs/包名` 检查，复用已有配置，不要盲目撤销其他有效绑定。较新 npm 支持多条绑定；旧版 CLI 的数量限制以该版本文档和实际返回为准。

新绑定需要在 **2 天内**完成首次 OIDC 发布，否则会过期；本地登录发布不验证 CI 绑定。若暂不准备发下一个版本，可以等下一次发布前再创建绑定。也可以在本地 `1.0.0` 发布完成后立即准备小版本 `1.0.1`，通过下一节的标签发布验证 OIDC。推送 `v1.0.0` 时 workflow 会跳过已经发布的五个版本，因此它只能补建 GitHub release，不能验证 OIDC 发布权限。

## 4. 后续自动发布

将五个 `packages/*/package.json` 更新到同一新版本，例如 `1.0.1`，更新 changelog 后提交并推送 `main`。确认工作区干净，再创建匹配标签：

```sh
git tag -a v1.0.1 -m 'Release 1.0.1'
git push origin v1.0.1
```

workflow 会校验版本、构建、测试、lint 和格式，创建 GitHub release，再按依赖顺序发布。它使用 GitHub-hosted runner、`id-token: write` 与 OIDC，不需要配置 `NPM_TOKEN`。部分包已发布时会跳过；失败后修复认证/绑定再重跑该次 workflow。

不要在首次本地发布和绑定完成前，依赖推送标签去创建缺失的新包。后续若新增 npm 包，也需要为该新包重复首次创建与绑定步骤。

官方参考：[npm trust CLI](https://docs.npmjs.com/cli/v11/commands/npm-trust/) · [Trusted publishing](https://docs.npmjs.com/trusted-publishers/)
