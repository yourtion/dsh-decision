# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `@techs/dsh-decision-openai`: a native OpenAI Decisions API provider for
  predicate, choice and score judgments, with per-question refusal handling,
  probability validation, cancellation, timeouts, separate model identities,
  host-neutral exports and a shadow-mode dsh bundle.
- Explicit Pi provider selection through `PI_DECISION_PROVIDER=jev|openai`,
  retaining Jev as the default and configuring OpenAI independently.
- OpenAI protocol, dsh registration lifecycle and Pi guardrail integration
  tests, plus English/Chinese setup documentation. The release workflow now
  includes the OpenAI package before Pi; npm Trusted Publisher setup is required
  for the new package before releasing.

## [0.2.0] - 2026-09-29

### Added

- Declared `license: MIT` in all three package manifests (the repository
  already ships an MIT `LICENSE`; npm metadata previously showed none).
- A 50-case guardrail dataset covering redaction, authorization, privacy,
  destructive actions, privilege boundaries and adversarial tool arguments;
  calibration-only threshold search, baseline-aware comparison tools, and
  archived single-run and three-repeat results with reproducible diagnostics.
- dsh bundle manifests and Gateway-ready patches for direct `dsh plugin add`
  installation of the decision layer and Jev adapter.
- npm discovery metadata, published-package quick starts, and ready-to-review
  community announcement drafts for the dsh and pi ecosystems.
- English repository and npm package READMEs, linked Chinese translations, and
  CI, npm version, and license badges on the repository README.
- Provider-neutral positioning across the READMEs and community drafts, with
  Jev described as the first adapter and Pi's current Jev binding made explicit.
- Tag-triggered release workflow (`release.yml`) that runs the full check
  suite, verifies the tag against all package versions, creates the GitHub
  release, and publishes the three packages in topological order via npm
  Trusted Publishers (OIDC) — no `NPM_TOKEN` — with per-package idempotent
  skips so partially failed runs can simply be re-run.
- Host-supplied decision context (user request, workspace root, environment,
  and grants bound to the exact action fingerprint); a risk that cannot be
  judged for missing context now resolves to review instead of a guess.
- Judge-side evaluation of tool results for prompt injection, usable secrets,
  and private data, with truncation reported back to the model.
- Contextual fixture set (`fixtures-contextual.json`) and an eval core with
  prompt/policy/privacy/state fingerprints; replay and analyze refuse stale
  results (exploratory re-scoring only via `--allow-incompatible`) and report
  calibration and holdout splits separately.
- 2026-09-28 calibration on the official TypeSafe endpoint (15 contextual
  cases ×3, raw file archived in git history): allow/review/deny all correct
  on calibration and holdout (false-block 0%, deny-miss 0%), five dimensions
  separated with gaps ≥0.68.

### Changed

- Experimental secret-exposure defaults now review at 0.48 and deny at 0.50
  (previously 0.55 / 0.85). In the 50-case three-repeat evaluation, this fixes
  two credential-output releases and one review instead of denial: calibration
  improves from 102/105 to 105/105, while the previously seen validation set
  remains 45/45. Other risk thresholds are unchanged. Score margins are only
  0.01 and privacy scores overlap; these results do not establish production
  accuracy. See `docs/eval-2026-09-29-3x.md` for the evidence and limitations.
- Upgraded pnpm from 10.17.1 to 11.27.1 (native publish with OIDC trusted
  publishing support); transitive build scripts are now explicitly declared
  under `allowBuilds` for pnpm 11's strict build-script policy.
- The Jev adapter now defaults to the official TypeSafe endpoint
  (`https://api.typesafe.ai`) with a 30s client timeout (a judgment takes
  ~20s there); jev-ai.pro is no longer referenced. The eval harness routes
  `JEV_API_KEY` to the official endpoint and honors `JEV_BASE_URL`/
  `JEV_MODEL` overrides.
- Reworked the six built-in risk questions to one factual question per risk
  with explicit positive and negative criteria; production and live
  evaluation now share the same outbound redaction pipeline.
- The archived 2026-09-26 calibration no longer backs the defaults (questions,
  context, authorization, and actions all changed since); defaults stay
  experimental until re-evaluated on live results, and the enforce warning
  now says exactly that.
- Documentation and package READMEs now lead with published-package
  installation and keep repository builds as the development path.

### Fixed

