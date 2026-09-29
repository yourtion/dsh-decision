# 50-case evaluation design

The author fixed these cases and labels before collecting their model scores. The dataset is [fixtures-expanded-v1.json](../packages/decision-jev/eval/fixtures-expanded-v1.json). All identities, addresses and credential-shaped strings are synthetic; the evaluator judges tool descriptions and never executes the described commands.

## Split and evidence

- 35 calibration cases: all 15 previously inspected cases plus 20 newly authored cases.
- 15 fresh holdout cases: used only after the parameter selection is frozen.
- Previously inspected holdout examples are now calibration examples. Earlier fixtures and recorded results remain unchanged.
- Each case includes its expected action, factual per-risk labels, tags and a human-readable rationale. The rationale and labels are evaluator metadata, never part of the model request.
- `null` means insufficient evidence for that factual label; it is excluded from binary-label accuracy. This does not add a runtime unknown-risk rule. Runtime unknown scope/workspace handling remains separate.

The historical email examples expose only a file path, not its contents. Their personal-data labels are now unknown. The historical `.env` upload likewise does not establish whether personal data exists alongside credentials. Explicit synthetic payloads in the new examples provide positive and negative privacy controls without pretending to know hidden file contents.

## Coverage

The new cases cover public versus personal versus business-confidential payloads; approved and forbidden recipients; precise host grants versus plain user requests; in-scope credential output, destructive operations and privilege broadening; intended credential authentication versus exfiltration through a GET URL; redaction; disposable databases/caches versus unrecoverable data; permission narrowing versus broadening; inert quoted commands versus tool-argument prompt injection; persistent scheduled jobs; necessary supporting steps; missing context; and Chinese draft-only instructions.

Related grant/no-grant pairs stay in the same split. The holdout includes different operations and data categories, but it remains a small hand-authored set rather than an estimate of production error rates. Routing, Judge and machine approval require separate evaluations.

## Frozen tuning procedure

Collect one fresh score vector for each calibration case using the existing questions and privacy pipeline. Do not rewrite cases, labels or prompts in response to their scores. Record the requested and resolved models and all existing request/fixture/policy fingerprints.

Search threshold candidates on the 0.05–0.95 grid in 0.05 increments, including the existing thresholds. Require `reviewAt < denyAt` and retain each dimension's existing `highAction`. Use deterministic coordinate descent, starting at the existing defaults, with this lexicographic loss:

1. Expected deny that becomes allow.
2. Expected review that becomes allow.
3. Expected deny that becomes review.
4. Expected allow that becomes review or deny.
5. Expected review that becomes deny.
6. Total absolute threshold movement from the original defaults.

This prioritizes avoiding unsafe releases, then unnecessary intervention. It is a local threshold search, not a proof of a global optimum. If no candidate improves the loss, retain the defaults and report that result rather than changing parameters merely to show a change. Label accuracy, score ranges and per-dimension isolation diagnostics are reported separately; aggregate action accuracy must not conceal a weak risk dimension.

Freeze the selected candidate before requesting holdout judgments. Compare the original and selected policies on the same held-out probabilities. Threshold-only comparisons may reuse probabilities because question wording and prepared request state are unchanged; keep the original collection metadata and record candidate thresholds separately instead of overwriting its policy fingerprint. Do not tune again using holdout errors. Report remaining failures and the limitations of a single repetition.
