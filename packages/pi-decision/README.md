# @techs/pi-decision

pi 的 `tool_call` guardrail 扩展：把 Jev 的六维工具风险判断（destructive、secretExposure、privacyExposure、externalSideEffect、privilegeEscalation、scopeViolation，可加减自定义维度）接到每次工具调用前。agent 的主模型仍负责生成回复，pi 自身的权限规则继续生效。

```sh
pi install @techs/pi-decision
```

| 环境变量                  | 默认      | 作用                                                                  |
| ------------------------- | --------- | --------------------------------------------------------------------- |
| `AI_GATEWAY_API_KEY`      | 无        | Vercel AI Gateway key；与 `JEV_API_KEY` 同设时优先                    |
| `JEV_API_KEY`             | 无        | 后备 key；`direct` 后端必填                                           |
| `PI_DECISION_JEV_BACKEND` | `vercel`  | `vercel` 走 Gateway；`direct` 直连 `jev-ai.pro`                       |
| `PI_DECISION_ENFORCEMENT` | `shadow`  | `shadow` 异步观察不阻断；`enforce` 应用判定（实验特性，启动时打警告） |
| `PI_DECISION_TOOLS`       | 空=全部   | 逗号分隔的准确工具名，如 `bash,write`                                 |
| `PI_DECISION_ON_FAILURE`  | `allow`   | 判断请求失败时的策略：`allow` / `ask` / `deny`                        |
| `PI_DECISION_OUTBOUND`    | `redact`  | 出站脱敏：掩码密钥形态内容；`raw` 原样发出                            |
| `PI_DECISION_RISKS`       | 无        | 自定义风险维度（JSON，与 dsh `guardrail.customRisks` 同形）           |
| `PI_DECISION_AUDIT`       | `on`      | `off` 关闭审计记录                                                    |
| `PI_DECISION_AUDIT_PATH`  | XDG state | 审计 JSONL 路径（默认 `pi-audit.jsonl`）                              |

- [接入与验证](https://github.com/yourtion/dsh-decision/blob/main/docs/integration.md#pi-接入)
- [阈值评估方法](https://github.com/yourtion/dsh-decision/blob/main/docs/eval.md)
- [仓库根 README](https://github.com/yourtion/dsh-decision#readme)
