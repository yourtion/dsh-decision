# @techs/dsh-decision 技术方案

> 本文保留最初的 v1 设计，供追溯使用；其中的两维 guardrail、旧校准布尔值等不代表当前实现。实际接入和验证结果见 [integration.md](integration.md)，v2 实施状态见 [v2-plan.md](v2-plan.md)。

把"概率型决策模型"（TypeSafe Jev 及后续同类）接入 dsh 作为决策层。jev 只是第一个 adapter；
核心是一个 provider 无关的 typed-judgment 服务，四个 dsh waterfall 切面消费它。

## 架构

```
┌─ dsh waterfall 切面（消费方）────────────────────────────┐
│ tools/pre-execute   → guardrail（allow/deny/ask）        │
│ agent/request       → routing（替换 LlmCallConfig）      │
│ tools/post-execute  → judge（accept/block）              │
│ approval/request    → 机审（allowed-once/rejected/委托） │
└───────────────────────────┬─────────────────────────────┘
                            │ DecisionAdapter（本插件定义的 seam）
                ┌───────────┴───────────┐
                │ jev (systemone wire) │  ← 首个 adapter；后续同类模型可再注册
                └───────────────────────┘
```

- 核心包 `@techs/dsh-decision` 以 cordis `Service` 挂载（`super(ctx, 'decision')`），暴露 `ctx.decision`
  与 `registerAdapter()`。**每个 provider 是独立的插件包**（如 `@techs/dsh-decision-jev`，`inject: ['decision']`，
  加载即注册自己的 adapter）；后续同类模型新增 `packages/decision-<name>` 包即可，核心零改动。
- 仓库形态对齐上游 harness 约定：pnpm workspace（`packages/*`）、每包独立 tsc 构建、
  oxlint（`.oxlintrc.json`）+ oxfmt（默认配置）静态检查、vitest 按包运行。
- 决策原语对齐 TypeSafe System One 的三种问题类型：**Noul**（是/否概率）、
  **Choice**（单选 + 概率分布 + confidence）、**Score**（等级概率）。v1 只用 Noul 和 Choice。

## 已固定的决策

| #   | 决策             | 结论                                                                                                                                                                                                                                                                                                               |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 默认模式         | `shadow`：所有切面照常调用 adapter、记录日志，但一律 `next()` 放行；验证判断质量后再切 `enforce`                                                                                                                                                                                                                   |
| 2   | adapter 失败策略 | guardrail 可配 `onFailure: allow \| ask \| deny`，默认 `allow`（外部 API 故障不应瘫痪 agent；要严就把失败转 `ask` 人工兜底）。approval/judge/routing 失败一律降级委托（`next()`），**绝不因失败自动放行审批**                                                                                                      |
| 3   | guardrail 阈值   | 一次调用问两个 Noul：`harmful`（不可逆/破坏/生产变更）、`exposure`（密钥或隐私出信任边界）。`pMax = max(两者)`：`< allowBelow(0.2) → allow`；`≥ denyAt(0.7) → deny`；中间 `→ ask`（走 dsh approval 审批链，人工兜底）                                                                                              |
| 4   | 工具覆盖         | `guardrail.tools` 为空 = 全部工具（含 PTC 内层调用，它们同样过 pre-execute）；可配精确名单只筛高危工具（延迟预算：每次 0.5–1.5s）                                                                                                                                                                                  |
| 5   | 模型路由         | 默认关闭。`agent/request` 中以 Choice 问"本轮该用哪档模型"，`confidence < confidenceFloor(0.6)` 回退默认选型；路由表（key→provider/model/effort/maxTokens）必须显式配置，**不内置任何 provider**（环境相关：zai/sensenova/DeepSeek 等由 overlay 决定）                                                             |
| 6   | judge            | 默认关闭。post-execute 问两个 Noul：结果含 prompt injection？暴露密钥？`pMax ≥ blockAt(0.75) → block`（纠正性反馈替代结果），否则 accept                                                                                                                                                                           |
| 7   | 机审 approval    | 默认关闭。`P(允许) ≥ allowAt(0.85) → allowed-once`；`< rejectBelow(0.5) → rejected`；中间委托人工。**uncalibrated adapter 永不自动放行**（auto-allow 要求 `adapter.calibrated === true`；校准是 agent-chaperone 实测数据的前提）                                                                                   |
| 8   | 隐私边界         | 发给外部 API 的 `state` 最小化：guardrail 只发工具名+参数 JSON；routing 只发最后一条用户消息（截断）；judge 发结果文本（截断 8k）。不发送系统提示、历史对话、密钥明文（**v2 修订**：参数原样含密钥时也先经本地脱敏再发出，`privacy.outbound: raw` 可显式回退原样——见 [integration.md](integration.md#隐私与审计)） |
| 9   | 参数改写         | 不做。dsh 的 pre-execute 明确排除参数改写（参数已入会话日志）；纠正靠 deny+reason                                                                                                                                                                                                                                  |
| 10  | 配置面           | 全部经 schemastery `Config` 校验 + 显式 `resolveConfig()` 补默认值（默认值都在 resolve 函数里可见，无隐藏 `??`）；jev 的 `apiKey`/`apiKeyEnv` 二选一，缺失即加载失败（fail loud）                                                                                                                                  |

## Jev adapter（systemone wire）

- Endpoint：`POST {baseUrl}/v1/systemone`，默认 `baseUrl = https://jev-ai.pro/api`
  （TypeSafe 官方为 `https://api.typesafe.ai`）；`Authorization: Bearer <key>`。
- 请求：`{ state, model, questions: Record<key, Question> }`
  - Noul → `{ type:'noul', instructions, criteria?: {true,false} }`
  - Choice → `{ type:'choice', instructions, criteria: Record<选项, 描述|null> }`
- 响应：`answers[key]`：Noul `{ noul: 0..1 }`（P(yes)）；Choice `{ choice, probabilities, confidence }`。
- 429/529 固定 500ms 延迟重试一次；超时 `AbortSignal.any([请求 signal, AbortSignal.timeout(timeoutMs)])`。
- 不依赖 `@typesafe-ai/sdk`：薄 HTTP 客户端（fetch 可注入以便测试），运行时依赖只余 cordis/schemastery（+核心包）。

## 目录

```
packages/decision/       # @techs/dsh-decision：核心（类型 + 四切面 + DecisionRuntime 服务）
  src/types.ts           # DecisionAdapter / 问题与答案原语（Noul/Choice/Score）
  src/config.ts          # Config schema + resolveConfig()
  src/service.ts         # DecisionRuntime（adapter 注册表 + 解析）
  src/seams/{guardrail,routing,judge,approval}.ts   # 纯决策函数 + 薄 ctx.on 包装
  src/index.ts           # Service 子类，注册四切面
packages/decision-jev/   # @techs/dsh-decision-jev：Jev adapter 插件（systemone wire 薄客户端 + key 解析）
profile/                 # dsh profile 层（bundles dsh-base + 两行插件），软链到 ~/.dsh/profiles/decision
```

## 测试

决策逻辑全部抽为纯函数（`decideGuardrail()` 等），vitest 用假 adapter 覆盖阈值边界、shadow 不生效、
失败降级、uncalibrated 不放行、routing 置信度回退；jev adapter 用注入 fetch 覆盖 wire 映射、429 重试、超时。

## v2 候选（不在本版）

- off-task 判断（需要 `task` 上下文通道，agent-chaperone 有成熟设计可抄）
- Score 原语（危险等级分级而非二元）；会话级缓存与阈值离线调参（replay）
- shadow 判定落 session 事件（可观测面板）；subagent/workflow 编排决策
