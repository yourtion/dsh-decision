#!/usr/bin/env node
/** Live and offline guardrail evaluation. Live requests use the runtime preparation pipeline. */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  defaultRiskDefinitions,
  evaluateGuardrailPolicy,
  resolveGuardrailRisks,
} from "@techs/dsh-decision/kernel";
import { createJevProvider } from "@techs/dsh-decision-jev/provider";
import { resolveJevConfig } from "@techs/dsh-decision-jev/spec";
import {
  assertCompatible,
  evaluationMetadata,
  fingerprint,
  normalizeFixture,
  prepareEvalRequest,
  RESULT_FORMAT,
  validateRows,
} from "./eval-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${name} needs a value`);
  return args[i + 1];
};
const replayPath = option("--replay");
const comparePath = option("--compare");
const allowIncompatible = args.includes("--allow-incompatible");
const split = option("--split") ?? "all";
if (!["all", "calibration", "holdout"].includes(split))
  throw new Error("--split must be all, calibration or holdout");
const repeats = Number(option("--repeat") ?? 1);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20)
  throw new Error("--repeat must be an integer from 1 to 20");
const delayMs = Number(process.env.EVAL_DELAY_MS ?? 400);
if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("EVAL_DELAY_MS must be nonnegative");
const risks = process.env.EVAL_RISKS
  ? resolveGuardrailRisks(JSON.parse(process.env.EVAL_RISKS)).risks
  : defaultRiskDefinitions();
const riskKeys = risks.map((risk) => risk.key);

function providerSpec() {
  if (process.env.AI_GATEWAY_API_KEY)
    return resolveJevConfig({
      apiKey: process.env.AI_GATEWAY_API_KEY,
      baseUrl: "https://ai-gateway.vercel.sh/typesafe",
      model: "typesafe-ai/jev",
    });
  if (process.env.JEV_API_KEY) return resolveJevConfig({ apiKey: process.env.JEV_API_KEY });
  throw new Error("set AI_GATEWAY_API_KEY or JEV_API_KEY for a live run");
}

async function withRetries(action, attempts = 4) {
  for (let i = 1; ; i += 1) {
    try {
      return await action();
    } catch (error) {
      if (i >= attempts || !/HTTP (429|5\d\d)/.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 3_000 * i));
    }
  }
}

function metrics(rows) {
  const counts = {
    allow: { allow: 0, review: 0, deny: 0 },
    review: { allow: 0, review: 0, deny: 0 },
    deny: { allow: 0, review: 0, deny: 0 },
  };
  let labelCorrect = 0;
  let labelTotal = 0;
  for (const row of rows) {
    counts[row.expected][
      evaluateGuardrailPolicy(row.probabilities, risks, {
        unknownRisks: row.unknownRisks,
        authorizedExternalSideEffect: row.authorizedExternalSideEffect,
      }).action
    ] += 1;
    for (const [key, expected] of Object.entries(row.riskLabels ?? {})) {
      if (expected === null || !riskKeys.includes(key) || row.unknownRisks?.includes(key)) continue;
      labelTotal += 1;
      if (row.probabilities[key] >= 0.5 === expected) labelCorrect += 1;
    }
  }
  const allow = rows.filter((row) => row.expected === "allow").length;
  const deny = rows.filter((row) => row.expected === "deny").length;
  return {
    counts,
    falseBlock: allow ? (counts.allow.review + counts.allow.deny) / allow : null,
    missDeny: deny ? counts.deny.allow / deny : null,
    binaryLabelAccuracy: labelTotal ? labelCorrect / labelTotal : null,
    binaryLabelCount: labelTotal,
  };
}

function printReport(rows) {
  for (const group of ["calibration", "holdout"]) {
    const subset = rows.filter((row) => (row.split ?? "calibration") === group);
    if (!subset.length) continue;
    const m = metrics(subset);
    const pct = (n) => (n === null ? "n/a" : `${(100 * n).toFixed(1)}%`);
    console.log(
      `\n${group}: ${subset.length} answers; falseBlock ${pct(m.falseBlock)}; missDeny ${pct(m.missDeny)}`,
    );
    console.log(
      `binary labels at 0.5: ${pct(m.binaryLabelAccuracy)} (${m.binaryLabelCount} labels; diagnostic only)`,
    );
    console.log("expected\\actual       allow review deny");
    for (const [expected, c] of Object.entries(m.counts)) {
      console.log(
        `${expected.padEnd(20)} ${String(c.allow).padStart(5)} ${String(c.review).padStart(6)} ${String(c.deny).padStart(4)}`,
      );
    }
  }
  console.log("\nThese labeled examples do not estimate production error rates.");
}

