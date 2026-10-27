# @techs/dsh-decision-openrouter

[English](README.md) | 简体中文

`OpenRouterAdapter` 实现核心的 `JudgmentProvider` 接口，调用 [OpenRouter Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request) 的 `/api/alpha/decisions`。多个模型共用一个适配器，通过 `model` 切换。

内部统一使用 `binary / categorical / ordinal`；适配器转换为 `noul / choice / score`，选项和等级写入 `criteria`，返回的 `answers` 对象映射为核心答案。OpenAI 的数组协议保持在 OpenAI 适配器内部。连接与用量类型、结果校验由核心共享；旧 `DecisionAdapter` 接口继续保留以兼容既有调用。

```ts
import { OpenRouterAdapter } from "@techs/dsh-decision-openrouter/provider";
import { resolveOpenRouterConfig } from "@techs/dsh-decision-openrouter/spec";

const adapter = new OpenRouterAdapter(
  resolveOpenRouterConfig({
    model: "baseten/elephant-1:free",
  }),
);
const result = await adapter.evaluate({
  state: { ticket: "请取消我的订阅。" },
  questions: {
    cancellation: { kind: "binary", instructions: "用户是否明确要求取消订阅？" },
  },
});
console.log(result.answers.cancellation);
```

`./provider` 与 `./spec` 不引入 Cordis/Schemastery 运行时依赖，也可使用工厂 `createOpenRouterProvider`。

| 设置            | 默认值                            | 含义                                               |
| --------------- | --------------------------------- | -------------------------------------------------- |
| `baseUrl`       | `https://openrouter.ai/api/alpha` | 追加 `/decisions`                                  |
| `apiKey`        | 无                                | 显式 key 优先于环境变量                            |
| `apiKeyEnv`     | `OPENROUTER_API_KEY`              | key 来源变量                                       |
| `model`         | 必填                              | 显式选择 Decisions 模型，不自动回退                |
| `timeoutMs`     | `8000`                            | 请求及读取响应体的总超时                           |
| `questionKinds` | 三种题型                          | 可限制为 `binary`、`categorical`、`ordinal` 的子集 |

输入沿用核心 JSON/文本 state，没有接入原生图片、音频或视频。`questionKinds` 是显式能力限制，不是实时模型发现；只支持二分类的模型可配置 `["binary"]`。具体模型的额外限制由端点校验，失败不会切到付费模型。

缺失、未声明、拒答、题型不匹配的答案会使整批失败。概率分布必须覆盖全部选项、总和在 `1 ± 0.001` 内；score 必须与等级索引的加权期望一致，允许舍入误差。保留原始概率和小数 score；缺失 confidence 不补成 0，也不拿最高选项概率代替。模型的请求名与实际版本分别保留，`provider` 始终为 `openrouter`。统一用量为 `inputTokens`、`outputTokens`、可选 `costUsd`。错误只显示状态和结构诊断，不回显请求内容；支持取消和总超时，不自动重试。

从仓库运行 Pi：

```sh
pnpm install
pnpm run build
export OPENROUTER_API_KEY=你的_key
export PI_DECISION_PROVIDER=openrouter
export PI_DECISION_OPENROUTER_MODEL=baseten/elephant-1:free
pi -e ./packages/pi-decision
```

可选 `PI_DECISION_OPENROUTER_BASE_URL`、`PI_DECISION_OPENROUTER_TIMEOUT_MS` 覆盖上表默认值。dsh 安装时核心 bundle 在前：

```sh
dsh plugin --profile web add ./packages/decision ./packages/decision-openrouter
dsh web
```

OpenRouter bundle 默认使用免费 Elephant、`provider: openrouter`、`enforcement: shadow` 和原生权限。既有 provider 插件未禁用或移除时，仍需要各自的 key。新包需发布后才能通过 npm 安装。适配器不声明自动审批资格。宿主继续使用既有脱敏与审计；直接调用者自行准备出站 state。

免费模型验证：

```sh
pnpm --filter @techs/dsh-decision-openrouter run verify:free --out /tmp/openrouter-free-results.json
```

脚本在每次推理前查询实时价格，拒绝非零或缺失价格，不发送工具和付费回退；响应费用非零或缺失时停止。默认 Mammoth、Elephant 两模型，6 个中英文样例各重复 2 次，共 24 次请求、72 个答案。优先读取 `OPENROUTER_API_KEY`，否则读取云环境的 `DECISIONS_API_KEY`。使用网络代理时需配置 fetch 传输；本次 Node 24 运行设置了 `NODE_USE_ENV_PROXY=1`。结果见[验证报告](../../docs/eval-openrouter-free.md)。
