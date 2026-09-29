# 0.2.0 社区发布稿

发布顺序：先发布并验证三个 npm 包的 0.2.0，再给仓库设置简介与 `dsh-plugin`、`pi-extension` topic，最后发布社区帖子。Pi 包已有 `pi-package` 关键字，可由 Pi 包目录发现。安装说明与实际发布版本保持一致。

建议的 GitHub 简介：`Extensible judgment layer for DeepSeek Harness and Pi: structured probability providers, shared tool-risk policy, and shadow audit traces. Jev adapter included.`

## DeepSeek Harness · Show Your Plugins!

**标题：** DSH | dsh-decision：可接概率判断模型的工具风险决策层

我做了一个 DeepSeek Harness 的决策层插件：核心接受能返回结构化概率的判断模型，由确定性策略处理工具风险。Jev 是目前提供的首个 adapter；其他模型可实现 `JudgmentProvider` 接口接入，不要求使用 Jev 的 API。内置策略评估破坏性操作、密钥暴露、隐私暴露、会话外副作用、提权和越界六个维度，也支持自定义维度。默认 `shadow`，只记录判断，不改变 dsh 的工具执行和原生权限规则。模型路由、工具结果判断和机器审批也有接入切面，示例 bundle 默认不开路由和结果判断；Jev 当前没有自动放行资格。

安装到现有 Web profile（Node.js 22.19+、Vercel AI Gateway key）：

```sh
export AI_GATEWAY_API_KEY=你的_Gateway_key
dsh plugin --profile web add @techs/dsh-decision @techs/dsh-decision-jev
dsh web
```

判定会写入本地 JSONL 审计文件；发往判断模型的状态默认进行密钥形态脱敏。`enforce` 仍是实验特性：默认阈值已于 2026-09-29 用 50 个固定样本 ×3 轮评估校准（密钥风险阈值据此调整，calibration 105/105、验证 45/45）；但密钥分数距阈值最近仅 0.01、隐私维度仍有重叠，不应把这组结果当成实际环境的误判率。欢迎试用 `shadow` 并反馈真实工具调用里的误判。

源码与接入说明：[yourtion/dsh-decision](https://github.com/yourtion/dsh-decision) · [接入与验证](https://github.com/yourtion/dsh-decision/blob/main/docs/integration.md) · [评估方法](https://github.com/yourtion/dsh-decision/blob/main/docs/eval.md)

## Pi · General Discussions

**Title:** pi-decision: a shadow-by-default tool risk guardrail for Pi

I released `@techs/pi-decision`, a Pi extension that assesses tool calls across six risk dimensions. It shares a provider-neutral risk policy with the DeepSeek Harness plugin, supports custom dimensions, and writes sanitized local audit records. Jev is the first judgment adapter; this Pi package currently creates that adapter directly, so another judgment model would need a new adapter and Pi integration. Shadow mode is the default: the assessment runs asynchronously and does not block tools. Pi's main model and its credentials are configured separately.

```sh
export AI_GATEWAY_API_KEY=your_gateway_key
pi install npm:@techs/pi-decision
```

The extension currently covers `tool_call` only. Enforce mode is experimental; the defaults were recalibrated on 2026-09-29 with a 50-case, three-repeat evaluation (105/105 calibration actions, 45/45 on the previously inspected validation set), but secret-score margins are only 0.01 and privacy scores still overlap, so this is not production-grade accuracy. I recommend starting in shadow mode and checking the audit before enabling enforcement. Feedback on false positives and the review flow would be useful.

Source and setup: [yourtion/dsh-decision](https://github.com/yourtion/dsh-decision) · [Pi integration](https://github.com/yourtion/dsh-decision/blob/main/docs/integration.md#pi-接入) · [evaluation method](https://github.com/yourtion/dsh-decision/blob/main/docs/eval.md)
