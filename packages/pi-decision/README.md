# @techs/pi-decision

English | [简体中文](https://github.com/yourtion/dsh-decision/blob/main/packages/pi-decision/README.zh-CN.md)

A Pi `tool_call` guardrail extension using Jev as its current judgment provider. Before each tool call, it assesses six risk dimensions: `destructive`, `secretExposure`, `privacyExposure`, `externalSideEffect`, `privilegeEscalation`, and `scopeViolation`. You can disable or customize built-in dimensions and add your own. The risk policy comes from the provider-neutral core, but this Pi extension currently creates the Jev provider directly; using another judgment model requires a new adapter and Pi integration. The agent's main model still generates responses, and Pi's own permission rules continue to apply.

```sh
export AI_GATEWAY_API_KEY=your_gateway_key
pi install npm:@techs/pi-decision
```

The default `shadow` mode observes asynchronously without blocking tools. Configure credentials for Pi's main model separately. Judgments are written to `$XDG_STATE_HOME/dsh-decision/pi-audit.jsonl`, or `~/.local/state/dsh-decision/pi-audit.jsonl` when XDG state is unset.

| Environment variable      | Default        | Purpose                                                         |
| ------------------------- | -------------- | --------------------------------------------------------------- |
| `AI_GATEWAY_API_KEY`      | None           | Vercel AI Gateway key; takes priority over `JEV_API_KEY`        |
| `JEV_API_KEY`             | None           | Fallback key; required for the `direct` backend                 |
| `PI_DECISION_JEV_BACKEND` | `vercel`       | `vercel` for Gateway; `direct` for `jev-ai.pro`                 |
| `PI_DECISION_ENFORCEMENT` | `shadow`       | `shadow` observes; `enforce` applies judgments (experimental)   |
| `PI_DECISION_TOOLS`       | All tools      | Comma-separated exact tool names, such as `bash,write`          |
| `PI_DECISION_ON_FAILURE`  | `allow`        | Stance when a judgment request fails: `allow`, `ask`, or `deny` |
| `PI_DECISION_OUTBOUND`    | `redact`       | Mask recognizable secret patterns; `raw` sends unchanged input  |
| `PI_DECISION_RISKS`       | None           | JSON custom risk dimensions, like dsh `guardrail.customRisks`   |
| `PI_DECISION_AUDIT`       | `on`           | Set to `off` to disable audit records                           |
| `PI_DECISION_AUDIT_PATH`  | XDG state path | Audit JSONL path                                                |

- [Integration and verification](https://github.com/yourtion/dsh-decision/blob/main/docs/integration.md#pi-接入) (Chinese)
- [Threshold evaluation](https://github.com/yourtion/dsh-decision/blob/main/docs/eval.md) (Chinese)
- [Repository README](https://github.com/yourtion/dsh-decision#readme)
