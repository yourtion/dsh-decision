# OpenRouter 首次发布与自动发布配置

目标是先让新增的 `@techs/dsh-decision-openrouter` 在 npm 上存在，以便配置 Trusted Publisher；不要求发布 `1.0.0`，也不需要为初始化改动其他包的版本。仓库各包继续保持 `0.2.0`。

## 1. 创建 OpenRouter 的初始化发布包

当前适配器依赖本次 PR 新增的核心导出 `validateJudgmentRequest`。npm 上已发布的 `@techs/dsh-decision@0.2.0` 没有该导出，因此不能把当前适配器源码单独当作可立即使用的正式版本发布。

只为创建 npm 包并配置自动发布时，使用独立的 `0.0.0-bootstrap.0` 初始化版本，发布到 `bootstrap` 标签。它只包含初始化说明和明确报错的占位入口，不包含适配器功能、运行时依赖或任何凭证；不更新源码包版本，也不设置 `latest`。

从仓库根目录运行：

```sh
node scripts/prepare-openrouter-bootstrap.mjs
```

脚本只在临时目录生成 tarball，不会发布或修改 npm 配置。根据输出的 tarball 路径，在本机登录有 `@techs` 发布权限的 npm 账号后发布：

```sh
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm publish /实际输出路径/techs-dsh-decision-openrouter-0.0.0-bootstrap.0.tgz \
  --access public --tag bootstrap --registry=https://registry.npmjs.org
npm view @techs/dsh-decision-openrouter@bootstrap version
```

首次发布可能要求浏览器或 2FA 验证。若初始化版本已经存在，检查包归属和内容后直接进入配置步骤，不重复发布同一个版本。

该初始化包不能用作运行时适配器。若首次发布就需要可安装使用的完整功能，应先选择一个尚未发布的正式版本，同时发布包含新增导出的核心，再发布依赖该核心的适配器；`0.2.0` 不能被覆盖。

## 2. 仅为 OpenRouter 配置 Trusted Publisher

包创建后，在 npm 网页的 `@techs/dsh-decision-openrouter` → Settings → Trusted publishing 中绑定：

| 字段                 | 值                                                          |
| -------------------- | ----------------------------------------------------------- |
| Provider             | GitHub Actions                                              |
| Organization or user | `yourtion`                                                  |
| Repository           | `dsh-decision`                                              |
| Workflow filename    | `release.yml`，仅文件名                                     |
| Environment          | 留空，workflow 当前未配置 environment                       |
| Allowed action       | **Allow npm publish**；仅允许 stage 不足以运行现有 workflow |

也可使用 npm >= 11.15.0 的 CLI，在已登录并启用账号 2FA 的本机执行：

```sh
npm trust github @techs/dsh-decision-openrouter \
  --repo yourtion/dsh-decision \
  --file release.yml \
  --allow-publish \
  --yes
npm trust list @techs/dsh-decision-openrouter
```

CLI 可能要求交互式 2FA。已有有效绑定时先检查并复用，不要盲目撤销其他配置。无需因此重发或重配已有包；其他尚未创建或绑定的新包则需要各自完成初始化，不能继承 OpenRouter 的绑定。

新绑定需要在 **2 天内**完成首次 OIDC 发布，否则会过期。本地发布初始化包不验证 CI 绑定；若暂不准备正式发布，可以等正式发布前再创建绑定。

## 3. 后续正式版本由 CI 发布

首次正式发布必须包含更新后的核心与适配器。现有 workflow 要求所有 `packages/*/package.json` 与标签版本一致；例如之后选择 `0.2.1`，更新版本号和 changelog，合并源码并确认 CI 通过后：

```sh
git tag -a v0.2.1 -m 'Release 0.2.1'
git push origin v0.2.1
```

workflow 会构建、测试、校验版本，再按依赖顺序发布核心、适配器和 Pi。`workspace:~` 在 **pnpm** 打包/发布时替换为实际版本范围，因此正式源码包使用 `pnpm publish`，不要直接用 `npm publish`。

初始化用的 `0.0.0-bootstrap.0` 与正式版本不同，不会导致 CI 跳过首次正式发布。CI 使用 GitHub-hosted runner、`id-token: write` 和 OIDC，不需要 `NPM_TOKEN`；整个 workflow 中每个待发布包仍需有各自有效的 Trusted Publisher。

官方参考：[npm trust CLI](https://docs.npmjs.com/cli/v11/commands/npm-trust/) · [Trusted publishing](https://docs.npmjs.com/trusted-publishers/)
