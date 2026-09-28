/** Approval seam: factual judgment plus exact host authorization and calibration. */

import type { DecisionAnswer, DecisionRequest, DecisionState } from "../types.js";
import type { JudgmentRequest, JudgmentResult } from "../judgment.js";
import type { ApprovalOutcome } from "@deepseek-ai/dsh-user-approval";
import type { ApprovalSpec, UncertainPolicy } from "../config.js";
import { redactValue, type OutboundPrivacy } from "../privacy/sanitizer.js";
import { guardrailActionHash, type ToolDecisionContext } from "./guardrail.js";
import {
  APPROVAL_QUESTIONS,
  evaluateMachineApproval,
  type MachineApprovalDecision,
} from "../policy/approval.js";

/** Actual action and trusted host context. Authorization must match its fingerprint. */
export interface ApprovalDecisionContext extends ToolDecisionContext {
  readonly toolName: string;
  readonly arguments?: unknown;
}

/** Delegate marker: hand the question to remaining answerers (humans/UI). */
export const DELEGATE: unique symbol = Symbol("delegate");

function contextComplete(
  context: ApprovalDecisionContext | undefined,
  reason: string | undefined,
): boolean {
  return (
    typeof context?.userRequest === "string" &&
    context.userRequest.trim() !== "" &&
    typeof context.workspaceRoot === "string" &&
    context.workspaceRoot.trim() !== "" &&
    typeof context.toolName === "string" &&
    context.toolName.trim() !== "" &&
    context.arguments !== undefined &&
    typeof reason === "string" &&
    reason.trim() !== ""
  );
}

function authorized(context: ApprovalDecisionContext | undefined): boolean {
  if (context?.arguments === undefined || !context.workspaceRoot?.trim()) return false;
  const authorization = context.authorization;
  return (
    authorization?.granted === true &&
    authorization.toolName === context.toolName &&
    authorization.workspaceRoot === context.workspaceRoot &&
    authorization.environment === context.environment &&
    authorization.argumentsHash ===
      guardrailActionHash(context.toolName, context.arguments, context)
  );
}

/** One judgment round trip. The authorization record never leaves the host. */
export function buildMachineApprovalRequest(
  toolName: string,
  reason: string | undefined,
  context?: ApprovalDecisionContext,
  outboundPrivacy: OutboundPrivacy = "redact",
): JudgmentRequest {
  if (context !== undefined && context.toolName !== toolName) {
    throw new Error("dsh-decision: approval context toolName does not match the pending action.");
  }
  const rawState: Record<string, DecisionState> = {
    tool: toolName,
    ...(reason === undefined ? {} : { reason }),
    ...(context?.arguments === undefined ? {} : { arguments: context.arguments as DecisionState }),
    ...(context?.userRequest ? { userRequest: context.userRequest } : {}),
    ...(context?.workspaceRoot ? { workspaceRoot: context.workspaceRoot } : {}),
    ...(context?.environment ? { environment: context.environment } : {}),
  };
  const sanitized =
    outboundPrivacy === "redact" ? redactValue(rawState) : { value: rawState, count: 0 };
  return {
    state: {
      ...sanitized.value,
      ...(sanitized.count === 0
        ? {}
        : {
            redactionNotice:
              "[REDACTED:kind] represents a detected secret category, not the secret value.",
          }),
    },
    questions: APPROVAL_QUESTIONS,
  };
}

export function decideMachineApproval(
  result: JudgmentResult,
  spec: ApprovalSpec,
  qualified: boolean,
  uncertain: UncertainPolicy,
  context?: ApprovalDecisionContext,
  reason?: string,
): MachineApprovalDecision {
  const withinScope = result.answers.withinScope;
  const reasonMatchesAction = result.answers.reasonMatchesAction;
  if (withinScope?.kind !== "binary") {
    throw new Error('dsh-decision: approval expected a binary answer for "withinScope".');
  }
  if (reasonMatchesAction?.kind !== "binary") {
    throw new Error('dsh-decision: approval expected a binary answer for "reasonMatchesAction".');
  }
  return evaluateMachineApproval(withinScope.probability, spec, qualified, uncertain, {
    contextComplete: contextComplete(context, reason),
    authorized: authorized(context),
    reasonMatchProbability: reasonMatchesAction.probability,
  });
}

/** Legacy v1 API is retained for callers; it cannot grant without scoped host evidence. */
export type MachineApproval = ApprovalOutcome | typeof DELEGATE;

export function buildApprovalRequest(
  toolName: string,
  reason: string | undefined,
  signal?: AbortSignal,
): DecisionRequest {
  return {
    state: { tool: toolName, ...(reason === undefined ? {} : { reason }) },
    signal,
    questions: {
      allow: {
        kind: "noul",
        instructions:
          "Does the stated action directly fall within the user's explicitly requested task?",
        criteria: {
          true: "The actual action is a necessary step toward the user's task.",
          false: "The task or action details are missing, or the action adds a separate objective.",
        },
      },
    },
  };
}

/** Legacy responses delegate because this API has no exact scoped authorization record. */
export function decideApproval(
  answers: Readonly<Record<string, DecisionAnswer>>,
  _spec: ApprovalSpec,
  _calibrated: boolean,
): MachineApproval {
  const answer = answers.allow;
  if (answer === undefined || answer.kind !== "noul") {
    throw new Error('dsh-decision: approval expected a noul answer for "allow".');
  }
  if (!Number.isFinite(answer.probability) || answer.probability < 0 || answer.probability > 1) {
    throw new Error("dsh-decision: approval probability must be finite and in [0, 1].");
  }
  return DELEGATE;
}
