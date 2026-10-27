# @techs/dsh-decision-openrouter

English | [简体中文](README.zh-CN.md)

`OpenRouterAdapter` implements the core `JudgmentProvider` interface using [OpenRouter Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request). It calls `/api/alpha/decisions`. Multiple models share this adapter; select a model ID through configuration.

| Internal contract                              | OpenRouter wire format                           |
| ---------------------------------------------- | ------------------------------------------------ |
| `state`, named question record                 | `state`, named `questions` object                |
| `binary`                                       | `noul`, optional true/false criteria             |
| `categorical`                                  | `choice`, options in `criteria`                  |
| `ordinal`                                      | `score`, rubric in `criteria`                    |
| Named answers                                  | `answers` object, never an array                 |
| `usage.inputTokens`, `outputTokens`, `costUsd` | `input_tokens`, `output_tokens`, optional `cost` |

Jev, OpenAI and OpenRouter use the core's binary/categorical/ordinal vocabulary. Connection types, optional usage and validation are shared. Native OpenAI arrays and OpenRouter objects stay inside their respective adapters. The older `DecisionAdapter` vocabulary is retained for compatibility, not used for this new provider.

```ts
import { OpenRouterAdapter } from "@techs/dsh-decision-openrouter/provider";
import { resolveOpenRouterConfig } from "@techs/dsh-decision-openrouter/spec";

const adapter = new OpenRouterAdapter(
  resolveOpenRouterConfig({
    model: "baseten/elephant-1:free",
  }),
);
const result = await adapter.evaluate({
  state: { ticket: "Please cancel my subscription." },
  questions: {
    cancellation: { kind: "binary", instructions: "Does the customer request cancellation?" },
  },
});
console.log(result.answers.cancellation);
```

The `./provider` and `./spec` exports have no Cordis or Schemastery runtime imports. `createOpenRouterProvider` is also available as a factory. Model selection is explicit: the resolver has no default model or paid fallback.

| Setting         | Default                           | Purpose                                                       |
| --------------- | --------------------------------- | ------------------------------------------------------------- |
| `baseUrl`       | `https://openrouter.ai/api/alpha` | Appends `/decisions`                                          |
| `apiKey`        | None                              | Explicit key overrides environment                            |
| `apiKeyEnv`     | `OPENROUTER_API_KEY`              | Key variable name                                             |
| `model`         | Required                          | OpenRouter Decisions model ID                                 |
| `timeoutMs`     | `8000`                            | Total request and response-body timeout                       |
| `questionKinds` | All three                         | Restrict a model to `binary`, `categorical`, and/or `ordinal` |

The core supplies JSON/text evidence; this adapter does not accept native image/audio/video inputs. `questionKinds` is an explicit capability restriction, not live model discovery. Models can impose additional limits; unsupported requests fail rather than falling back to another model. For a binary-only endpoint, configure `questionKinds: ["binary"]`.

Missing, unexpected, refused or mismatched answers fail the batch. Distributions must cover all declared options and sum to 1 within `0.001`; ordinal scores must match their probability-weighted indices within rounding tolerance. Values are preserved without normalization. Optional confidence stays absent when omitted and is never inferred from a winning probability. Requested and resolved models remain distinct, and `provider` stays `openrouter` even when the upstream reports `BaseTen` or another provider. Cancellation covers stalled response bodies; HTTP errors expose status without echoing request data. No automatic retry is performed.

From a checkout, build and select the adapter in Pi:

```sh
pnpm install
pnpm run build
export OPENROUTER_API_KEY=your_key
export PI_DECISION_PROVIDER=openrouter
export PI_DECISION_OPENROUTER_MODEL=baseten/elephant-1:free
pi -e ./packages/pi-decision
```

Optional `PI_DECISION_OPENROUTER_BASE_URL` and `PI_DECISION_OPENROUTER_TIMEOUT_MS` override the defaults above. For dsh, install the local bundles in order:

```sh
dsh plugin --profile web add ./packages/decision ./packages/decision-openrouter
dsh web
```

The OpenRouter bundle selects the free Elephant model, `provider: openrouter`, `enforcement: shadow` and native permissions. Existing provider plugins still require their own credentials until disabled or removed. For registry installation, use version `0.2.1` or newer of both the core and adapter. This provider has no calibration qualification for machine approval. Existing host redaction and auditing apply; standalone callers must prepare their own outbound state.

Run the synthetic live checks with a freshly verified zero-price model:

```sh
pnpm --filter @techs/dsh-decision-openrouter run verify:free --out /tmp/openrouter-free-results.json
```

The script checks live catalog prices before every inference request, sends no paid fallback or tools, and stops if reported cost is nonzero or unavailable. It defaults to Mammoth and Elephant, six bilingual fixtures and two repeats (24 requests, 72 answers). It uses `OPENROUTER_API_KEY`, or the managed environment's `DECISIONS_API_KEY` when the former is absent. Proxy-based environments should configure their fetch transport (the recorded Node 24 run used `NODE_USE_ENV_PROXY=1`). See the [archived report](../../docs/eval-openrouter-free.md) for results and limits.
