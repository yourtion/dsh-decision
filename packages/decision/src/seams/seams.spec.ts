import { describe, expect, it } from "vitest";
import { decideGuardrail } from "./guardrail.ts";
import { decideRouting } from "./routing.ts";
import { decideJudge } from "./judge.ts";
import { decideApproval, DELEGATE } from "./approval.ts";
import { resolveConfig } from "../config.ts";
import type { DecisionAnswer } from "../types.ts";

const noul = (probability: number): DecisionAnswer => ({ kind: "noul", probability });
const choice = (picked: string, confidence: number): DecisionAnswer => ({
  kind: "choice",
  choice: picked,
  probabilities: { [picked]: confidence },
  confidence,
});

const spec = resolveConfig({});

describe("guardrail decisions", () => {
  it("allows below the lower threshold and denies at or above the upper one", () => {
    expect(
      decideGuardrail({ harmful: noul(0.05), exposure: noul(0.19) }, spec.guardrail).action,
    ).toBe("allow");
    expect(
      decideGuardrail({ harmful: noul(0.7), exposure: noul(0.1) }, spec.guardrail).action,
    ).toBe("deny");
  });

  it("asks in the middle band and reports the larger risk driver", () => {
    const verdict = decideGuardrail({ harmful: noul(0.3), exposure: noul(0.5) }, spec.guardrail);
    expect(verdict.action).toBe("ask");
    expect(verdict.pMax).toBe(0.5);
    expect(verdict.reason).toContain("exposure");
  });

  it("throws loud on a missing or wrong-typed answer", () => {
    expect(() => decideGuardrail({ harmful: noul(0.1) }, spec.guardrail)).toThrow(/exposure/);
    expect(() =>
      decideGuardrail({ harmful: choice("x", 1), exposure: noul(0.1) }, spec.guardrail),
    ).toThrow(/harmful/);
  });
});

describe("routing decisions", () => {
  const routingSpec = resolveConfig({
    routing: {
      enabled: true,
      routes: [
        { key: "cheap", provider: "p", model: "small" },
        {
          key: "flagship",
          provider: "p",
          model: "big",
          reasoningEffort: "high",
          maxTokens: 16_384,
        },
      ],
    },
  }).routing;
  const fallback = { provider: "p", model: "small" };

  it("merges the chosen tier over the fallback config", () => {
    const routed = decideRouting({ tier: choice("flagship", 0.9) }, routingSpec, fallback);
    expect(routed).toEqual({
      provider: "p",
      model: "big",
      reasoningEffort: "high",
      maxTokens: 16_384,
    });
  });

  it("keeps the fallback below the confidence floor and for unknown keys", () => {
    expect(decideRouting({ tier: choice("cheap", 0.5) }, routingSpec, fallback)).toBe(fallback);
    expect(decideRouting({ tier: choice("unknown", 0.99) }, routingSpec, fallback)).toBe(fallback);
  });

  it("merges only the fields the route pins", () => {
    const routed = decideRouting({ tier: choice("cheap", 0.9) }, routingSpec, {
      provider: "p",
      model: "other",
      maxTokens: 1_024,
    });
    expect(routed).toEqual({ provider: "p", model: "small", maxTokens: 1_024 });
  });
});

describe("judge decisions", () => {
  it("accepts quiet results and blocks at or above the block threshold", () => {
    expect(decideJudge({ injection: noul(0.1), exposure: noul(0.2) }, spec.judge).action).toBe(
      "accept",
    );
    const blocked = decideJudge({ injection: noul(0.8), exposure: noul(0.2) }, spec.judge);
    expect(blocked.action).toBe("block");
    expect(blocked.reason).toContain("prompt injection");
  });
});

describe("approval decisions", () => {
  it("allows at or above allowAt with a calibrated adapter only", () => {
    expect(decideApproval({ allow: noul(0.9) }, spec.approval, true)).toBe("allowed-once");
    expect(decideApproval({ allow: noul(0.9) }, spec.approval, false)).toBe(DELEGATE);
  });

  it("rejects below rejectBelow and delegates in between", () => {
    expect(decideApproval({ allow: noul(0.2) }, spec.approval, true)).toBe("rejected");
    expect(decideApproval({ allow: noul(0.6) }, spec.approval, true)).toBe(DELEGATE);
  });
});

describe("config resolution", () => {
  it("defaults every seam and enables only the guardrail", () => {
    const resolved = resolveConfig({});
    expect(resolved.mode).toBe("shadow");
    expect(resolved.guardrail.enabled).toBe(true);
    expect(resolved.routing.enabled).toBe(false);
    expect(resolved.judge.enabled).toBe(false);
    expect(resolved.approval.enabled).toBe(false);
  });

  it("fails loud on inverted thresholds and empty routes", () => {
    expect(() => resolveConfig({ guardrail: { allowBelow: 0.8, denyAt: 0.7 } })).toThrow(
      /inverted/,
    );
    expect(() => resolveConfig({ routing: { enabled: true } })).toThrow(/routes/);
  });
});
