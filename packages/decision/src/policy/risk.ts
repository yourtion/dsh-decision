import { createHash } from "node:crypto";

/** Stable order makes ties and explanation text deterministic. */
export const GUARDRAIL_RISKS = [
  "destructive",
  "secretExposure",
  "privacyExposure",
  "externalSideEffect",
  "privilegeEscalation",
  "scopeViolation",
] as const;

export type GuardrailRisk = (typeof GUARDRAIL_RISKS)[number];
export type RiskAction = "allow" | "review" | "deny";

export interface RiskThresholds {
  readonly reviewAt: number;
  readonly denyAt: number;
}

/**
 * Shared first-pass thresholds for every host. Recalibrated 2026-09-26 from
 * live Jev evaluations (22 hand-labeled fixtures, `typesafe-ai/jev` via the
 * Vercel gateway; see `packages/decision-jev/eval/` and docs/eval.md):
 * benign false blocks 75% → 0%, deny misses 0%, deny cases softened to
 * review 2 → 0. The `externalSideEffect` question was rewritten first (its
 * old wording scored workspace writes 0.74 above real external actions
 * 0.69–0.71); thresholds and question wording are calibrated as a pair.
 * Margins to the nearest benign score are ≥0.05. Still a seed-set
 * calibration — keep `enforce` flagged experimental until the fixture set
 * grows.
 */
export const DEFAULT_GUARDRAIL_RISKS: Readonly<Record<GuardrailRisk, RiskThresholds>> = {
  destructive: { reviewAt: 0.45, denyAt: 0.55 },
  secretExposure: { reviewAt: 0.55, denyAt: 0.85 },
  privacyExposure: { reviewAt: 0.65, denyAt: 0.88 },
  externalSideEffect: { reviewAt: 0.45, denyAt: 0.7 },
  privilegeEscalation: { reviewAt: 0.25, denyAt: 0.85 },
  scopeViolation: { reviewAt: 0.48, denyAt: 0.72 },
};

export interface PolicyDecision {
  readonly action: RiskAction;
  readonly reason: string;
  readonly policyVersion: string;
  readonly driver?: GuardrailRisk;
  readonly probability?: number;
}

export interface PolicyEngine<Context, Judgments, Decision extends { readonly action: string }> {
  evaluate(context: Context, judgments: Judgments): Decision;
}

export const GUARDRAIL_POLICY_VERSION = "guardrail-v2.0.0";

export function guardrailPolicyVersion(
  thresholds: Readonly<Record<GuardrailRisk, RiskThresholds>>,
): string {
  const canonical = GUARDRAIL_RISKS.map((risk) => [
    risk,
    thresholds[risk].reviewAt,
    thresholds[risk].denyAt,
  ]);
  const digest = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return `${GUARDRAIL_POLICY_VERSION}:${digest}`;
}

export function evaluateRisk(probability: number, thresholds: RiskThresholds): RiskAction {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error("dsh-decision: risk probability must be finite and in [0, 1].");
  }
  if (probability >= thresholds.denyAt) return "deny";
  if (probability >= thresholds.reviewAt) return "review";
  return "allow";
}

/** Deny > review > allow; the declared risk order resolves equal-priority ties. */
export function evaluateGuardrailPolicy(
  judgments: Readonly<Record<GuardrailRisk, number>>,
  thresholds: Readonly<Record<GuardrailRisk, RiskThresholds>>,
): PolicyDecision {
  let action: RiskAction = "allow";
  let driver: GuardrailRisk | undefined;
  let probability: number | undefined;
  for (const risk of GUARDRAIL_RISKS) {
    const value = judgments[risk];
    const candidate = evaluateRisk(value, thresholds[risk]);
    if (
      (candidate === "deny" && action !== "deny") ||
      (candidate === "review" && action === "allow")
    ) {
      action = candidate;
      driver = risk;
      probability = value;
    }
  }
  return {
    action,
    reason:
      driver === undefined
        ? "decision-layer: no configured risk crossed its review threshold."
        : `decision-layer: ${driver} risk ${probability!.toFixed(2)} crossed ${action} threshold.`,
    policyVersion: guardrailPolicyVersion(thresholds),
    ...(driver === undefined ? {} : { driver, probability }),
  };
}
