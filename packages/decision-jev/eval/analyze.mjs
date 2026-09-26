#!/usr/bin/env node
/**
 * Threshold analysis over a stored eval results file (no API traffic).
 *
 * Reports, per risk dimension: the score range by expected label, whether the
 * dimension separates benign from dangerous use at all, and a margin-aware
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
import { defaultRiskDefinitions } from "@techs/dsh-decision/kernel";

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

const { rows } = JSON.parse(await readFile(resultsPath, "utf8"));
// Risk keys come from the results file, so custom-dimension runs analyze too;
// thresholds exist only where a default definition matches the key.
const DEFAULTS = defaultRiskDefinitions();
const KEYS = [...new Set(rows.flatMap((r) => Object.keys(r.probabilities)))];
const benign = rows.filter((r) => r.expected === "allow");
const counts = { allow: 0, review: 0, deny: 0 };
for (const r of rows) counts[r.expected] += 1;

function evaluate(t) {
  const c = {
    allow: { allow: 0, review: 0, deny: 0 },
    review: { allow: 0, review: 0, deny: 0 },
    deny: { allow: 0, review: 0, deny: 0 },
  };
  for (const r of rows) {
    let a = "allow";
    for (const k of KEYS) {
      const entry = t[k];
      if (!entry) continue;
      const p = r.probabilities[k];
      if (p >= entry.denyAt) {
        a = "deny";
        break;
      }
      if (p >= entry.reviewAt) a = "review";
    }
    c[r.expected][a] += 1;
  }
  return {
    c,
    falseBlock: counts.allow ? (c.allow.review + c.allow.deny) / counts.allow : null,
    miss: counts.deny ? c.deny.allow / counts.deny : null,
  };
}

function marginsOk(t) {
  for (const k of KEYS) {
    if (!t[k]) continue;
    for (const r of benign) {
      const p = r.probabilities[k];
      if (t[k].denyAt - MARGIN < p || t[k].reviewAt - MARGIN < p) return false;
    }
  }
  return true;
}

console.log(
  `fixtures: ${rows.length} (allow ${counts.allow}, review ${counts.review}, deny ${counts.deny}), margin ≥ ${MARGIN}\n`,
);
console.log("per-dimension separation (independent signal above the benign mass):");
console.log("  dimension              benignMax   first danger above   danger above benignMax");
for (const k of KEYS) {
  const benignMax = Math.max(...benign.map((r) => r.probabilities[k]));
  const danger = rows
    .filter((r) => r.expected !== "allow")
    .map((r) => r.probabilities[k])
    .sort((a, b) => a - b);
  const above = danger.filter((p) => p > benignMax);
  const first = above.length ? above[0].toFixed(2) : "—";
  console.log(
    `  ${k.padEnd(22)} ${benignMax.toFixed(2).padEnd(11)} ${first.padEnd(19)} ${above.length}/${danger.length}${above.length === 0 ? "   (no independent signal)" : ` (gap ${above.length ? (above[0] - benignMax).toFixed(2) : ""})`}`,
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
