import test from "node:test";
import assert from "node:assert/strict";
import { calibrateRows } from "./calibrate.mjs";

const risk = {
  key: "risk",
  instructions: "test",
  reviewAt: 0.55,
  denyAt: 0.85,
  highAction: "deny",
};

test("rejects holdout rows before tuning", () => {
  assert.throws(
    () =>
      calibrateRows(
        [
          { id: "cal", split: "calibration", expected: "allow", probabilities: { risk: 0.1 } },
          { id: "held", split: "holdout", expected: "deny", probabilities: { risk: 0.9 } },
        ],
        [risk],
      ),
    /refuses non-calibration rows: held/,
  );
});

test("lexicographic objective fixes deny-to-review before lower-priority errors", () => {
  const rows = [
    { id: "miss", split: "calibration", expected: "deny", probabilities: { risk: 0.6 } },
    { id: "review", split: "calibration", expected: "review", probabilities: { risk: 0.7 } },
    { id: "allow", split: "calibration", expected: "allow", probabilities: { risk: 0.1 } },
  ];
  const result = calibrateRows(rows, [risk]);
  assert.deepEqual(result.loss.defaults.slice(0, 5), [0, 0, 1, 0, 0]);
  assert.deepEqual(result.loss.candidate.slice(0, 5), [0, 0, 0, 0, 1]);
  assert.equal(result.candidate.risk.denyAt, 0.6);
  assert.equal(result.fixedHighAction.risk, "deny");
});

test("keeps default thresholds when no action loss improves", () => {
  const rows = [
    { id: "safe", split: "calibration", expected: "allow", probabilities: { risk: 0.1 } },
    { id: "review", split: "calibration", expected: "review", probabilities: { risk: 0.7 } },
    { id: "deny", split: "calibration", expected: "deny", probabilities: { risk: 0.9 } },
  ];
  const result = calibrateRows(rows, [risk]);
  assert.equal(result.changed, false);
  assert.deepEqual(result.candidate, { risk: { reviewAt: 0.55, denyAt: 0.85 } });
});

test("compares moves across dimensions before taking a coordinate step", () => {
  const risks = [
    { key: "destructive", instructions: "test", reviewAt: 0.45, denyAt: 0.55 },
    { key: "secretExposure", instructions: "test", reviewAt: 0.55, denyAt: 0.85 },
  ];
  const rows = [
    {
      id: "expected-deny",
      split: "calibration",
      expected: "deny",
      probabilities: { destructive: 0.46, secretExposure: 0.53 },
    },
    {
      id: "expected-allow",
      split: "calibration",
      expected: "allow",
      probabilities: { destructive: 0.44, secretExposure: 0.1 },
    },
  ];
  const result = calibrateRows(rows, risks);
  assert.equal(result.metrics.defaults.counts.deny.review, 1);
  assert.equal(result.metrics.candidate.counts.deny.deny, 1);
  assert.equal(result.metrics.candidate.counts.allow.allow, 1);
  assert.deepEqual(result.candidate.destructive, { reviewAt: 0.45, denyAt: 0.55 });
  assert.equal(result.candidate.secretExposure.denyAt, 0.5);
});
