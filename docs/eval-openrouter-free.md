# OpenRouter 免费模型验证（2026-10-27）

已使用实际 `OpenRouterAdapter` 调用 `POST /api/alpha/decisions`，没有使用模拟返回。两个模型均完成 6 个样例 × 2 次重复，每次同时回答 binary、categorical、ordinal 三类题，共 **24 次请求、72 个答案**。

| 模型 ID                   | 协议通过 | 行为检查通过 | 确认零费用 | 请求延迟中位数 | 最大延迟 |
| ------------------------- | -------- | ------------ | ---------- | -------------- | -------- |
| `baseten/mammoth-1:free`  | 12/12    | 12/12        | 12/12      | 346.5 ms       | 11787 ms |
| `baseten/elephant-1:free` | 12/12    | 12/12        | 12/12      | 262 ms         | 431 ms   |

费用来自每次响应的 `usage.cost`，24 次合计 **$0**；所有调用前均检查实时目录的输入、输出 token 标价为零。执行时目录返回 29 个 Decisions 模型 ID，未使用已到期的 Mercury 免费版本。另有一次实施前的 Mammoth 原始协议探测，不计入上表，其报告费用同样为 0。网络请求时间包含客户端及传输开销，不等于模型计算延迟。

## 覆盖内容

- 中英文订阅取消、线上故障、普通咨询，均为合成数据。
- 条件判断概率以 0.5 区分正反例；类别必须命中预期部门；ordinal 期望得分与预设等级相差不超过 0.5。
- 所有答案先经过共享契约校验：精确答案键、题型、数值范围、分布完整性与总和、score 与分布的一致性；同时保留 confidence、模型实际版本及费用。
- 本地测试另外覆盖缺失或非法答案、拒答、缺失 confidence、超时与取消、HTTP 错误、模型限制，以及 dsh 注册/卸载和 Pi 脱敏、审计、失败处理。

这些是少量、明确样例的接入与行为验证。重复观察不是独立样本，没有验证真实工具风险策略、生产分布、概率校准、多模态能力或审批自动放行。没有据此更改现有风险阈值。Mammoth 的一次高延迟也说明免费端点不保证落在默认 8 秒内；验证脚本单次超时设为 30 秒。

## 复现

在仓库根目录构建后运行，设置可调用 OpenRouter 的 key：

```sh
pnpm install
pnpm run build
pnpm --filter @techs/dsh-decision-openrouter run verify:free --out /tmp/openrouter-free-results.json
```

脚本优先读取 `OPENROUTER_API_KEY`，否则读取 `DECISIONS_API_KEY`。云环境本次使用后者及 Node 24 的 `NODE_USE_ENV_PROXY=1`。脚本每次推理前重新检查零价格，只发送显式模型，不启用工具、自动重试或付费回退；报告费用非零或缺失时停止。

[固定样例](../packages/decision-openrouter/eval/fixtures.json) · [执行脚本](../packages/decision-openrouter/eval/verify-free.mjs) · [原始结果](../packages/decision-openrouter/eval/results-2026-10-27-free.json)
