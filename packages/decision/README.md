# @techs/dsh-decision

dsh 的决策层内核：宿主无关的 typed judgment（Binary / Categorical / Ordinal）、版本化的确定性 Policy，以及 dsh waterfall 的四个切面——工具 guardrail（`tools/pre-execute`）、模型路由（`agent/request`）、结果 judge（`tools/post-execute`）、机器审批（`approval/request`）。

作为 Cordis 插件加载后以 `ctx.decision` 服务暴露 provider 注册面：

```ts
export const inject = ["decision"];

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.decision.registerProvider(provider));
}
```

判断 provider 由独立插件包提供（首个是 [@techs/dsh-decision-jev](https://www.npmjs.com/package/@techs/dsh-decision-jev)）；本包不内置任何 provider、路由表或凭证。`./kernel` 子路径不引入 Cordis/Schemastery 的运行时依赖，供 pi 等其他宿主复用。默认 `shadow`（观察记录、不改变行为）；出站状态默认本地脱敏；每次判定写 sanitized 审计记录。`enforce` 为实验特性。

- [设计文档](https://github.com/yourtion/dsh-decision/blob/main/docs/design.md) / [v2 计划](https://github.com/yourtion/dsh-decision/blob/main/docs/v2-plan.md)
- [接入与验证](https://github.com/yourtion/dsh-decision/blob/main/docs/integration.md)
- [阈值评估方法](https://github.com/yourtion/dsh-decision/blob/main/docs/eval.md)
- [仓库根 README](https://github.com/yourtion/dsh-decision#readme)
