import test from "node:test";
import assert from "node:assert/strict";
import { thresholdMargins } from "./diagnostics.mjs";

test("reports a threshold band without implying the configured final action", () => {
  const margins = thresholdMargins({ probabilities: { externalSideEffect: 0.9 } }, [
    { key: "externalSideEffect", reviewAt: 0.45, denyAt: 0.7, highAction: "review" },
  ]);
  assert.equal(margins.externalSideEffect.thresholdBand, "high");
  assert.equal(margins.externalSideEffect.classification, undefined);
});
