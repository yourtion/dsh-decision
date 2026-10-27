/** Synthetic live smoke test; always checks the catalog's price before calling a model. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { OpenRouterAdapter } from "../lib/provider.js";
import { resolveOpenRouterConfig } from "../lib/spec.js";

const { values } = parseArgs({
  options: {
    models: { type: "string", default: "baseten/mammoth-1:free,baseten/elephant-1:free" },
    repeat: { type: "string", default: "2" },
    out: { type: "string" },
  },
});
const repeat = Number(values.repeat);
assert(
  Number.isSafeInteger(repeat) && repeat > 0 && repeat <= 10,
  "repeat must be an integer from 1 to 10",
);
const models = [
  ...new Set(
    values.models
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean),
  ),
];
assert(models.length > 0 && models.length <= 5, "choose between 1 and 5 models");
// Resolve credentials before the run, without printing their values.
const apiKeyEnv = process.env.OPENROUTER_API_KEY ? "OPENROUTER_API_KEY" : "DECISIONS_API_KEY";
const fixtures = JSON.parse(await readFile(new URL("./fixtures.json", import.meta.url), "utf8"));
const questions = {
  cancellation: {
    kind: "binary",
    instructions: "Does the customer explicitly request cancellation of their subscription?",
    criteria: {
      true: "An explicit request to cancel the subscription.",
      false: "No subscription cancellation is requested.",
    },
  },
  department: {
    kind: "categorical",
    instructions: "Which department should handle this ticket?",
    options: {
      billing: "Subscription, invoices, payments, refunds or cancellation.",
      technical: "Broken software, service outages, errors or troubleshooting.",
      other: "General inquiries outside billing and technical support.",
    },
  },
  urgency: {
    kind: "ordinal",
    instructions: "Rate the urgency. Use the deadline and impact explicitly stated in the ticket.",
    levels: [
      "Routine, explicitly no deadline or urgency.",
      "Needs action this week but no critical outage.",
      "Critical ongoing outage or immediate harm; act now.",
    ],
  },
};

async function verifyZeroPrice(model) {
  const response = await fetch("https://openrouter.ai/api/v1/models?output_modalities=decisions", {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Model catalog: HTTP ${response.status}`);
  const catalog = await response.json();
  const entry = catalog.data.find((candidate) => candidate.id === model);
  assert(entry, `Model is not currently available: ${model}`);
  assert(
    entry.architecture.output_modalities.includes("decisions"),
    "Model must support decisions",
  );
  assert(entry.architecture.input_modalities.includes("text"), "Model must accept text");
  assert(
    entry.pricing.prompt !== undefined &&
      Number(entry.pricing.prompt) === 0 &&
      entry.pricing.completion !== undefined &&
      Number(entry.pricing.completion) === 0,
    `Refusing a model with nonzero or missing token prices: ${model}`,
  );
  // No tools/plugins, paid fallback or provider routing overrides are sent.
}

const report = {
  evaluatedAt: new Date().toISOString(),
  scope:
    "Synthetic text/JSON protocol and behavior smoke test; not threshold calibration or a production approval qualification.",
  repeat,
  models,
  rows: [],
};
let stopForCost = false;
for (const model of models) {
  const adapter = new OpenRouterAdapter(
    resolveOpenRouterConfig({ model, apiKeyEnv, timeoutMs: 30_000 }),
  );
  for (let run = 1; run <= repeat && !stopForCost; run++) {
    for (const fixture of fixtures) {
      // A failed catalog/price check stops the run before another inference request.
      await verifyZeroPrice(model);
      const started = performance.now();
      let row;
      try {
        const result = await adapter.evaluate({ state: { ticket: fixture.ticket }, questions });
        const { cancellation, department, urgency } = result.answers;
        const checks = {
          cancellation: cancellation.probability >= 0.5 === fixture.cancellation,
          department: department.choice === fixture.department,
          urgency: Math.abs(urgency.score - fixture.urgency) <= 0.5,
        };
        stopForCost = result.usage?.costUsd !== 0;
        row = {
          model,
          fixture: fixture.id,
          run,
          latencyMs: Math.round(performance.now() - started),
          protocolPassed: true,
          behaviorPassed: Object.values(checks).every(Boolean),
          zeroCostConfirmed: !stopForCost,
          checks,
          result,
        };
      } catch (error) {
        row = {
          model,
          fixture: fixture.id,
          run,
          latencyMs: Math.round(performance.now() - started),
          protocolPassed: false,
          behaviorPassed: false,
          zeroCostConfirmed: false,
          error: {
            name: error.name,
            message: error.message,
            ...(error.status === undefined ? {} : { status: error.status }),
          },
        };
      }
      report.rows.push(row);
      console.log(
        JSON.stringify({
          model,
          fixture: fixture.id,
          run,
          protocolPassed: row.protocolPassed,
          behaviorPassed: row.behaviorPassed,
          costUsd: row.result?.usage?.costUsd,
          ...(row.error ? { error: row.error } : {}),
        }),
      );
      if (stopForCost) break;
    }
  }
  if (stopForCost) break;
}
report.summary = {
  plannedRequests: models.length * repeat * fixtures.length,
  completedRequests: report.rows.length,
  protocolPassed: report.rows.filter((row) => row.protocolPassed).length,
  behaviorPassed: report.rows.filter((row) => row.behaviorPassed).length,
  zeroCostConfirmed: report.rows.filter((row) => row.zeroCostConfirmed).length,
  reportedCostUsd: report.rows.reduce((sum, row) => sum + (row.result?.usage?.costUsd ?? 0), 0),
};
if (values.out) await writeFile(values.out, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report.summary, null, 2));
if (
  report.summary.completedRequests !== report.summary.plannedRequests ||
  report.summary.protocolPassed !== report.summary.plannedRequests ||
  report.summary.behaviorPassed !== report.summary.plannedRequests ||
  report.summary.zeroCostConfirmed !== report.summary.plannedRequests
)
  process.exitCode = 1;
