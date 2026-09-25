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
