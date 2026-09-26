#!/usr/bin/env node
/**
 * Guardrail threshold evaluation harness (v2-plan Phase 5 groundwork).
 *
 * Live mode calls the real Jev provider for every fixture and stores the raw
 * per-dimension probabilities; replay mode recomputes verdicts and threshold
 * sweeps from a stored results file without any API traffic.
 *
 * Usage (after `pnpm run build` from the repository root):
 *   AI_GATEWAY_API_KEY=... node eval/run-eval.mjs                 # live, write results
 *   node eval/run-eval.mjs --replay eval/results-<date>.json      # offline sweep
 *   node eval/run-eval.mjs --fixtures my-fixtures.json            # custom fixture set
 * Live runs pace requests (EVAL_DELAY_MS, default 400ms).
 * EVAL_RISKS='{"customRisks":{...}}' evaluates a custom dimension set.
 *
 * The fixtures are a hand-labeled seed set, not a calibrated benchmark:
 * scores describe this set only and exist to make threshold drift visible.
 * Swapping the provider (env) or the fixture set is the intended workflow for
 * calibrating a different environment or model; see docs/eval.md.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildGuardrailRequest,
  defaultRiskDefinitions,
  evaluateGuardrailPolicy,
  resolveGuardrailRisks,
} from "@techs/dsh-decision/kernel";
import { createJevProvider } from "@techs/dsh-decision-jev/provider";
import { resolveJevConfig } from "@techs/dsh-decision-jev/spec";

const here = dirname(fileURLToPath(import.meta.url));

/** Effective dimensions evaluated and stored; EVAL_RISKS JSON swaps the set. */
const RISKS = process.env.EVAL_RISKS
  ? resolveGuardrailRisks(JSON.parse(process.env.EVAL_RISKS)).risks
  : defaultRiskDefinitions();
const RISK_KEYS = RISKS.map((risk) => risk.key);
const REPLAY = process.argv.includes("--replay");
const replayPath = REPLAY ? process.argv[process.argv.indexOf("--replay") + 1] : undefined;

function resolveProviderSpec() {
  if (process.env.AI_GATEWAY_API_KEY) {
    return resolveJevConfig({
      apiKey: process.env.AI_GATEWAY_API_KEY,
      baseUrl: "https://ai-gateway.vercel.sh/typesafe",
      model: "typesafe-ai/jev",
    });
  }
  if (process.env.JEV_API_KEY) {
    return resolveJevConfig({ apiKey: process.env.JEV_API_KEY });
  }
  throw new Error("set AI_GATEWAY_API_KEY (gateway) or JEV_API_KEY (direct) for a live run");
}

/** Pause between live calls; the eval is a calibration tool, not a load test. */
const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 400);

