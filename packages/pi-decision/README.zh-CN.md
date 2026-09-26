# @techs/pi-decision

[English](README.md) | 简体中文

pi 的 `tool_call` guardrail 扩展：当前使用 Jev 判断工具调用前的六维风险（destructive、secretExposure、privacyExposure、externalSideEffect、privilegeEscalation、scopeViolation，可加减自定义维度）。风险策略来自 provider 无关的核心，但 pi 扩展目前直接创建 Jev provider；接入其他判断模型还需新增 adapter 和 pi 接入。agent 的主模型仍负责生成回复，pi 自身的权限规则继续生效。

```sh
export AI_GATEWAY_API_KEY=你的_Gateway_key
pi install npm:@techs/pi-decision
```

安装后默认以 `shadow` 模式异步观察，不拦截工具；pi 的主模型需要单独配置凭证。退出 pi 后可在 `$XDG_STATE_HOME/dsh-decision/pi-audit.jsonl` 查看判定（未设置 XDG 时用 `~/.local/state/dsh-decision/`）。

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
