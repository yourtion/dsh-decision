#!/usr/bin/env node
/** Deterministic calibration-only threshold proposal over stored probabilities. */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  defaultRiskDefinitions,
  evaluateGuardrailPolicy,
  resolveGuardrailRisks,
} from "@techs/dsh-decision/kernel";
import { assertCompatible, evaluationMetadata, validateRows } from "./eval-core.mjs";

export const TUNER_VERSION = "lexicographic-coordinate-descent-v1";
export const GRID = Array.from({ length: 19 }, (_, i) => Number(((i + 1) * 0.05).toFixed(2)));

function matrix(rows, risks, thresholds) {
  const counts = {
    allow: { allow: 0, review: 0, deny: 0 },
    review: { allow: 0, review: 0, deny: 0 },
    deny: { allow: 0, review: 0, deny: 0 },
  };
  const decisions = [];
  for (const row of rows) {
    const configured = risks.map((risk) => ({ ...risk, ...thresholds[risk.key] }));
    const decision = evaluateGuardrailPolicy(row.probabilities, configured, {
      unknownRisks: row.unknownRisks,
      authorizedExternalSideEffect: row.authorizedExternalSideEffect,
    });
    counts[row.expected][decision.action] += 1;
    decisions.push({
      id: row.id,
      expected: row.expected,
      actual: decision.action,
      driver: decision.driver,
    });
  }
  return { counts, decisions };
}

function loss(counts, thresholds, defaults) {
  return [
    counts.deny.allow,
    counts.review.allow,
    counts.deny.review,
    counts.allow.review + counts.allow.deny,
    counts.review.deny,
    Object.keys(defaults).reduce(
      (sum, key) =>
        sum +
        Math.abs(thresholds[key].reviewAt - defaults[key].reviewAt) +
        Math.abs(thresholds[key].denyAt - defaults[key].denyAt),
      0,
    ),
  ];
}

function compareLoss(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] < b[i] - 1e-10) return -1;
    if (a[i] > b[i] + 1e-10) return 1;
  }
  return 0;
}

function thresholdMap(risks) {
  return Object.fromEntries(risks.map((r) => [r.key, { reviewAt: r.reviewAt, denyAt: r.denyAt }]));
}

function range(xs) {
  return xs.length
    ? { count: xs.length, min: Math.min(...xs), max: Math.max(...xs) }
    : { count: 0, min: null, max: null };
}

function scoreRanges(rows, risks) {
  return Object.fromEntries(
    risks.map(({ key }) => {
      const groups = { true: [], false: [] };
      let unknown = 0;
      for (const row of rows) {
        const label = row.riskLabels?.[key];
        const score = row.probabilities[key];
        if (typeof label !== "boolean" || score === undefined) {
          unknown += 1;
          continue;
        }
        groups[String(label)].push(score);
      }
      return [
        key,
        { false: range(groups.false), true: range(groups.true), unlabeledOrUnscored: unknown },
      ];
    }),
  );
}

/**
 * Optimize only calibration rows. A row with any split other than calibration
 * is rejected so holdout scores cannot enter parameter selection by accident.
 */
export function calibrateRows(rows, risks = defaultRiskDefinitions()) {
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error("calibration needs non-empty rows");
  const forbidden = rows.filter((row) => row.split !== "calibration");
  if (forbidden.length)
    throw new Error(
      `calibration refuses non-calibration rows: ${forbidden.map((r) => r.id).join(", ")}`,
    );
  const keys = risks.map((r) => r.key);
  validateRows(rows, keys);
  const defaults = thresholdMap(risks);
  let thresholds = structuredClone(defaults);
  const initial = matrix(rows, risks, thresholds);
  const initialLoss = loss(initial.counts, thresholds, defaults);
  const candidates = [
    ...new Set([...GRID, ...Object.values(defaults).flatMap((t) => [t.reviewAt, t.denyAt])]),
  ].toSorted((a, b) => a - b);

  for (let round = 0; round < 100; round += 1) {
    let bestThresholds = thresholds;
    let bestLoss = loss(matrix(rows, risks, thresholds).counts, thresholds, defaults);
    for (const risk of risks) {
      const key = risk.key;
      for (const reviewAt of candidates) {
        for (const denyAt of candidates) {
          if (reviewAt >= denyAt) continue;
          const candidateThresholds = { ...thresholds, [key]: { reviewAt, denyAt } };
          const candidateMatrix = matrix(rows, risks, candidateThresholds);
          const candidateLoss = loss(candidateMatrix.counts, candidateThresholds, defaults);
          if (compareLoss(candidateLoss, bestLoss) < 0) {
            bestThresholds = candidateThresholds;
            bestLoss = candidateLoss;
          }
        }
      }
    }
    if (bestThresholds === thresholds) break;
    thresholds = bestThresholds;
    if (round === 99) throw new Error("coordinate descent did not converge");
  }

  const final = matrix(rows, risks, thresholds);
  const finalLoss = loss(final.counts, thresholds, defaults);
  const improved = compareLoss(finalLoss, initialLoss) < 0;
  if (!improved) thresholds = structuredClone(defaults);
  const chosen = matrix(rows, risks, thresholds);
  const chosenLoss = loss(chosen.counts, thresholds, defaults);
  const errors = chosen.decisions.filter((d) => d.expected !== d.actual);
  return {
    tunerVersion: TUNER_VERSION,
    rows: rows.length,
    defaults,
    candidate: thresholds,
    fixedHighAction: Object.fromEntries(risks.map((risk) => [risk.key, risk.highAction ?? "deny"])),
    changed: JSON.stringify(defaults) !== JSON.stringify(thresholds),
    loss: { defaults: initialLoss, candidate: chosenLoss },
    metrics: {
      defaults: {
        counts: initial.counts,
        errors: initial.decisions.filter((d) => d.expected !== d.actual),
      },
      candidate: { counts: chosen.counts, errors },
    },
    scoreRanges: scoreRanges(rows, risks),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const input = args.find((x) => !x.startsWith("--"));
  const outIndex = args.indexOf("--out");
  const output = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (!input || (outIndex >= 0 && !output)) {
    console.error(
      "usage: node eval/calibrate.mjs <calibration-results.json> [--out proposal.json]",
    );
    process.exit(1);
  }
  const stored = JSON.parse(await readFile(input, "utf8"));
  const risks = process.env.EVAL_RISKS
    ? resolveGuardrailRisks(JSON.parse(process.env.EVAL_RISKS)).risks
    : defaultRiskDefinitions();
  const issues = assertCompatible(
    stored,
    evaluationMetadata(risks, [], stored.evaluation?.requestedModel),
    false,
  );
  if (issues.length) throw new Error(`incompatible results: ${issues.join("; ")}`);
  const proposal = calibrateRows(stored.rows, risks);
  const artifact = {
    ...proposal,
    input: input,
    evaluation: {
      fixtureFingerprint: stored.evaluation.fixtureFingerprint,
      promptFingerprint: stored.evaluation.promptFingerprint,
      policyFingerprint: stored.evaluation.policyFingerprint,
      privacyFingerprint: stored.evaluation.privacyFingerprint,
      stateSchema: stored.evaluation.stateSchema,
      requestedModel: stored.evaluation.requestedModel,
      actualModels: stored.evaluation.actualModels,
    },
  };
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  if (output) await writeFile(output, json, { flag: "wx" });
  console.log(json);
}