/** Transient gateway failures (rate limits and 5xx) are retried per fixture. */
async function withRetries(action, attempts = 4) {
  for (let i = 1; ; i += 1) {
    try {
      return await action();
    } catch (error) {
      if (i >= attempts || !/HTTP (429|5\d\d)/.test(String(error))) throw error;
      const backoff = 3_000 * i;
      process.stderr.write(
        `transient failure (${String(error).slice(0, 80)}), retrying in ${backoff}ms\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}

async function liveAnswers(fixtures, savePartial) {
  const provider = createJevProvider(resolveProviderSpec());
  const rows = [];
  try {
    for (const [index, fixture] of fixtures.entries()) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      const request = buildGuardrailRequest(fixture.tool, fixture.arguments, RISKS);
      const result = await withRetries(() => provider.evaluate(request));
      const probabilities = Object.fromEntries(
        RISK_KEYS.map((risk) => [risk, result.answers[risk].probability]),
      );
      rows.push({
        id: fixture.id,
        expected: fixture.expected,
        tags: fixture.tags ?? [],
        probabilities,
      });
      process.stderr.write(`evaluated ${fixture.id}\n`);
    }
  } catch (error) {
    // Keep what the gateway already answered; a truncated set still replays.
    savePartial(rows);
    throw error;
  }
  return rows;
}

async function replayAnswers(path) {
  const stored = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(stored.rows)) throw new Error("replay file has no rows array");
  return stored.rows;
}

function verdictOf(probabilities, risks) {
  return evaluateGuardrailPolicy(probabilities, risks);
}

function confusion(rows, risks) {
  const counts = {
    allow: { allow: 0, review: 0, deny: 0 },
    review: { allow: 0, review: 0, deny: 0 },
    deny: { allow: 0, review: 0, deny: 0 },
  };
  for (const row of rows) {
    counts[row.expected][verdictOf(row.probabilities, risks).action] += 1;
  }
  const expectedAllow = counts.allow.allow + counts.allow.review + counts.allow.deny;
  const expectedDeny = counts.deny.allow + counts.deny.review + counts.deny.deny;
  const expectedReview = counts.review.allow + counts.review.review + counts.review.deny;
  return {
    counts,
    falseBlockRate:
      expectedAllow === 0 ? null : (counts.allow.review + counts.allow.deny) / expectedAllow,
    missDenyRate: expectedDeny === 0 ? null : counts.deny.allow / expectedDeny,
    reviewLeakRate:
      expectedReview === 0 ? null : (counts.review.allow + counts.review.deny) / expectedReview,
    totals: { expectedAllow, expectedReview, expectedDeny },
  };
}

function sweep(rows) {
  const candidates = [];
  for (const reviewAt of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]) {
    for (const denyAt of [0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]) {
      if (reviewAt >= denyAt) continue;
      const risks = RISKS.map((risk) => ({ ...risk, reviewAt, denyAt }));
      const metrics = confusion(rows, risks);
      candidates.push({ reviewAt, denyAt, ...metrics });
    }
  }
  // Report the Pareto frontier: no other candidate is at least as good on
  // falseBlock and missDeny while strictly better on one of them.
  return candidates.filter(
    (a) =>
      !candidates.some(
        (b) =>
          b.falseBlockRate <= a.falseBlockRate &&
          b.missDenyRate <= a.missDenyRate &&
          (b.falseBlockRate < a.falseBlockRate || b.missDenyRate < a.missDenyRate),
      ),
  );
}

function reportCurrent(rows) {
  const current = confusion(rows, RISKS);
  console.log("\n== Current defaults (per-dimension) ==");
  console.log(
    `expected allow: ${current.totals.expectedAllow}, review: ${current.totals.expectedReview}, deny: ${current.totals.expectedDeny}`,
  );
  console.log(
    `false-block on benign: ${current.falseBlockRate === null ? "n/a" : `${(current.falseBlockRate * 100).toFixed(1)}%`}`,
  );
  console.log(
    `miss (allow on deny-expected): ${current.missDenyRate === null ? "n/a" : `${(current.missDenyRate * 100).toFixed(1)}%`}`,
  );
  console.log("confusion (rows=expected, cols=actual):    allow  review  deny");
  for (const [expected, counts] of Object.entries(current.counts)) {
    console.log(
      `  ${expected.padEnd(8)} ${String(counts.allow).padStart(10)} ${String(counts.review).padStart(7)} ${String(counts.deny).padStart(6)}`,
    );
  }
  console.log("\nmisjudged fixtures under defaults:");
  for (const row of rows) {
    const actual = verdictOf(row.probabilities, RISKS).action;
    if (actual !== row.expected) {
      const top = Object.keys(row.probabilities)
        .map((risk) => `${risk}=${row.probabilities[risk].toFixed(2)}`)
        .join(" ");
      console.log(`  ${row.id}: expected ${row.expected}, got ${actual} (${top})`);
    }
  }
}

const fixturesIndex = process.argv.indexOf("--fixtures");
const fixtureArg = fixturesIndex >= 0 ? process.argv[fixturesIndex + 1] : undefined;
const fixtures = JSON.parse(
  await readFile(fixtureArg ? fixtureArg : join(here, "fixtures.json"), "utf8"),
);
const outPath = join(here, `results-${new Date().toISOString().slice(0, 10)}.json`);
const saveResults = (rows, suffix = "") =>
  writeFile(
    join(here, `results-${new Date().toISOString().slice(0, 10)}${suffix}.json`),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2)}\n`,
  );
const rows = REPLAY
  ? await replayAnswers(replayPath)
  : await liveAnswers(fixtures, (partial) => void saveResults(partial, "-partial").catch(() => {}));

reportCurrent(rows);
console.log("\n== Uniform threshold Pareto frontier (all risks share reviewAt/denyAt) ==");
console.log("reviewAt denyAt  falseBlock  missDeny");
for (const c of sweep(rows)) {
  console.log(
    `  ${c.reviewAt.toFixed(2).padEnd(7)} ${c.denyAt.toFixed(2).padEnd(7)} ${(c.falseBlockRate * 100).toFixed(1).padStart(6)}%   ${(c.missDenyRate * 100).toFixed(1).padStart(6)}%`,
  );
}
console.log(
  "\nNote: hand-labeled seed fixtures, not a calibrated benchmark; numbers describe this set only.",
);

if (!REPLAY) {
  await saveResults(rows);
  console.log(`raw probabilities written to ${outPath}`);
}
