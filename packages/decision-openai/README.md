# @techs/dsh-decision-openai

English | [简体中文](README.zh-CN.md)

An [OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions) provider for `@techs/dsh-decision`. It calls `POST /v1/decisions` and maps the native predicate, choice and score answers to the core's binary, categorical and ordinal judgments. This implementation follows the [API reference](https://developers.openai.com/api/reference/resources/decisions/methods/create).

The API is currently in public beta and supports `gpt-6-luna`. This package carries no calibration qualification for automatic approval. Jev's risk thresholds need separate evaluation on OpenAI before enforcement.

| Setting     | Default                     | Purpose                                                         |
| ----------- | --------------------------- | --------------------------------------------------------------- |
| `baseUrl`   | `https://api.openai.com/v1` | Versioned API root; appends `/decisions`                        |
| `apiKey`    | None                        | Literal key; takes precedence over the environment              |
| `apiKeyEnv` | `OPENAI_API_KEY`            | Environment variable holding the key                            |
| `model`     | `gpt-6-luna`                | Decisions model; availability is determined by the endpoint     |
| `timeoutMs` | `8000`                      | Covers request and response body; align with the core's timeout |

From a checkout, build first and install the two local bundles into a dsh profile:

```sh
pnpm install
pnpm run build
export OPENAI_API_KEY=your_openai_key
dsh plugin --profile web add ./packages/decision ./packages/decision-openai
dsh web
```

The OpenAI bundle must follow the core bundle. It selects `provider: openai`, `enforcement: shadow` and `permission: native`. dsh patches replace a row's entire `config`; put your full custom decision configuration in the profile's later patch. Installing into an existing Jev profile leaves its Jev plugin loaded and still requiring its key; disable or remove that plugin if it is no longer used. The repository's existing example profile continues to use Jev. Registry installation of this new package requires a release first.

The `./provider` and `./spec` exports have no Cordis or Schemastery runtime imports:

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

Binary criteria are appended to predicate instructions. Category descriptions become choice descriptions; ordinal rubric strings become level labels. Probability arrays are mapped to records, and fractional expected scores and separate confidence values are preserved. Missing, duplicate, unexpected or refused answers fail the whole batch, as do invalid probabilities, incomplete distributions, or scores inconsistent with their distributions. Distribution sums tolerate rounding up to `0.001`; values are not normalized. Requested and actual model identities stay separate.

The current host contract supplies JSON/text state. It is sent as text, not native image parts. Host integrations apply their existing outbound redaction; standalone callers must prepare their own state. Calls use cancellation and a total timeout, without automatic retries. Errors expose status or structural diagnostics, without provider error bodies or state text.

For Pi, use the updated extension from this checkout:

```sh
export PI_DECISION_PROVIDER=openai
export OPENAI_API_KEY=your_openai_key
pi -e ./packages/pi-decision
```

See [integration and verification](https://github.com/yourtion/dsh-decision/blob/main/docs/integration.md#openai-decisions-api) for configuration and validation limits.
