import { describe, expect, it } from "vitest";
import { decideGuardrail } from "./guardrail.ts";
import { buildRoutingRequest, decideRouting } from "./routing.ts";
import { buildJudgeRequest, decideJudge } from "./judge.ts";
import {
  buildMachineApprovalRequest,
  decideMachineApproval,
  decideApproval,
  DELEGATE,
} from "./approval.ts";
import { guardrailActionHash } from "./guardrail.ts";
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
const judgeResult = (
  injection: number,
  secretExposure: number,
  privacyExposure = 0,
): JudgmentResult => ({
  provider: "test",
  answers: {
    injection: { kind: "binary", probability: injection },
    secretExposure: { kind: "binary", probability: secretExposure },
    privacyExposure: { kind: "binary", probability: privacyExposure },
  },
});

describe("guardrail decisions", () => {
  it("allows below every review threshold and denies at a risk's deny boundary", () => {
    expect(decideGuardrail(guardrailResult({}), spec.guardrail).action).toBe("allow");
    expect(decideGuardrail(guardrailResult({ secretExposure: 0.9 }), spec.guardrail).action).toBe(
      "deny",
    );
  });

  it("reviews a moderate risk and reports the policy driver", () => {
    const verdict = decideGuardrail(guardrailResult({ privacyExposure: 0.7 }), spec.guardrail);
    expect(verdict.action).toBe("review");
    expect(verdict.driver).toBe("privacyExposure");
    expect(verdict.probability).toBe(0.7);
  });

  it("deny outranks review across independent risks", () => {
    const verdict = decideGuardrail(
      guardrailResult({ destructive: 0.5, privilegeEscalation: 0.9 }),
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
        {
          key: "cheap",
          description: "Simple, local, well-specified work.",
          provider: "p",
          model: "small",
        },
        {
          key: "flagship",
          description: "Cross-module work requiring deeper reasoning.",
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

  it("offers an explicit insufficient-context fallback and requires answer confidence", () => {
    const question = buildRoutingRequest("vague task", routingSpec).questions.tier;
    expect(question?.kind).toBe("categorical");
    if (question?.kind === "categorical") {
      expect(question.options.insufficient_context).toContain("default");
      expect(question.options.cheap).toContain("Simple");
    }
    expect(decideRouting(categorical("insufficient_context", 0.99), routingSpec, fallback)).toBe(
      fallback,
    );
    const withoutConfidence = categorical("flagship", 0.99);
    expect(
      decideRouting(
        {
          ...withoutConfidence,
          answers: {
            tier: { kind: "categorical", choice: "flagship", probabilities: { flagship: 0.99 } },
          },
        },
        routingSpec,
        fallback,
      ),
    ).toBe(fallback);
  });

  it("normalizes and weights independent ordinal scores into configured bands", () => {
    const composite = resolveConfig({
      routing: {
        enabled: true,
        strategy: "composite",
        routes: [...routingSpec.routes],
        composite: {
          weights: { reasoningComplexity: 2, changeScope: 1, ambiguity: 1 },
          bands: [
            { upTo: 0.5, routeKey: "cheap" },
            { upTo: 1, routeKey: "flagship" },
          ],
        },
      },
    }).routing;
    const request = buildRoutingRequest("cross-module refactor", composite);
    expect(Object.keys(request.questions)).toEqual([
      "reasoningComplexity",
      "changeScope",
      "ambiguity",
    ]);
    const result: JudgmentResult = {
      provider: "test",
      answers: {
        reasoningComplexity: { kind: "ordinal", score: 3, probabilities: {}, confidence: 0.9 },
        changeScope: { kind: "ordinal", score: 1, probabilities: {}, confidence: 0.9 },
        ambiguity: { kind: "ordinal", score: 1, probabilities: {}, confidence: 0.9 },
      },
    };
    expect(decideRouting(result, composite, fallback).model).toBe("big");
    expect(
      decideRouting(
        {
          ...result,
          answers: {
            ...result.answers,
            ambiguity: { kind: "ordinal", score: 1, probabilities: {}, confidence: 0.2 },
          },
        },
        composite,
        fallback,
      ),
    ).toBe(fallback);
  });
});

describe("judge decisions", () => {
  it("accepts quiet results and blocks at or above the block threshold", () => {
    expect(decideJudge(judgeResult(0.1, 0.2), spec.judge).action).toBe("accept");
    const blocked = decideJudge(judgeResult(0.8, 0.2), spec.judge);
    expect(blocked.action).toBe("block");
    expect(blocked.reason).toContain("prompt injection");
  });

  it("asks separate secret and privacy questions and marks truncated results", () => {
    const request = buildJudgeRequest("read", {
      content: [{ type: "text", text: "x".repeat(9000) }],
    } as never);
    expect(Object.keys(request.questions)).toEqual([
      "injection",
      "secretExposure",
      "privacyExposure",
    ]);
    expect((request.state as Record<string, unknown>).resultTruncated).toBe(true);
    expect(decideJudge(judgeResult(0.1, 0.2, 0.9), spec.judge).reason).toContain(
      "privacy exposure",
    );
  });

  it("adds sanitized task context and treats only trusted original redactions as secret evidence", () => {
    const token = "ghp_" + "a".repeat(36);
    const safeResult = { content: [{ type: "text", text: "Output: [REDACTED:token]" }] } as never;
    const request = buildJudgeRequest("read", safeResult, {
      userRequest: `Inspect the output ${token}`,
      workspaceRoot: "/project",
      environment: "test",
    });
    expect(JSON.stringify(request.state)).not.toContain(token);
    expect(request.state).toMatchObject({ workspaceRoot: "/project", environment: "test" });
    expect(request.questions.privacyExposure?.criteria?.false).toMatch(
      /missing task context does not establish authorization/i,
    );
    expect(decideJudge(judgeResult(0.01, 0.01), spec.judge).action).toBe("accept");
    const blocked = decideJudge(judgeResult(0.01, 0.01), spec.judge, 1);
    expect(blocked.action).toBe("block");
    expect(blocked.reason).toContain("detected in the original result");
    const raw = buildJudgeRequest(
      "read",
      { content: [{ type: "text", text: token }] } as never,
      undefined,
      0,
      "raw",
    );
    expect(JSON.stringify(raw.state)).toContain(token);
  });
});

describe("approval decisions", () => {
  it("legacy answers always delegate without exact host authorization", () => {
    expect(decideApproval({ allow: noul(0.9) }, spec.approval, true)).toBe(DELEGATE);
    expect(decideApproval({ allow: noul(0.9) }, spec.approval, false)).toBe(DELEGATE);
  });

  it("delegates low and middle legacy scores without context", () => {
    expect(decideApproval({ allow: noul(0.2) }, spec.approval, true)).toBe(DELEGATE);
    expect(decideApproval({ allow: noul(0.6) }, spec.approval, true)).toBe(DELEGATE);
  });
});

describe("v2 machine approval policy", () => {
  it("redacts approval context by default, supports raw mode, and rejects tool mismatches", () => {
    const token = "ghp_" + "a".repeat(36);
    const context = {
      toolName: "send-email",
      arguments: { body: token },
      userRequest: "Send the release email",
      workspaceRoot: "/project",
      environment: "production",
    };
    const redacted = buildMachineApprovalRequest("send-email", `Deliver ${token}`, context);
    expect(JSON.stringify(redacted.state)).not.toContain(token);
    const raw = buildMachineApprovalRequest("send-email", `Deliver ${token}`, context, "raw");
    expect(JSON.stringify(raw.state)).toContain(token);
    expect(() => buildMachineApprovalRequest("different-tool", "Deliver", context)).toThrow(
      /does not match/,
    );
  });

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

  it("requires complete host evidence before a model score can decide", () => {
    expect(evaluateMachineApproval(0.99, spec.approval, false).action).toBe("review");
    expect(evaluateMachineApproval(0.99, spec.approval, true).action).toBe("review");
    expect(evaluateMachineApproval(0.1, spec.approval, false).action).toBe("review");
    expect(
      evaluateMachineApproval(0.1, spec.approval, false, "human", {
        contextComplete: true,
        authorized: false,
        reasonMatchProbability: 0.9,
      }).action,
    ).toBe("deny");
  });

  it("grants only for matching action authorization, reason, and calibration", () => {
    const args = { command: "echo ok" };
    const contextBase = {
      toolName: "bash",
      arguments: args,
      userRequest: "run echo ok",
      workspaceRoot: "/tmp/work",
    };
    const context = {
      ...contextBase,
      authorization: {
        toolName: "bash",
        workspaceRoot: "/tmp/work",
        argumentsHash: guardrailActionHash("bash", args, contextBase),
        granted: true as const,
      },
    };
    const result: JudgmentResult = {
      provider: "test",
      answers: {
        withinScope: { kind: "binary", probability: 0.95 },
        reasonMatchesAction: { kind: "binary", probability: 0.96 },
      },
    };
    const request = buildMachineApprovalRequest("bash", "run echo ok", context);
    expect((request.state as Record<string, unknown>).authorization).toBeUndefined();
    expect(
      decideMachineApproval(result, spec.approval, true, "human", context, "run echo ok").action,
    ).toBe("allow");
    expect(
      decideMachineApproval(result, spec.approval, false, "human", context, "run echo ok").action,
    ).toBe("review");
    expect(
      decideMachineApproval(
        result,
        spec.approval,
        true,
        "human",
        { ...context, arguments: { command: "rm -rf /tmp/work" } },
        "run echo ok",
      ).action,
    ).toBe("review");
    expect(decideMachineApproval(result, spec.approval, true, "human").action).toBe("review");
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

  it("validates route descriptions, reserved keys, composite weights and bands", () => {
    expect(() => resolveConfig({ routing: { enabled: true, routes: [{ key: "small" }] } })).toThrow(
      /description/,
    );
    expect(() =>
      resolveConfig({
        routing: {
          enabled: true,
          routes: [{ key: "insufficient_context", description: "fallback" }],
        },
      }),
    ).toThrow(/reserved|cannot/);
    const routes = [{ key: "small", description: "Simple local work", model: "small" }];
    expect(() =>
      resolveConfig({ routing: { enabled: true, routes, confidenceFloor: Number.NaN } }),
    ).toThrow(/confidenceFloor/);
    expect(() =>
      resolveConfig({
        routing: {
          enabled: true,
          strategy: "composite",
          routes,
          composite: { weights: { ambiguity: 0 }, bands: [{ upTo: 1, routeKey: "small" }] },
        },
      }),
    ).toThrow(/weight/);
    expect(() =>
      resolveConfig({
        routing: {
          enabled: true,
          strategy: "composite",
          routes,
          composite: { bands: [{ upTo: 0.5, routeKey: "small" }] },
        },
      }),
    ).toThrow(/final/);
    expect(() =>
      resolveConfig({
        routing: {
          enabled: true,
          strategy: "composite",
          routes,
          composite: { bands: [{ upTo: 1, routeKey: "missing" }] },
        },
      }),
    ).toThrow(/bands/);
  });
});
