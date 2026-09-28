import { createHash } from "node:crypto";
import type { ApprovalSpec, UncertainPolicy } from "../config.js";
import type { JudgmentCapabilities, JudgmentDomain } from "../judgment.js";

export const APPROVAL_POLICY_VERSION = "approval-v3.0.0";

/** Narrow factual questions; authorization is checked only against host evidence. */
export const APPROVAL_QUESTIONS = {
  withinScope: {
    kind: "binary" as const,
    instructions:
      "Is this exact tool action directly requested by, or a necessary step to complete, the user's task?",
    criteria: {
      true: "The user request and the specified tool arguments establish a direct task connection.",
      false:
        "The action adds a separate objective, conflicts with the task, or the request or action is too vague to establish the connection.",
    },
  },
  reasonMatchesAction: {
    kind: "binary" as const,
    instructions:
      "Does the agent's stated reason accurately describe the exact tool action and its target?",
    criteria: {
      true: "The reason matches the actual tool and arguments, including the target and material effect.",
      false:
        "The reason omits or misstates the target or effect, or no reason or action details are supplied.",
    },
  },
} as const;

export function approvalPolicyVersion(spec: ApprovalSpec, uncertain: UncertainPolicy): string {
  const canonical = [spec.rejectBelow, spec.allowAt, uncertain, APPROVAL_QUESTIONS];
  const digest = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return `${APPROVAL_POLICY_VERSION}:${digest}`;
}

export interface MachineApprovalDecision {
  readonly action: "allow" | "review" | "deny";
  readonly reason: string;
  readonly policyVersion: string;
}

export interface ApprovalEvidence {
  /** True only when the user task, workspace, actual action, and reason are present. */
  readonly contextComplete: boolean;
  /** Exact action and context matched a trusted host authorization record. */
  readonly authorized: boolean;
  readonly reasonMatchProbability: number;
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

/** A high scope score can grant once only with exact host authorization and calibration. */
export function evaluateMachineApproval(
  probability: number,
  spec: ApprovalSpec,
  qualified: boolean,
  uncertain: UncertainPolicy = "human",
  evidence?: ApprovalEvidence,
): MachineApprovalDecision {
  for (const value of [probability, evidence?.reasonMatchProbability]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error("dsh-decision: approval probability must be finite and in [0, 1].");
    }
  }
  const policyVersion = approvalPolicyVersion(spec, uncertain);
  if (!evidence?.contextComplete) {
    return {
      action: "review",
      reason: "decision-layer: approval context is incomplete; human review required.",
      policyVersion,
    };
  }
  if (probability < spec.rejectBelow) {
    return {
      action: "deny",
      reason: "decision-layer: action is outside the user's task.",
      policyVersion,
    };
  }
  if (
    probability >= spec.allowAt &&
    evidence.reasonMatchProbability >= spec.allowAt &&
    evidence.authorized &&
    qualified
  ) {
    return {
      action: "allow",
      reason: "decision-layer: exact host-authorized action allowed once.",
      policyVersion,
    };
  }
  return {
    action: "review",
    reason: "decision-layer: machine approval requires human review.",
    policyVersion,
  };
}
