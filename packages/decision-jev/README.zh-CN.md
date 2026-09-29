# @techs/dsh-decision-jev

[English](README.md) | 简体中文

Jev（TypeSafe System One wire）的判断 provider：注册到 [@techs/dsh-decision](https://www.npmjs.com/package/@techs/dsh-decision) 的 `ctx.decision`，为 guardrail / routing / judge / approval 切面提供概率判断。薄 HTTP 客户端实现，运行时依赖只有 schemastery（+核心包）；key 缺失在插件加载时即报错（fail loud）。

Jev 只是核心 `JudgmentProvider` 接口的一个实现。其他能输出结构化概率的模型可以有各自的 adapter，无需兼容本包的 wire 格式。

| 配置        | 默认                      | 说明                              |
| ----------- | ------------------------- | --------------------------------- |
| `baseUrl`   | `https://api.typesafe.ai` | 请求发往 `{baseUrl}/v1/systemone` |
| `apiKey`    | 无                        | 与 `apiKeyEnv` 二选一             |
| `apiKeyEnv` | 无                        | 从该环境变量读取 key              |
| `model`     | `jev-latest`              | 直连 Jev 用                       |
| `timeoutMs` | `30000`                   | 单次请求超时                      |

Vercel AI Gateway 接入：`baseUrl: https://ai-gateway.vercel.sh/typesafe` + `model: typesafe-ai/jev`，key 从 `AI_GATEWAY_API_KEY` 读取。`./provider` 与 `./spec` 子路径不依赖 Cordis，可被 pi 等宿主直接使用。本包不附带自动放行资格（calibration 为空），机器审批不会自动 `allowed-once`。

与决策层一起安装到 dsh：

```sh
export AI_GATEWAY_API_KEY=你的_Gateway_key
dsh plugin --profile web add @techs/dsh-decision @techs/dsh-decision-jev
dsh web
```

本 bundle 的 patch 已配好 Gateway URL、模型和环境变量名；默认 `shadow` 由决策层 bundle 设置。若直连 Jev，需要在 profile 的 `cordis.patch.yml` 中覆盖 `decision-jev` 配置。

- [接入与验证](https://github.com/yourtion/dsh-decision/blob/main/docs/integration.md)
- [阈值评估方法与调参案例](https://github.com/yourtion/dsh-decision/blob/main/docs/eval.md)（评估工具在仓库 `packages/decision-jev/eval/`，不随包发布）
- [仓库根 README](https://github.com/yourtion/dsh-decision#readme)
