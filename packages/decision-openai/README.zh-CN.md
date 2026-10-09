# @techs/dsh-decision-openai

[English](README.md) | 简体中文

为 `@techs/dsh-decision` 接入 [OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions)：调用 `POST /v1/decisions`，将原生 predicate、choice、score 映射为核心的 Binary、Categorical、Ordinal。协议依据 [API reference](https://developers.openai.com/api/reference/resources/decisions/methods/create)。

接口目前为 public beta，支持 `gpt-6-luna`。本包不声明机器审批自动放行资格；Jev 阈值需要在 OpenAI 上重新评估后才能用于 enforce。

| 配置        | 默认                        | 作用                                   |
| ----------- | --------------------------- | -------------------------------------- |
| `baseUrl`   | `https://api.openai.com/v1` | 含版本的 API 根地址，追加 `/decisions` |
| `apiKey`    | 无                          | 显式 key，优先于环境变量               |
| `apiKeyEnv` | `OPENAI_API_KEY`            | 保存 key 的环境变量名                  |
| `model`     | `gpt-6-luna`                | Decisions 模型，可用性由端点决定       |
| `timeoutMs` | `8000`                      | 请求及响应体总超时，需与核心超时协调   |

从源码构建并接入 dsh：

```sh
pnpm install
pnpm run build
export OPENAI_API_KEY=你的_OpenAI_key
dsh plugin --profile web add ./packages/decision ./packages/decision-openai
dsh web
```

OpenAI bundle 应排在核心 bundle 之后，默认选择 `provider: openai`、`enforcement: shadow`、`permission: native`。dsh patch 替换整行 `config`，自定义决策配置应完整写入后加载的 profile patch。已有 Jev profile 安装本包后仍会加载 Jev 插件并要求它的 key；不再使用时需关闭或移除该插件。仓库原有示例 profile 继续使用 Jev。新包尚需发布后才能从 npm 安装。

`./provider` 与 `./spec` 子路径不引入 Cordis/Schemastery 运行时：

```ts
import { createOpenAIProvider } from "@techs/dsh-decision-openai/provider";
import { resolveOpenAIConfig } from "@techs/dsh-decision-openai/spec";

const provider = createOpenAIProvider(resolveOpenAIConfig({}));
const result = await provider.evaluate({
  state: "Please cancel my subscription.",
  questions: {
    cancellation: { kind: "binary", instructions: "Does the customer request cancellation?" },
  },
});
console.log(result.answers.cancellation);
```

Binary 正反 criteria 追加到 predicate instructions；类别描述映射为 choice description；有序 rubric 字符串映射为 level label。概率数组转换为记录，保留 API 的小数期望 score 和独立 confidence。缺失、重复、未声明或拒答的答案会使整个批次失败；非法概率、不完整分布及与分布矛盾的 score 同样失败。分布和允许 `0.001` 舍入误差，不做归一化。请求模型和响应实际模型分别记录。

当前宿主契约传入 JSON/文本 state，序列化为文本，不传原生图片 part。宿主接入沿用既有出站脱敏；独立调用者自行准备 state。调用支持取消及总超时，不自动重试。错误仅暴露 HTTP 状态或结构诊断，不回显服务端错误体或 state。

pi 使用本仓库更新后的扩展：

```sh
export PI_DECISION_PROVIDER=openai
export OPENAI_API_KEY=你的_OpenAI_key
pi -e ./packages/pi-decision
```

详细配置和验证边界见[接入说明](https://github.com/yourtion/dsh-decision/blob/main/docs/integration.md#openai-decisions-api)。
