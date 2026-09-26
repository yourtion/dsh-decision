# @techs/dsh-decision

把 [Jev](https://jev-ai.pro) 的概率判断接入 [pi](https://pi.dev/docs/latest/extensions) 和 [dsh](https://github.com/deepseek-ai/deepseek-harness)。Jev 只判断工具风险等明确问题；agent 的主模型仍负责生成回复。两个宿主共用六维工具风险策略，pi 目前只接入工具调用前的 guardrail。

## 从仓库接入 pi

需要 Node.js 22.19+、pnpm、pi，以及 Vercel AI Gateway key。从仓库根目录运行：

```sh
pnpm install
pnpm run build
# 确保启动 pi 的 shell 已导出 AI_GATEWAY_API_KEY 或 JEV_API_KEY
pi -e ./packages/pi-decision
```

`-e` 只在本次 pi 进程加载扩展。确认可用后，可从仓库根目录运行 `pi install ./packages/pi-decision` 持久加载；这是本地 workspace 包，仓库及依赖链接需保留。pi 扩展默认通过 [Vercel AI Gateway 的 TypeSafe 兼容接口](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)调用 `typesafe-ai/jev`，优先读取 `AI_GATEWAY_API_KEY`，其次读取 `JEV_API_KEY`。

扩展默认是 **shadow**：异步评估工具调用，判断结果不阻断工具。要复现完整调用，可用已配置凭证的主模型执行：

```sh
pi -e ./packages/pi-decision --no-session --tools read \
  --provider zai-coding-cn --model glm-5.3-flash --print \
  'Use the read tool exactly once to read README.md, then reply with only its first Markdown heading.'
```

示例中的 `zai-coding-cn/glm-5.3-flash` 是本仓库实际冒烟时可用的**主模型**；请按自己的 pi 凭证替换。Jev key 能让扩展判断工具，不会自动为 pi 的主模型提供凭证。本次冒烟中，模型调用了一次 `read` 并成功回答标题，Jev 同时把该读取判为 `review`；因此先保持 shadow，观察误判后再考虑 enforce。完整命令、环境变量和结果见 [接入与验证说明](docs/integration.md)。

## 从仓库接入 dsh

需要已安装 dsh。仓库的 [profile](profile/cordis.patch.yml) 默认也使用 Vercel AI Gateway，**只读取 `AI_GATEWAY_API_KEY`**。如果现有 key 导出为 `JEV_API_KEY`，先在启动 dsh 的 shell 中运行 `export AI_GATEWAY_API_KEY="$JEV_API_KEY"`，或把 profile 的 `apiKeyEnv` 改为 `JEV_API_KEY`。

```sh
pnpm install && pnpm run build
mkdir -p ~/.dsh/profiles
ln -s "$(pwd)/profile" ~/.dsh/profiles/decision
(cd profile && pnpm install)
dsh --profile decision '列出本目录文件并统计行数'
```

profile 默认 `enforcement: shadow`，dsh 原生权限规则继续生效。dsh 的工具 guardrail 默认开，模型路由、工具结果 judge 默认关；机器审批由 profile 的 `permission: machine` 启用，但当前 Jev 没有自动放行资格。现有 Web profile 需要另行安装和启用插件。[Web 接入、验证范围及直连 Jev 的方法](docs/integration.md#dsh-接入)在文档中。

## 仓库结构

| 路径                     | 用途                                    |
| ------------------------ | --------------------------------------- |
| `packages/decision/`     | 宿主无关的风险内核与 dsh 四个切面       |
| `packages/decision-jev/` | Jev 的 TypeSafe System One wire adapter |
| `packages/pi-decision/`  | pi 的 `tool_call` guardrail 扩展        |
| `profile/`               | dsh 的示例 profile                      |

```sh
pnpm run typecheck # 构建并检查三个包
pnpm run test      # 单元测试
pnpm run lint      # oxlint
pnpm run fmt       # oxfmt --check
```

架构与策略见 [设计文档](docs/design.md) 和 [v2 计划](docs/v2-plan.md)。风险阈值是实验值，`enforce` 模式当前标记为实验特性（启动时会打警告）；发往外部 Jev 服务的状态默认经本地脱敏（掩码密钥形态的内容，`privacy.outbound: raw` 可回退原样），未识别的私密内容仍可能发出。每次判定的 sanitized 审计记录默认写入 `$XDG_STATE_HOME/dsh-decision/`（pi 为 `pi-audit.jsonl`，dsh 为 `dsh-audit.jsonl`），可用 `audit.enabled: false` 或 `PI_DECISION_AUDIT=off` 关闭。MIT 协议见 [LICENSE](LICENSE)，变更见 [CHANGELOG](CHANGELOG.md)。

## 阈值与校准现状

六维默认阈值来自 2026-09-26 的 live 评估（22 个人工标注用例，`typesafe-ai/jev`）：旧阈值下良性误阻断 75%，重校后 **误阻断 0%、deny 漏放 0%、deny 软化为转人工 0**，全部阈值与最近良性分数保持 ≥0.05 边际。校准过程包含一次提问措辞修复——旧 `externalSideEffect` 措辞把写工作区文件（0.74）打得比群发邮件（0.71）还高，改写并限定"会话外可见"语义后倒挂消除（良性最大分降至 0.13）。**阈值与提问措辞是成对校准的**，换模型或改问题都要重跑。方法、指标定义、`externalSideEffect` 调参案例和换环境流程见 [评估方法](docs/eval.md)，工具用法见 `pnpm run eval`（[说明](docs/integration.md#阈值评估)）。样本仍是种子集：`enforce` 的实验标记在标注集扩大并复测前不会摘除。
