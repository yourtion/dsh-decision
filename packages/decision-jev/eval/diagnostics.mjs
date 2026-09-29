#!/usr/bin/env node
/** Cross-run diagnostics for a fixed repeated evaluation batch. */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defaultRiskDefinitions, evaluateGuardrailPolicy } from "@techs/dsh-decision/kernel";
import { validateRows } from "./eval-core.mjs";
import { prepareThresholdComparison } from "./compare-thresholds.mjs";

function range(values) {
  return values.length
    ? { count: values.length, min: Math.min(...values), max: Math.max(...values) }
    : { count: 0, min: null, max: null };
}

function action(row, risks) {
  return evaluateGuardrailPolicy(row.probabilities, risks, {
    unknownRisks: row.unknownRisks,
    authorizedExternalSideEffect: row.authorizedExternalSideEffect,
  }).action;
}

function labelDiagnostics(row, risks) {
  return Object.fromEntries(
    risks.map(({ key }) => {
      const expected = row.riskLabels?.[key];
      const score = row.probabilities[key];
      if (typeof expected !== "boolean" || row.unknownRisks?.includes(key)) {
        return [
          key,
          { expected: expected ?? null, score: score ?? null, prediction: null, error: null },
        ];
      }
      const prediction = score >= 0.5;
      return [key, { expected, score, prediction, error: prediction !== expected }];
    }),
  );
}

export function thresholdMargins(row, risks) {
  return Object.fromEntries(
    risks.map(({ key, reviewAt, denyAt }) => {
      const score = row.probabilities[key];
      return [
        key,
        score === undefined
          ? null
          : {
              score,
              reviewAt,
              denyAt,
              toReview: Number((score - reviewAt).toFixed(6)),
              toDeny: Number((score - denyAt).toFixed(6)),
              thresholdBand: score >= denyAt ? "high" : score >= reviewAt ? "review" : "low",
              decisionMargin: Number(
                Math.min(Math.abs(score - reviewAt), Math.abs(score - denyAt)).toFixed(6),
              ),
            },
      ];
    }),
  );
}

export function buildDiagnostics(stored, defaultRisks, candidateRisks) {
  if (!Array.isArray(stored.rows) || stored.rows.length === 0) {
    throw new Error("diagnostics require a non-empty results file");
  }
  const keys = defaultRisks.map((risk) => risk.key);
  validateRows(stored.rows, keys);
  const groups = new Map();
  for (const row of stored.rows) {
    const run = row.run;
    if (!Number.isInteger(run) || run < 1)
      throw new Error(`row ${row.id}: missing positive run number`);
    const signature = `${row.split}:${row.id}`;
    const current = groups.get(signature) ?? [];
    current.push(row);
    groups.set(signature, current);
  }
  const runs = [...new Set(stored.rows.map((row) => row.run))].toSorted((a, b) => a - b);
  const fixtures = [...new Set(stored.rows.map((row) => `${row.split}:${row.id}`))];
  const coverage = {
    rows: stored.rows.length,
    runs,
    fixtures: fixtures.length,
    everyFixtureEachRun: [...groups.entries()].every(([, rows]) =>
      runs.every((run) => rows.some((row) => row.run === run)),
    ),
    repeatedRowsPerFixture: [...groups.values()].map((rows) => rows.length),
  };
  if (
    !coverage.everyFixtureEachRun ||
    coverage.repeatedRowsPerFixture.some((count) => count !== runs.length)
  ) {
    throw new Error("results do not provide complete fixture coverage in every run");
  }

  const observations = stored.rows.map((row) => {
    const labels = labelDiagnostics(row, defaultRisks);
    return {
      id: row.id,
      split: row.split,
      run: row.run,
      expectedAction: row.expected,
      defaultAction: action(row, defaultRisks),
      candidateAction: action(row, candidateRisks),
      defaultActionError: action(row, defaultRisks) !== row.expected,
      candidateActionError: action(row, candidateRisks) !== row.expected,
      riskLabels: labels,
      defaultThresholdMargins: thresholdMargins(row, defaultRisks),
      candidateThresholdMargins: thresholdMargins(row, candidateRisks),
    };
  });
  const perRun = runs.map((run) => {
    const rows = stored.rows.filter((row) => row.run === run);
    const answers = observations.filter((row) => row.run === run);
    const labelItems = answers.flatMap((row) => Object.values(row.riskLabels));
    const scoredLabels = labelItems.filter((label) => label.error !== null);
    return {
      run,
      rows: rows.length,
      defaultActionErrors: answers
        .filter((row) => row.defaultActionError)
        .map(({ id, split, expectedAction, defaultAction }) => ({
          id,
          split,
          expected: expectedAction,
          actual: defaultAction,
        })),
      candidateActionErrors: answers
        .filter((row) => row.candidateActionError)
        .map(({ id, split, expectedAction, candidateAction }) => ({
          id,
          split,
          expected: expectedAction,
          actual: candidateAction,
        })),
      binaryLabelErrorsAtHalf: scoredLabels.filter((label) => label.error).length,
      binaryLabelCount: scoredLabels.length,
    };
  });
  const caseRanges = [...groups.entries()].map(([signature, rows]) => {
    const [split, id] = signature.split(":");
    const riskRanges = Object.fromEntries(
      keys.map((key) => {
        const scores = rows
          .map((row) => row.probabilities[key])
          .filter((score) => score !== undefined);
        const labels = rows
          .map((row) => row.riskLabels?.[key])
          .filter((label) => typeof label === "boolean");
        return [
          key,
          {
            scores: range(scores),
            factualLabel:
              labels.length && labels.every((label) => label === labels[0]) ? labels[0] : null,
            binaryLabelErrorsAtHalf: rows.filter(
              (row) => labelDiagnostics(row, defaultRisks)[key].error === true,
            ).length,
            defaultMargins: rows
              .map((row) => thresholdMargins(row, defaultRisks)[key])
              .filter(Boolean),
            candidateMargins: rows
              .map((row) => thresholdMargins(row, candidateRisks)[key])
              .filter(Boolean),
          },
        ];
      }),
    );
    return { id, split, observations: rows.length, risks: riskRanges };
  });
  return {
    rows: stored.rows.length,
    fixtureCount: fixtures.length,
    evaluation: stored.evaluation,
    coverage,
    perRun,
    caseRanges,
    observations,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [calibrationPath, validationPath, tuningPath, ...args] = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const output = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (!calibrationPath || !validationPath || !tuningPath || (outIndex >= 0 && !output)) {
    console.error(
      "usage: node eval/diagnostics.mjs <calibration-results.json> <validation-results.json> <calibration-proposal.json> [--out diagnostics.json]",
    );
    process.exit(1);
  }
  const calibration = JSON.parse(await readFile(calibrationPath, "utf8"));
  const validation = JSON.parse(await readFile(validationPath, "utf8"));
  if (JSON.stringify(calibration.evaluation) !== JSON.stringify(validation.evaluation)) {
    throw new Error("calibration and validation archives have different evaluation metadata");
  }
  const stored = {
    evaluation: calibration.evaluation,
    rows: [...calibration.rows, ...validation.rows],
  };
  const tuning = JSON.parse(await readFile(tuningPath, "utf8"));
  const { defaults: baseline, candidate } = prepareThresholdComparison(
    validation,
    tuning,
    defaultRiskDefinitions(),
  );
  const artifact = buildDiagnostics(stored, baseline, candidate);
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  if (output) await writeFile(output, json, { flag: "wx" });
  console.log(json);
}
