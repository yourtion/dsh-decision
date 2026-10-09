# @techs/dsh-decision

[English](README.md) | 简体中文

dsh 的决策层内核：宿主无关的 typed judgment（Binary / Categorical / Ordinal）、版本化的确定性 Policy，以及 dsh waterfall 的四个切面——工具 guardrail（`tools/pre-execute`）、模型路由（`agent/request`）、结果 judge（`tools/post-execute`）、机器审批（`approval/request`）。

作为 Cordis 插件加载后以 `ctx.decision` 服务暴露 provider 注册面：

```ts
export const inject = ["decision"];

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.decision.registerProvider(provider));
}
```

判断 provider 由独立插件包提供，[`@techs/dsh-decision-jev`](https://www.npmjs.com/package/@techs/dsh-decision-jev) 是首个实现；新增的 [`@techs/dsh-decision-openai`](https://github.com/yourtion/dsh-decision/tree/main/packages/decision-openai) 接入原生 OpenAI Decisions API（目前从源码使用）。任何能返回结构化概率判断的模型，都可通过实现 `JudgmentProvider` 的 adapter 接入，即使 API 协议不同。adapter 声明支持的问题类型、注册到 `ctx.decision`，并由 `decision.config.provider` 选用；换模型后要重新评估阈值，不能沿用 Jev 的校准结果。

本包不内置任何 provider、路由表或凭证。`./kernel` 子路径不引入 Cordis/Schemastery 的运行时依赖，供 pi 等其他宿主复用。默认 `shadow`（观察记录、不改变行为）；出站状态默认本地脱敏；每次判定写 sanitized 审计记录。`enforce` 为实验特性。

与 Jev adapter 一起装进现有 dsh profile（需要 Vercel AI Gateway key）：

```sh
export AI_GATEWAY_API_KEY=你的_Gateway_key
dsh plugin --profile web add @techs/dsh-decision @techs/dsh-decision-jev
dsh web
```

两个包各自声明 `dsh.bundle`，安装后自动叠加配置层；默认只观察工具风险，保持 dsh 原生权限模式。

- [设计文档](https://github.com/yourtion/dsh-decision/blob/main/docs/design.md) / [v2 计划](https://github.com/yourtion/dsh-decision/blob/main/docs/v2-plan.md)
- [接入与验证](https://github.com/yourtion/dsh-decision/blob/main/docs/integration.md)
- [阈值评估方法](https://github.com/yourtion/dsh-decision/blob/main/docs/eval.md)
- [仓库根 README](https://github.com/yourtion/dsh-decision#readme)
