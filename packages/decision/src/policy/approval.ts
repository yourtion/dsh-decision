import { createHash } from "node:crypto";
import type { ApprovalSpec, UncertainPolicy } from "../config.js";
import type { JudgmentCapabilities, JudgmentDomain } from "../judgment.js";

export const APPROVAL_POLICY_VERSION = "approval-v2.0.0";

export function approvalPolicyVersion(spec: ApprovalSpec, uncertain: UncertainPolicy): string {
  const canonical = [spec.rejectBelow, spec.allowAt, uncertain];
  const digest = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return `${APPROVAL_POLICY_VERSION}:${digest}`;
}

export interface MachineApprovalDecision {
  readonly action: "allow" | "review" | "deny";
  readonly reason: string;
  readonly policyVersion: string;
}

export function trustedForAutoAllow(
  capabilities: JudgmentCapabilities,
  model: string | undefined,
  domain: JudgmentDomain,
  policyVersion: string,
): boolean {
  if (model === undefined) return false;
  return (
    capabilities.calibration?.some(
      (profile) =>
        profile.model === model &&
        profile.domain === domain &&
        profile.policyVersion === policyVersion &&
        profile.trustedForAutoAllow,
    ) ?? false
  );
}

/** A qualified high score may allow once; uncertainty always remains review. */
export function evaluateMachineApproval(
  probability: number,
  spec: ApprovalSpec,
  qualified: boolean,
  uncertain: UncertainPolicy = "human",
): MachineApprovalDecision {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error("dsh-decision: approval probability must be finite and in [0, 1].");
  }
  if (probability < spec.rejectBelow) {
    return {
      action: "deny",
      reason: "decision-layer: machine approval rejected this request.",
      policyVersion: approvalPolicyVersion(spec, uncertain),
    };
  }
  if (probability >= spec.allowAt && qualified) {
    return {
      action: "allow",
      reason: "decision-layer: qualified machine approval allowed this request once.",
      policyVersion: approvalPolicyVersion(spec, uncertain),
    };
  }
  return {
    action: "review",
    reason: "decision-layer: machine approval requires human review.",
    policyVersion: approvalPolicyVersion(spec, uncertain),
  };
}