function compareRuns(current, baseline) {
  if (
    !current.evaluation?.fixtureFingerprint ||
    current.evaluation.fixtureFingerprint !== baseline.evaluation?.fixtureFingerprint
  ) {
    throw new Error("A/B comparison requires the same fingerprinted fixture set");
  }
  const byId = (rows) => Map.groupBy(rows, (row) => row.id);
  const a = byId(current.rows);
  const b = byId(baseline.rows);
  if (a.size !== b.size || [...a.keys()].some((id) => !b.has(id))) {
    throw new Error("A/B comparison requires matching fixture IDs");
  }
  console.log("\nA/B paired mean probability changes (current - baseline):");
  for (const key of riskKeys) {
    const deltas = [...a].flatMap(([id, group]) => {
      if (
        group.some((row) => row.probabilities[key] === undefined) ||
        b.get(id).some((row) => row.probabilities[key] === undefined)
      )
        return [];
      const mean = (items) =>
        items.reduce((sum, row) => sum + row.probabilities[key], 0) / items.length;
      return [mean(group) - mean(b.get(id))];
    });
    if (!deltas.length) {
      console.log(`  ${key}: n/a (no comparable pairs)`);
      continue;
    }
    const mean = deltas.reduce((sum, x) => sum + x, 0) / deltas.length;
    console.log(
      `  ${key}: ${mean >= 0 ? "+" : ""}${mean.toFixed(3)} across ${deltas.length} pairs`,
    );
  }
  console.log(
    "Interpret changed dimensions with repeated unchanged controls; a single pair cannot establish causal drift.",
  );
}

async function readResult(path) {
  const stored = JSON.parse(await readFile(path, "utf8"));
  validateRows(stored.rows, riskKeys);
  return stored;
}

const fixturePath = option("--fixtures") ?? join(here, "fixtures-contextual.json");
const fixtureSource = replayPath ? [] : JSON.parse(await readFile(fixturePath, "utf8"));
const fixtures = fixtureSource.map((fixture) => normalizeFixture(fixture, risks));
if (new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length)
  throw new Error("fixture IDs must be unique");
const selected = fixtureSource.filter(
  (_, index) => split === "all" || fixtures[index].split === split,
);
if (!replayPath && !selected.length) throw new Error(`no fixtures in ${split} split`);
const spec = replayPath ? undefined : providerSpec();
const metadata = evaluationMetadata(risks, fixtureSource, spec?.model);
let stored;

if (replayPath) {
  stored = await readResult(replayPath);
  const issues = assertCompatible(stored, metadata, allowIncompatible);
  if (issues.length) console.warn(`EXPLORATORY incompatible replay: ${issues.join("; ")}`);
} else {
  const provider = createJevProvider(spec);
  const rows = [];
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const output = option("--out") ?? join(here, `results-${stamp}.json`);
  const save = async (partial) =>
    writeFile(
      partial ? output.replace(/\.json$/, "-partial.json") : output,
      `${JSON.stringify({ formatVersion: RESULT_FORMAT, generatedAt: new Date().toISOString(), evaluation: metadata, rows }, null, 2)}\n`,
      { flag: "wx" },
    );
  try {
    for (let run = 1; run <= repeats; run += 1) {
      for (const fixture of selected) {
        if (rows.length) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const prepared = prepareEvalRequest(fixture, risks);
        const result = Object.keys(prepared.request.questions).length
          ? await withRetries(() => provider.evaluate(prepared.request))
          : { answers: {}, resolvedModel: undefined };
        const probabilities = Object.fromEntries(
          Object.keys(prepared.request.questions).map((key) => [
            key,
            result.answers[key].probability,
          ]),
        );
        rows.push({
          id: fixture.id,
          run,
          split: fixture.split ?? "calibration",
          expected: fixture.expected,
          riskLabels: fixture.riskLabels,
          tags: fixture.tags ?? [],
          requestFingerprint: fingerprint(prepared.request),
          redactions: prepared.redactions,
          unknownRisks: prepared.unknownRisks,
          authorizedExternalSideEffect: prepared.authorizedExternalSideEffect,
          requestedModel: spec.model,
          actualModel: result.resolvedModel ?? null,
          probabilities,
        });
        process.stderr.write(`evaluated ${fixture.id} run ${run}/${repeats}\n`);
      }
    }
  } catch (error) {
    if (rows.length) await save(true);
    throw error;
  }
  metadata.actualModels = [...new Set(rows.map((row) => row.actualModel).filter(Boolean))];
  stored = { formatVersion: RESULT_FORMAT, evaluation: metadata, rows };
  await save(false);
  console.log(`raw probabilities written to ${output}`);
}

printReport(stored.rows.filter((row) => split === "all" || (row.split ?? "calibration") === split));
if (comparePath) {
  const baseline = await readResult(comparePath);
  if (baseline.formatVersion !== RESULT_FORMAT || !baseline.evaluation) {
    throw new Error(
      "A/B baseline lacks evaluation metadata; historical results are not comparable",
    );
  }
  compareRuns(stored, baseline);
}
