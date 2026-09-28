# @techs/dsh-decision-jev

English | [简体中文](https://github.com/yourtion/dsh-decision/blob/main/packages/decision-jev/README.zh-CN.md)

A Jev (TypeSafe System One wire) judgment provider for [@techs/dsh-decision](https://www.npmjs.com/package/@techs/dsh-decision). It registers with `ctx.decision` and supplies probability judgments to the guardrail, routing, result judge, and approval integration points. The HTTP client is small; a missing key fails when the plugin loads.

Jev is one implementation of the core's `JudgmentProvider` contract. Other structured probability models can use their own adapters; they do not need to implement this package's wire format.

| Setting     | Default                   | Purpose                                 |
| ----------- | ------------------------- | --------------------------------------- |
| `baseUrl`   | `https://api.typesafe.ai` | Requests go to `{baseUrl}/v1/systemone` |
| `apiKey`    | None                      | Literal key; alternative to `apiKeyEnv` |
| `apiKeyEnv` | None                      | Environment variable containing the key |
| `model`     | `jev-latest`              | Model for direct Jev access             |
| `timeoutMs` | `8000`                    | Per-request timeout                     |

For Vercel AI Gateway, use `baseUrl: https://ai-gateway.vercel.sh/typesafe`, `model: typesafe-ai/jev`, and `AI_GATEWAY_API_KEY`. The `./provider` and `./spec` exports do not depend on Cordis and can be used by hosts such as Pi. This adapter has no qualification for automatic approval, so machine approval will not automatically return `allowed-once`.

Install both dsh bundles:

```sh
export AI_GATEWAY_API_KEY=your_gateway_key
dsh plugin --profile web add @techs/dsh-decision @techs/dsh-decision-jev
dsh web
```

This bundle's patch configures the Gateway URL, model, and environment variable; the decision layer's bundle sets `shadow`. To use direct Jev access, override the `decision-jev` configuration in the profile's `cordis.patch.yml`.

- [Integration and verification](https://github.com/yourtion/dsh-decision/blob/main/docs/integration.md) (Chinese)
- [Threshold evaluation and calibration case study](https://github.com/yourtion/dsh-decision/blob/main/docs/eval.md) (Chinese; the evaluation tools are in `packages/decision-jev/eval/` and are not published)
- [Repository README](https://github.com/yourtion/dsh-decision#readme)
