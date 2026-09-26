# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
