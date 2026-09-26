# @techs/dsh-decision

English | [简体中文](https://github.com/yourtion/dsh-decision/blob/main/packages/decision/README.zh-CN.md)

The decision layer for DeepSeek Harness (dsh): host-neutral typed judgments (binary, categorical, and ordinal), a versioned deterministic policy, and four dsh integration points: tool guardrail (`tools/pre-execute`), model routing (`agent/request`), result judging (`tools/post-execute`), and machine approval (`approval/request`).

As a Cordis plugin, it exposes `ctx.decision` for judgment provider registration:

```ts
export const inject = ["decision"];

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.decision.registerProvider(provider));
}
```

Providers are separate packages; [@techs/dsh-decision-jev](https://www.npmjs.com/package/@techs/dsh-decision-jev) is the first implementation. Any model that can provide structured probability judgments can be integrated through a `JudgmentProvider` adapter, even if it uses a different API protocol. The adapter declares its supported question types, registers with `ctx.decision`, and is selected by `decision.config.provider`. A new model needs its own threshold evaluation; Jev's calibration does not transfer automatically.

This package includes no provider, route table, or credentials. Its `./kernel` export has no Cordis or Schemastery runtime dependency and is shared with Pi. The default `shadow` mode observes without changing behavior. Outbound state is redacted for recognizable secret patterns, and each judgment writes a sanitized audit record. `enforce` is experimental.

Install it with the Jev adapter into an existing dsh profile (requires a Vercel AI Gateway key):

```sh
export AI_GATEWAY_API_KEY=your_gateway_key
dsh plugin --profile web add @techs/dsh-decision @techs/dsh-decision-jev
dsh web
```

Each package declares a `dsh.bundle`, so installation adds both configuration layers. The defaults observe tool risk and retain dsh's native permission mode.

- [Design and v2 plan](https://github.com/yourtion/dsh-decision/blob/main/docs/design.md) (Chinese)
- [Integration and verification](https://github.com/yourtion/dsh-decision/blob/main/docs/integration.md) (Chinese)
- [Threshold evaluation](https://github.com/yourtion/dsh-decision/blob/main/docs/eval.md) (Chinese)
- [Repository README](https://github.com/yourtion/dsh-decision#readme)
