# @techs/dsh-decision

[![CI](https://github.com/yourtion/dsh-decision/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/yourtion/dsh-decision/actions/workflows/ci.yml)
[![dsh npm version](https://img.shields.io/npm/v/%40techs%2Fdsh-decision?label=dsh)](https://www.npmjs.com/package/@techs/dsh-decision)
[![Pi npm version](https://img.shields.io/npm/v/%40techs%2Fpi-decision?label=pi)](https://www.npmjs.com/package/@techs/pi-decision)
[![MIT license](https://img.shields.io/github/license/yourtion/dsh-decision)](LICENSE)

English | [简体中文](README.zh-CN.md)

An extensible decision layer for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) and [Pi](https://pi.dev/docs/latest/extensions). The core turns structured probability judgments into deterministic actions using a shared six-dimension tool risk policy. [Jev](https://typesafe.ai) is the first judgment provider, not a requirement of the core. The agent's main model still generates responses.

## Judgment providers

The dsh core accepts models that can answer named, typed questions with structured probabilities. A provider implements `JudgmentProvider`, declares which question types it supports (binary, categorical, ordinal), registers with `ctx.decision`, and is selected by `decision.config.provider`. Each model or API protocol needs an adapter that maps its requests and answers to this contract. A model does not need to speak Jev's TypeSafe System One wire format.

This repository ships Jev and [OpenAI Decisions API](packages/decision-openai/README.md) adapters. The updated Pi extension selects either through `PI_DECISION_PROVIDER=jev|openai`, with Jev as the default. The OpenAI integration is available from this checkout; registry installation requires a release first. Thresholds calibrated on Jev do not transfer automatically to another model. Evaluate the new model and start in `shadow` before enabling enforcement. Pi currently implements the pre-tool-call guardrail only.

## Install published packages

Requires Node.js 22.19+ and a Vercel AI Gateway key. The key is for Jev judgments; configure the host's main model separately. The default `shadow` mode records judgments without changing tool execution. To call the official TypeSafe endpoint directly instead of the Gateway, set `PI_DECISION_JEV_BACKEND=direct` with `JEV_API_KEY` (Pi; a judgment takes ~20 s there) or override the bundle's `decision-jev.config` (dsh, see the integration guide).

**Pi:**

```sh
export AI_GATEWAY_API_KEY=your_gateway_key
pi install npm:@techs/pi-decision
```

**dsh** (into an existing `web` profile):

```sh
export AI_GATEWAY_API_KEY=your_gateway_key
dsh plugin --profile web add @techs/dsh-decision @techs/dsh-decision-jev
dsh web
```

The two dsh packages provide separate bundles for the decision layer and the Jev adapter. Installation adds both bundles to the profile. Restart an existing Web process after installing, and make the key available to that process. The bundles retain dsh's native permission mode and enable the tool guardrail by default. See the [integration guide](docs/integration.md) for a standalone `decision` profile and configuration options. That guide is currently in Chinese.

## Try Pi from this repository

For normal use, prefer the published packages above; this section runs the extension from a checkout. Requires Node.js 22.19+, pnpm, Pi, and a Vercel AI Gateway key. From the repository root:

```sh
pnpm install
pnpm run build
# Export AI_GATEWAY_API_KEY or JEV_API_KEY in the shell that starts Pi.
pi -e ./packages/pi-decision
```

`-e` loads the extension for one Pi process. After checking it, run `pi install ./packages/pi-decision` from the repository root to keep it installed. This local workspace installation needs the checkout and its dependency links to remain in place. By default, the extension calls `typesafe-ai/jev` through the [Vercel AI Gateway TypeSafe API](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe). It prefers `AI_GATEWAY_API_KEY`, then `JEV_API_KEY`.

Shadow mode evaluates tool calls asynchronously and does not block them. To reproduce a full call, use a main model for which Pi already has credentials:

```sh
pi -e ./packages/pi-decision --no-session --tools read \
  --provider zai-coding-cn --model glm-5.3-flash --print \
  'Use the read tool exactly once to read README.md, then reply with only its first Markdown heading.'
```

The example uses `zai-coding-cn/glm-5.3-flash`, the main model available during this repository's smoke test; replace it with one available to your Pi installation. A Jev key does not provide credentials for Pi's main model. In the early smoke test, the model called `read` once and answered correctly; the former thresholds marked that read for review. The expanded 50-case, three-repeat evaluation and current experimental thresholds are documented in the [latest report](docs/eval-2026-09-29-3x.md). Still start in shadow mode and inspect judgments on your own workloads. See the [integration and verification notes](docs/integration.md) for the original smoke test.

## Try dsh from this repository

For normal use, prefer the published packages above; this section runs the example profile from a checkout. Requires an installed dsh. The example [profile](profile/cordis.patch.yml) uses Vercel AI Gateway and reads **only `AI_GATEWAY_API_KEY`**. If your Gateway key is stored in `JEV_API_KEY`, export `AI_GATEWAY_API_KEY="$JEV_API_KEY"` in the shell starting dsh, or change the profile's `apiKeyEnv` setting.

```sh
pnpm install && pnpm run build
mkdir -p ~/.dsh/profiles
ln -s "$(pwd)/profile" ~/.dsh/profiles/decision
(cd profile && pnpm install)
dsh --profile decision 'List the files in this directory and count their lines'
```

The profile defaults to `enforcement: shadow`, so dsh's native permission rules still apply. It enables the tool guardrail and disables model routing and tool result judging by default. The profile also sets `permission: machine`, but the current Jev adapter has no qualification to approve requests automatically. An existing Web profile needs its own installation. The [integration guide](docs/integration.md#dsh-接入) covers Web setup, the verified paths, and direct Jev access.

## Repository layout

| Path                        | Purpose                                                  |
| --------------------------- | -------------------------------------------------------- |
| `packages/decision/`        | Host-neutral risk kernel and four dsh integration points |
| `packages/decision-jev/`    | Jev TypeSafe System One wire adapter                     |
| `packages/decision-openai/` | OpenAI native Decisions API adapter                      |
| `packages/pi-decision/`     | Pi `tool_call` guardrail extension                       |
| `profile/`                  | Example dsh profile                                      |

```sh
pnpm run typecheck # Build and check all four packages
pnpm run test      # Unit tests
pnpm run lint      # oxlint
pnpm run fmt       # oxfmt --check
```

The [design](docs/design.md), [v2 plan](docs/v2-plan.md), and [new decision tasks roadmap](docs/decision-tasks-roadmap.md) are currently in Chinese. The new roadmap documents integration research, task inputs, and evaluation gates for future development. `enforce` is experimental and emits a startup warning. Outbound state is locally redacted for recognizable secret patterns by default (`privacy.outbound: raw` sends it unchanged); unrecognized private data can still leave the host. Sanitized audit records go to `$XDG_STATE_HOME/dsh-decision/` (`pi-audit.jsonl` or `dsh-audit.jsonl`) and can be disabled with `audit.enabled: false` or `PI_DECISION_AUDIT=off`. See the [MIT license](LICENSE) and [changelog](CHANGELOG.md).

## Threshold calibration

Each of the six built-in risk dimensions can have its threshold or wording changed, or be disabled entirely. `guardrail.customRisks` (or `PI_DECISION_RISKS` in Pi) adds custom dimensions to the same judgment request and aggregation policy. Current defaults ask one factual question per risk with positive and negative criteria. The host can supply the user request, workspace root, environment, and a grant tied to the exact action; missing context leads to review where a risk cannot be judged. Outbound state uses the same redaction pipeline in production and live evaluation.

The experimental defaults now include the 2026-09-29 three-repeat update: `secretExposure` reviews at 0.48 and denies at 0.50; other thresholds are unchanged. On 50 fixed cases ×3, the original policy got 102/105 calibration actions correct and the selected policy got 105/105. Both policies got 45/45 on the previously inspected validation cases, which were excluded from tuning. These are repeated observations, not 150 independent examples. Secret score margins are only 0.01 and privacy scores still overlap, so keep `enforce` experimental. See the [archived evidence and reproducible commands](docs/eval-2026-09-29-3x.md).
