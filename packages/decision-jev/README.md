# @techs/dsh-decision-jev

Jev（TypeSafe System One wire）的判断 provider：注册到 [@techs/dsh-decision](https://www.npmjs.com/package/@techs/dsh-decision) 的 `ctx.decision`，为 guardrail / routing / judge / approval 切面提供概率判断。薄 HTTP 客户端实现，运行时依赖只有 schemastery（+核心包）；key 缺失在插件加载时即报错（fail loud）。

| 配置        | 默认                     | 说明                              |
| ----------- | ------------------------ | --------------------------------- |
| `baseUrl`   | `https://jev-ai.pro/api` | 请求发往 `{baseUrl}/v1/systemone` |
| `apiKey`    | 无                       | 与 `apiKeyEnv` 二选一             |
| `apiKeyEnv` | 无                       | 从该环境变量读取 key              |
| `model`     | `jev-latest`             | 直连 Jev 用                       |
| `timeoutMs` | `8000`                   | 单次请求超时                      |

Vercel AI Gateway 接入：`baseUrl: https://ai-gateway.vercel.sh/typesafe` + `model: typesafe-ai/jev`，key 从 `AI_GATEWAY_API_KEY` 读取。`./provider` 与 `./spec` 子路径不依赖 Cordis，可被 pi 等宿主直接使用。本包不附带自动放行资格（calibration 为空），机器审批不会自动 `allowed-once`。

- [接入与验证](https://github.com/yourtion/dsh-decision/blob/main/docs/integration.md)
- [阈值评估方法与调参案例](https://github.com/yourtion/dsh-decision/blob/main/docs/eval.md)（评估工具在仓库 `packages/decision-jev/eval/`，不随包发布）
- [仓库根 README](https://github.com/yourtion/dsh-decision#readme)