- Audit JSONL records can no longer interleave out of order: concurrent
  `appendFile` calls raced at the OS level (surfaced as a CI-only test
  failure); writes are now serialized in `record()` order, still
  fire-and-forget.
- The release workflow reads the pnpm version from `packageManager`, which
  requires `actions/checkout` to run before `pnpm/action-setup`; the step
  order now matches the CI workflow.

### Removed

- Superseded eval artifacts from the repository: the single-run 2026-09-29
  results and threshold search, the 15-case ×3 2026-09-28 results, and the
  derived 44k-line diagnostics dump (regenerable offline via
  `eval/diagnostics.mjs`; the single-run report is folded into the
  three-repeat report). Eval outputs are gitignored by default now; curated
  evidence files are whitelisted explicitly in `.gitignore`. Removed files
  stay retrievable from git history.

## [0.1.0] - 2026-09-26

### Added

- Initial release shape: `@techs/dsh-decision` (neutral judgment types,
  deterministic versioned policies, four dsh waterfall seams),
  `@techs/dsh-decision-jev` (TypeSafe System One wire adapter), and
  `@techs/pi-decision` (pi `tool_call` guardrail extension), plus the dsh
  example profile.
- User-defined guardrail dimensions: `guardrail.customRisks` (dsh) and
  `PI_DECISION_RISKS` (pi, same JSON shape) append custom binary risk
  dimensions to the built-in six — same aggregation rights, packed into the
  same single Jev request. Built-ins can now be disabled per dimension
  (`enabled: false`: not asked, not judged, not sent) and reworded
  (`instructions` override). Custom dimensions require explicit
  instructions and thresholds; reserved keys and inverted pairs fail loud.
- The guardrail policy version now hashes the whole effective dimension set
  — keys, thresholds, and question wording (guardrail-v2.1.0). Rewording a
  question changes judgments (see the externalSideEffect case study), so
  wording is part of policy identity; approval qualifications scoped to an
  older version no longer match.
- Outbound sanitizer: tool arguments, judged results, routing hints, and
  approval reasons are masked for credential-shaped content before leaving
  the host (`privacy.outbound: redact`, default; `raw` restores the previous
  send-as-is stance; `PI_DECISION_OUTBOUND` for pi).
- Audit trace: one sanitized JSONL record per judgment outcome (verdict,
  probabilities, policy version, redaction count, coarse error kind; never
  raw arguments), appended under `$XDG_STATE_HOME/dsh-decision/` and mirrored
  on the Cordis `decision/trace` event. dsh records carry the session id;
  pi writes its own audit file (`audit.path`, `PI_DECISION_AUDIT`,
  `PI_DECISION_AUDIT_PATH`).
- Guardrail threshold evaluation harness (`packages/decision-jev/eval`):
  hand-labeled fixtures, live Jev evaluation with stored raw probabilities
  (paced, with transient-failure retries and partial-result saves), offline
  replay, confusion report, a uniform-threshold Pareto sweep, and a
  margin-aware per-dimension analyzer emitting paste-ready thresholds
  (`eval`, `eval:replay`, `eval:analyze`; custom fixture sets via
  `--fixtures`). Methodology and the externalSideEffect case study in
  docs/eval.md.
- `enforce` startup warning on both hosts: thresholds are not calibrated.
- MIT license, this changelog, and a GitHub Actions CI workflow running
  build, typecheck, tests, lint, and format checks.

### Changed

- Rewrote the `externalSideEffect` guardrail question to pin its meaning to
  effects visible outside the session (workspace edits excluded): the first
  live eval scored ordinary workspace writes (0.74) above genuinely external
  actions (0.69–0.71). Re-evaluated and recalibrated all six thresholds as a
  pair with the wording: benign false blocks 75% → 0%, deny misses 0%, denies
  softened to review 2 → 0, margins ≥0.05. Question wording and thresholds
  are calibrated together — swapping the model or editing instructions
  requires a re-run (`pnpm run eval`, see docs/eval.md).
- Recalibrated the six default guardrail risk thresholds from the first live
  Jev evaluation (2026-09-26, 22 hand-labeled fixtures): benign false blocks
  75% → 0%, deny misses stay 0%. `enforce` stays flagged experimental until
  the fixture set grows.
- Writing decision traces into the dsh session event log is deferred: the
  session envelope's `ignorable` marker is required for out-of-repo event
  types, but `Session.append` exposes no way to set it, so audit persistence
  uses the JSONL file (session ids included for correlation) until upstream
  provides a supported channel.
