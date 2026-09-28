#!/usr/bin/env node
/**
 * Threshold analysis over a stored eval results file (no API traffic).
 *
 * Reports, per risk dimension: the score range by factual true/false labels,
 * whether the dimension separates those cases, and a margin-aware
 * threshold proposal found by coordinate descent from the current defaults.
 * Proposals keep deny-expected misses at zero (a deny that lands in `review`
 * is tolerated only up to --max-soft) and require every threshold to keep at
 * least --margin distance from any benign-expected score, so the result is
 * not knife-edge-fit to the fixture set.
 *
 * Usage:
 *   node eval/analyze.mjs eval/results-<date>.json [--margin 0.05] [--max-soft 2]
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  defaultRiskDefinitions,
  evaluateGuardrailPolicy,
  resolveGuardrailRisks,
} from "@techs/dsh-decision/kernel";
import { assertCompatible, evaluationMetadata, validateRows } from "./eval-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const resultsPath = args.find((a) => !a.startsWith("--"));
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const MARGIN = opt("margin", 0.05);
const MAX_SOFT = opt("max-soft", 2);

if (!resultsPath) {
  console.error("usage: node eval/analyze.mjs <results.json> [--margin 0.05] [--max-soft 2]");
  process.exit(1);
}

const stored = JSON.parse(await readFile(resultsPath, "utf8"));
const DEFAULTS = process.env.EVAL_RISKS
  ? resolveGuardrailRisks(JSON.parse(process.env.EVAL_RISKS)).risks
  : defaultRiskDefinitions();
const issues = assertCompatible(
  stored,
  evaluationMetadata(DEFAULTS, [], undefined),
  args.includes("--allow-incompatible"),
);
if (issues.length) console.warn(`EXPLORATORY incompatible analysis: ${issues.join("; ")}`);
validateRows(
  stored.rows,
  DEFAULTS.map((risk) => risk.key),
);
const rows = stored.rows.filter((row) => (row.split ?? "calibration") === "calibration");
const holdout = stored.rows.filter((row) => row.split === "holdout");
if (!rows.length)
  throw new Error("analysis needs calibration rows; holdout is reserved for validation");
// Risk keys come from the results file, so custom-dimension runs analyze too;
// thresholds exist only where a default definition matches the key.
const KEYS = [...new Set(rows.flatMap((r) => Object.keys(r.probabilities)))];
const benign = rows.filter((r) => r.expected === "allow");
const counts = { allow: 0, review: 0, deny: 0 };
for (const r of rows) counts[r.expected] += 1;

function evaluate(t, sample = rows) {
  const c = {
    allow: { allow: 0, review: 0, deny: 0 },
    review: { allow: 0, review: 0, deny: 0 },
    deny: { allow: 0, review: 0, deny: 0 },
  };
  for (const r of sample) {
    const configured = DEFAULTS.map((risk) => ({ ...risk, ...t[risk.key] }));
    const a = evaluateGuardrailPolicy(r.probabilities, configured, {
      unknownRisks: r.unknownRisks,
      authorizedExternalSideEffect: r.authorizedExternalSideEffect,
    }).action;
    c[r.expected][a] += 1;
  }
  const allowCount = sample.filter((r) => r.expected === "allow").length;
  const denyCount = sample.filter((r) => r.expected === "deny").length;
  return {
    c,
    falseBlock: allowCount ? (c.allow.review + c.allow.deny) / allowCount : null,
    miss: denyCount ? c.deny.allow / denyCount : null,
  };
}

function labelApplies(row, key) {
  return typeof row.riskLabels?.[key] === "boolean";
}

function contributesToFalseMargin(row, key) {
  return (
    labelApplies(row, key) &&
    row.riskLabels[key] === false &&
    !(key === "externalSideEffect" && row.authorizedExternalSideEffect === true)
  );
}

function marginsOk(t) {
  for (const k of KEYS) {
    if (!t[k]) continue;
    for (const r of rows.filter((row) => contributesToFalseMargin(row, k))) {
      const p = r.probabilities[k];
      if (p !== undefined && (t[k].denyAt - MARGIN < p || t[k].reviewAt - MARGIN < p)) return false;
    }
  }
  return true;
}

console.log(
  `fixtures: ${rows.length} (allow ${counts.allow}, review ${counts.review}, deny ${counts.deny}), margin ≥ ${MARGIN}\n`,
);
console.log("per-dimension separation (factual true/false labels; null labels omitted):");
console.log("  dimension              falseMax    first true above   true above falseMax");
for (const k of KEYS) {
  const falseScores = rows
    .filter((r) => labelApplies(r, k) && r.riskLabels[k] === false)
    .map((r) => r.probabilities[k])
    .filter((p) => p !== undefined);
  const trueScores = rows
    .filter((r) => labelApplies(r, k) && r.riskLabels[k] === true)
    .map((r) => r.probabilities[k])
    .filter((p) => p !== undefined)
    .sort((a, b) => a - b);
  const falseMax = falseScores.length ? Math.max(...falseScores) : undefined;
  const above = falseMax === undefined ? [] : trueScores.filter((p) => p > falseMax);
  const first = above.length ? above[0].toFixed(2) : "—";
  const maxLabel = falseMax === undefined ? "n/a" : falseMax.toFixed(2);
  console.log(
    `  ${k.padEnd(22)} ${maxLabel.padEnd(11)} ${first.padEnd(19)} ${above.length}/${trueScores.length}${above.length === 0 ? "   (no independent signal)" : ` (gap ${(above[0] - falseMax).toFixed(2)})`}`,
  );
}

const show = (name, t) => {
  const { c, falseBlock, miss } = evaluate(t);
  console.log(
    `\n${name}: falseBlock ${falseBlock === null ? "n/a" : `${(falseBlock * 100).toFixed(0)}%`}, missDeny ${miss === null ? "n/a" : `${(miss * 100).toFixed(0)}%`}, deny→review ${c.deny.review}, review→deny ${c.review.deny}`,
  );
};

const defaultsMap = Object.fromEntries(
  DEFAULTS.filter((d) => KEYS.includes(d.key)).map((d) => [
    d.key,
    { reviewAt: d.reviewAt, denyAt: d.denyAt },
  ]),
);
show("current defaults", defaultsMap);

const grid = [
  0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95,
];
let t = structuredClone(defaultsMap);
for (let round = 0; round < 12; round += 1) {
  let best = null;
  const current = evaluate(t);
  for (const k of Object.keys(t)) {
    for (const reviewAt of grid) {
      for (const denyAt of grid) {
        if (reviewAt >= denyAt) continue;
        const cand = { ...t, [k]: { reviewAt, denyAt } };
        if (!marginsOk(cand)) continue;
        const { c, falseBlock, miss } = evaluate(cand);
        if (miss !== 0 || c.deny.review > MAX_SOFT) continue;
        if (falseBlock < current.falseBlock - 1e-9 && (!best || falseBlock < best.falseBlock)) {
          best = { falseBlock, k, reviewAt, denyAt };
        }
      }
    }
  }
  if (!best) break;
  t[best.k] = { reviewAt: best.reviewAt, denyAt: best.denyAt };
}

show("margin-aware proposal", t);
if (holdout.length) {
  const result = evaluate(t, holdout);
  console.log(
    `holdout check (${holdout.length} rows, not used to propose thresholds): ${JSON.stringify(result.c)}`,
  );
}
console.log("\npaste-ready config:");
console.log("risks:");
for (const k of Object.keys(t)) {
  console.log(`  ${k}: { reviewAt: ${t[k].reviewAt}, denyAt: ${t[k].denyAt} }`);
}
const uncovered = KEYS.filter((k) => !t[k]);
if (uncovered.length) {
  console.log(
    `\nno default thresholds for: ${uncovered.join(", ")} — custom dimensions keep their configured values; use the separation report to tune them.`,
  );
}
console.log(
  "\nnote: seed-set numbers; grow the fixtures before trusting a change, and prefer gaps over knife edges.",
);
