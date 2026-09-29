import test from "node:test";
import assert from "node:assert/strict";
import { defaultRiskDefinitions } from "@techs/dsh-decision/kernel";
import { evaluationMetadata } from "./eval-core.mjs";
import { prepareThresholdComparison, validationRoleCopy } from "./compare-thresholds.mjs";

const risks = defaultRiskDefinitions();
const originalRisks = risks.map((risk) =>
  risk.key === "secretExposure" ? { ...risk, reviewAt: 0.55, denyAt: 0.85 } : risk,
);
const metadata = evaluationMetadata(originalRisks, [], "jev-latest");
metadata.actualModels = ["jev-1.13.0"];
const defaults = Object.fromEntries(
  originalRisks.map((r) => [r.key, { reviewAt: r.reviewAt, denyAt: r.denyAt }]),
);
const candidate = structuredClone(defaults);
candidate.secretExposure = { reviewAt: 0.48, denyAt: 0.5 };
const stored = {
  formatVersion: 2,
  evaluation: structuredClone(metadata),
  rows: [
    {
      id: "held",
      split: "holdout",
      expected: "allow",
      probabilities: Object.fromEntries(risks.map((r) => [r.key, 0.01])),
      unknownRisks: [],
      authorizedExternalSideEffect: false,
    },
  ],
};
const proposal = {
  tunerVersion: "lexicographic-coordinate-descent-v1",
  rows: 35,
  evaluation: structuredClone(metadata),
  fixedHighAction: Object.fromEntries(risks.map((r) => [r.key, r.highAction ?? "deny"])),
  defaults,
  candidate,
};

test("accepts matched calibration proposal and preserves highAction", () => {
  const result = prepareThresholdComparison(stored, proposal, risks);
  assert.equal(result.candidate.find((r) => r.key === "externalSideEffect").highAction, "review");
  assert.equal(result.candidate.find((r) => r.key === "secretExposure").reviewAt, 0.48);
});

test("requires matching fingerprints and model metadata", () => {
  for (const [field, value] of [
    ["fixtureFingerprint", "different-fixtures"],
    ["promptFingerprint", "different-prompt"],
    ["policyFingerprint", "different-policy"],
    ["privacyFingerprint", "different-privacy"],
    ["stateSchema", "different-state"],
    ["requestedModel", "different-requested-model"],
    ["actualModels", ["other-model"]],
  ]) {
    const changed = structuredClone(proposal);
    changed.evaluation[field] = value;
    assert.throws(() => prepareThresholdComparison(stored, changed, risks), new RegExp(field));
  }
});

test("rejects missing risks, extra threshold fields, and invalid bounds", () => {
  const missing = structuredClone(proposal);
  delete missing.candidate.scopeViolation;
  assert.throws(
    () => prepareThresholdComparison(stored, missing, risks),
    /exactly one threshold pair/,
  );

  const extra = structuredClone(proposal);
  extra.candidate.secretExposure.highAction = "review";
  assert.throws(() => prepareThresholdComparison(stored, extra, risks), /only reviewAt and denyAt/);

  const invalid = structuredClone(proposal);
  invalid.candidate.secretExposure = { reviewAt: 0.5, denyAt: 0.5 };
  assert.throws(() => prepareThresholdComparison(stored, invalid, risks), /invalid thresholds/);
});

test("refuses calibration rows as holdout input", () => {
  const wrongSplit = structuredClone(stored);
  wrongSplit.rows[0].split = "calibration";
  assert.throws(() => prepareThresholdComparison(wrongSplit, proposal, risks), /only holdout rows/);
});

test("labels repeat validation as previously seen, not independent evidence", () => {
  assert.match(validationRoleCopy(), /independent holdout/);
  assert.match(validationRoleCopy("repeat-validation"), /not fresh independent evidence/);
  assert.throws(() => validationRoleCopy("calibration"), /unknown validation role/);
});
