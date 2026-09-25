import { describe, expect, it } from "vitest";
import { decideGuardrail } from "./guardrail.ts";
import { decideRouting } from "./routing.ts";
import { decideJudge } from "./judge.ts";
import { decideApproval, DELEGATE } from "./approval.ts";
import { resolveConfig } from "../config.ts";
import type { DecisionAnswer } from "../types.ts";
import type { JudgmentResult } from "../judgment.ts";
import { GUARDRAIL_RISKS } from "../policy/risk.ts";
import {
  evaluateMachineApproval,
  trustedForAutoAllow,
  approvalPolicyVersion,
} from "../policy/approval.ts";

const noul = (probability: number): DecisionAnswer => ({ kind: "noul", probability });
const categorical = (picked: string, confidence: number): JudgmentResult => ({
  provider: "test",
  answers: {
    tier: {
      kind: "categorical",
      choice: picked,
      probabilities: { [picked]: confidence },
      confidence,
    },
  },
});

const spec = resolveConfig({});
const guardrailResult = (risks: Record<string, number>): JudgmentResult => ({
  provider: "test",
  answers: Object.fromEntries(
    GUARDRAIL_RISKS.map((risk) => [risk, { kind: "binary", probability: risks[risk] ?? 0 }]),
  ),
});
const judgeResult = (injection: number, exposure: number): JudgmentResult => ({
  provider: "test",
  answers: {
    injection: { kind: "binary", probability: injection },
    exposure: { kind: "binary", probability: exposure },
  },
});

describe("guardrail decisions", () => {
  it("allows below every review threshold and denies at a risk's deny boundary", () => {
    expect(decideGuardrail(guardrailResult({}), spec.guardrail).action).toBe("allow");
    expect(decideGuardrail(guardrailResult({ secretExposure: 0.7 }), spec.guardrail).action).toBe(
      "deny",
    );
  });

  it("reviews a moderate risk and reports the policy driver", () => {
    const verdict = decideGuardrail(guardrailResult({ privacyExposure: 0.4 }), spec.guardrail);
    expect(verdict.action).toBe("review");
    expect(verdict.driver).toBe("privacyExposure");
    expect(verdict.probability).toBe(0.4);
  });

  it("deny outranks review across independent risks", () => {
    const verdict = decideGuardrail(
      guardrailResult({ destructive: 0.4, privilegeEscalation: 0.8 }),
      spec.guardrail,
    );
    expect(verdict.action).toBe("deny");
    expect(verdict.driver).toBe("privilegeEscalation");
  });

  it("throws on a missing or wrong-typed answer", () => {
    expect(() => decideGuardrail({ provider: "test", answers: {} }, spec.guardrail)).toThrow(
      /destructive/,
    );
    expect(() =>
      decideGuardrail(
        {
          provider: "test",
          answers: { destructive: { kind: "categorical", choice: "x", probabilities: {} } },
        },
        spec.guardrail,
      ),
    ).toThrow(/destructive/);
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
    const routed = decideRouting(categorical("flagship", 0.9), routingSpec, fallback);
    expect(routed).toEqual({
      provider: "p",
      model: "big",
      reasoningEffort: "high",
      maxTokens: 16_384,
    });
  });

  it("keeps the fallback below the confidence floor and for unknown keys", () => {
    expect(decideRouting(categorical("cheap", 0.5), routingSpec, fallback)).toBe(fallback);
    expect(decideRouting(categorical("unknown", 0.99), routingSpec, fallback)).toBe(fallback);
  });

  it("merges only the fields the route pins", () => {
    const routed = decideRouting(categorical("cheap", 0.9), routingSpec, {
      provider: "p",
      model: "other",
      maxTokens: 1_024,
    });
    expect(routed).toEqual({ provider: "p", model: "small", maxTokens: 1_024 });
  });
});

describe("judge decisions", () => {
  it("accepts quiet results and blocks at or above the block threshold", () => {
    expect(decideJudge(judgeResult(0.1, 0.2), spec.judge).action).toBe("accept");
    const blocked = decideJudge(judgeResult(0.8, 0.2), spec.judge);
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

describe("v2 machine approval policy", () => {
  it("requires a matching model, domain and policy version for auto allow", () => {
    const version = approvalPolicyVersion(spec.approval, "human");
    const capabilities = {
      binary: true,
      categorical: false,
      ordinal: false,
      calibration: [
        {
          model: "m1",
          domain: "approval" as const,
          policyVersion: version,
          trustedForAutoAllow: true,
        },
      ],
    };
    expect(trustedForAutoAllow(capabilities, "m1", "approval", version)).toBe(true);
    expect(trustedForAutoAllow(capabilities, "m2", "approval", version)).toBe(false);
    expect(trustedForAutoAllow(capabilities, "m1", "tool-risk", version)).toBe(false);
    expect(trustedForAutoAllow(capabilities, "m1", "approval", "old-policy")).toBe(false);
  });

  it("maps unqualified high scores to review and low scores to deny", () => {
    expect(evaluateMachineApproval(0.99, spec.approval, false).action).toBe("review");
    expect(evaluateMachineApproval(0.99, spec.approval, true).action).toBe("allow");
    expect(evaluateMachineApproval(0.1, spec.approval, false).action).toBe("deny");
  });

  it("changes policy identity when thresholds or uncertainty change", () => {
    const version = approvalPolicyVersion(spec.approval, "human");
    expect(approvalPolicyVersion(spec.approval, "deny")).not.toBe(version);
    expect(approvalPolicyVersion({ ...spec.approval, allowAt: 0.9 }, "human")).not.toBe(version);
  });
});

describe("config resolution", () => {
  it("defaults every seam and enables only the guardrail", () => {
    const resolved = resolveConfig({});
    expect(resolved.mode).toBe("shadow");
    expect(resolved.permission).toBe("native");
    expect(resolved.enforcement).toBe("shadow");
    expect(resolved.guardrail.enabled).toBe(true);
    expect(resolved.routing.enabled).toBe(false);
    expect(resolved.judge.enabled).toBe(false);
    expect(resolved.approval.enabled).toBe(false);
  });

  it("fails loud on inverted thresholds and empty routes", () => {
    expect(() => resolveConfig({ guardrail: { allowBelow: 0.8, denyAt: 0.7 } })).toThrow(
      /invalid guardrail thresholds/,
    );
    expect(() => resolveConfig({ routing: { enabled: true } })).toThrow(/routes/);
    expect(() => resolveConfig({ mode: "shadow", enforcement: "enforce" })).toThrow(/disagree/);
    expect(() => resolveConfig({ permission: "machine", approval: { enabled: false } })).toThrow(
      /requires approval/,
    );
    expect(() => resolveConfig({ timeoutMs: 0 })).toThrow(/timeoutMs/);
  });
});
