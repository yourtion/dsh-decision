#!/usr/bin/env node
/** Compare a frozen threshold proposal on a separately collected holdout set. */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  defaultRiskDefinitions,
  evaluateGuardrailPolicy,
  guardrailPolicyVersion,
} from "@techs/dsh-decision/kernel";
import { assertCompatible, evaluationMetadata, validateRows } from "./eval-core.mjs";

export function summarize(rows, risks) {
  const counts = {
    allow: { allow: 0, review: 0, deny: 0 },
    review: { allow: 0, review: 0, deny: 0 },
    deny: { allow: 0, review: 0, deny: 0 },
  };
  const decisions = rows.map((row) => {
    const decision = evaluateGuardrailPolicy(row.probabilities, risks, {
      unknownRisks: row.unknownRisks,
      authorizedExternalSideEffect: row.authorizedExternalSideEffect,
    });
    counts[row.expected][decision.action] += 1;
    return { id: row.id, expected: row.expected, actual: decision.action, driver: decision.driver };
  });
  const allow = rows.filter((r) => r.expected === "allow").length;
  const deny = rows.filter((r) => r.expected === "deny").length;
  return {
    counts,
    falseBlock: allow ? (counts.allow.review + counts.allow.deny) / allow : null,
    missDeny: deny ? counts.deny.allow / deny : null,
    errors: decisions.filter((d) => d.expected !== d.actual),
    decisions,
  };
}

export function validationRoleCopy(role = "independent") {
  if (role === "independent") {
    return "independent holdout validation; not used for threshold selection";
  }
  if (role === "repeat-validation") {
    return "repeat validation of previously seen holdout fixtures; not fresh independent evidence and not used for threshold selection";
  }
  throw new Error(`unknown validation role: ${role}`);
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function prepareThresholdComparison(
  stored,
  tuning,
  defaultRisks = defaultRiskDefinitions(),
) {
  if (
    !Array.isArray(stored.rows) ||
    stored.rows.length === 0 ||
    stored.rows.some((row) => row.split !== "holdout")
  ) {
    throw new Error("holdout comparison requires only holdout rows");
  }
  const storedMeta = stored.evaluation ?? {};
  const tuningMeta = tuning.evaluation ?? {};
  for (const field of [
    "fixtureFingerprint",
    "promptFingerprint",
    "policyFingerprint",
    "privacyFingerprint",
    "stateSchema",
    "requestedModel",
    "actualModels",
  ]) {
    if (!same(storedMeta[field], tuningMeta[field])) {
      throw new Error(`calibration proposal and holdout differ in ${field}`);
    }
  }
  const keys = defaultRisks.map((risk) => risk.key);
  const validatePairs = (values, label) => {
    if (
      !values ||
      typeof values !== "object" ||
      Array.isArray(values) ||
      !same(Object.keys(values).toSorted(), keys.toSorted())
    ) {
      throw new Error(`${label} must contain exactly one threshold pair for each default risk`);
    }
    for (const key of keys) {
      const pair = values[key];
      if (
        !pair ||
        typeof pair !== "object" ||
        Array.isArray(pair) ||
        !same(Object.keys(pair).toSorted(), ["denyAt", "reviewAt"])
      ) {
        throw new Error(`${label} ${key} must contain only reviewAt and denyAt`);
      }
      if (
        typeof pair.reviewAt !== "number" ||
        typeof pair.denyAt !== "number" ||
        !Number.isFinite(pair.reviewAt) ||
        !Number.isFinite(pair.denyAt) ||
        pair.reviewAt < 0 ||
        pair.reviewAt >= pair.denyAt ||
        pair.denyAt > 1
      ) {
        throw new Error(`${label} has invalid thresholds for ${key}`);
      }
    }
  };
  validatePairs(tuning.defaults, "proposal defaults");
  validatePairs(tuning.candidate, "proposal candidate");
  const fixedHighAction = tuning.fixedHighAction;
  if (
    !fixedHighAction ||
    typeof fixedHighAction !== "object" ||
    Array.isArray(fixedHighAction) ||
    !same(Object.keys(fixedHighAction).toSorted(), keys.toSorted()) ||
    keys.some((key) => !["review", "deny"].includes(fixedHighAction[key]))
  ) {
    throw new Error("proposal must contain one valid fixed highAction per default risk");
  }
  const baseline = defaultRisks.map((risk) => ({
    ...risk,
    ...tuning.defaults[risk.key],
    highAction: fixedHighAction[risk.key],
  }));
  const baselineFingerprint = guardrailPolicyVersion(baseline);
  if (
    baselineFingerprint !== tuningMeta.policyFingerprint ||
    baselineFingerprint !== storedMeta.policyFingerprint
  ) {
    throw new Error(
      "proposal defaults and highActions do not reproduce the collection policy fingerprint",
    );
  }
  const issues = assertCompatible(
    stored,
    evaluationMetadata(baseline, [], storedMeta.requestedModel),
    false,
  );
  if (issues.length) throw new Error(`incompatible holdout results: ${issues.join("; ")}`);
  validateRows(stored.rows, keys);

  const candidate = baseline.map((risk) => ({ ...risk, ...tuning.candidate[risk.key] }));
  return { defaults: baseline, candidate, candidateThresholds: tuning.candidate };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [input, tuningPath, ...args] = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const output = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const roleIndex = args.indexOf("--validation-role");
  const validationRole = roleIndex >= 0 ? args[roleIndex + 1] : "independent";
  if (!input || !tuningPath || (outIndex >= 0 && !output) || (roleIndex >= 0 && !validationRole)) {
    console.error(
      "usage: node eval/compare-thresholds.mjs <holdout-results.json> <calibration-proposal.json> [--validation-role independent|repeat-validation] [--out comparison.json]",
    );
    process.exit(1);
  }
  const roleCopy = validationRoleCopy(validationRole);
  const stored = JSON.parse(await readFile(input, "utf8"));
  const tuning = JSON.parse(await readFile(tuningPath, "utf8"));
  const { defaults, candidate, candidateThresholds } = prepareThresholdComparison(stored, tuning);
  const artifact = {
    validationRole,
    evaluationRole: roleCopy,
    rows: stored.rows.length,
    fixtureFingerprint: stored.evaluation.fixtureFingerprint,
    calibrationProposal: tuningPath,
    requestedModel: stored.evaluation.requestedModel,
    actualModels: stored.evaluation.actualModels,
    thresholds: {
      defaults: Object.fromEntries(
        defaults.map((r) => [r.key, { reviewAt: r.reviewAt, denyAt: r.denyAt }]),
      ),
      candidate: candidateThresholds,
    },
    policyFingerprints: {
      defaults: guardrailPolicyVersion(defaults),
      candidate: guardrailPolicyVersion(candidate),
    },
    defaults: summarize(stored.rows, defaults),
    candidate: summarize(stored.rows, candidate),
    perRun: [...new Set(stored.rows.map((row) => row.run).filter(Number.isInteger))]
      .toSorted((a, b) => a - b)
      .map((run) => {
        const rows = stored.rows.filter((row) => row.run === run);
        return {
          run,
          rows: rows.length,
          defaults: summarize(rows, defaults),
          candidate: summarize(rows, candidate),
        };
      }),
  };
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  if (output) await writeFile(output, json, { flag: "wx" });
  console.log(json);
}
