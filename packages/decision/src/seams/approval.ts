/**
 * Approval seam: answer `approval/request` with a machine judgment, delegating
 * to human answerers in the middle band — and never when uncalibrated.
 * @module dsh-decision/seams/approval
 */

import type { DecisionAnswer, DecisionRequest } from "../types.js";
import type { ApprovalOutcome } from "@deepseek-ai/dsh-user-approval";
import type { ApprovalSpec } from "../config.js";

const APPROVAL_INSTRUCTIONS =
  "An AI coding agent asks a human for one-time permission for the action in the attached state. Should it be allowed to proceed autonomously?";

/** Delegate marker: hand the question to the remaining answerers (humans/UI). */
export const DELEGATE: unique symbol = Symbol("delegate");

/** Machine answer: a closed outcome, or {@link DELEGATE} to pass on the question. */
export type MachineApproval = ApprovalOutcome | typeof DELEGATE;

/**
 * Build the approval request for one pending permission question.
 * @param toolName - the tool the question is about.
 * @param reason - the asker's explanation.
 * @param signal - cancellation lifetime of the request.
 * @returns the decision request carrying one Noul question.
 */
export function buildApprovalRequest(
  toolName: string,
  reason: string | undefined,
  signal?: AbortSignal,
): DecisionRequest {
  return {
    state: { tool: toolName, ...(reason === undefined ? {} : { reason }) },
    signal,
    questions: { allow: { kind: "noul", instructions: APPROVAL_INSTRUCTIONS } },
  };
}

/**
 * Map the allow probability onto a machine answer.
 * @param answers - adapter answers for `allow`.
 * @param spec - resolved approval spec.
 * @param calibrated - whether the active adapter is calibration-fit.
 * @returns `allowed-once` / `rejected`, or {@link DELEGATE} for the middle
 *   band and for every auto-allow attempted with an uncalibrated adapter.
 * @throws on a missing or non-Noul answer.
 */
export function decideApproval(
  answers: Readonly<Record<string, DecisionAnswer>>,
  spec: ApprovalSpec,
  calibrated: boolean,
): MachineApproval {
  const answer = answers.allow;
  if (answer === undefined || answer.kind !== "noul") {
    throw new Error('dsh-decision: approval expected a noul answer for "allow".');
  }
  if (answer.probability >= spec.allowAt) {
    if (spec.requireCalibrated && !calibrated) return DELEGATE;
    return "allowed-once";
  }
  if (answer.probability < spec.rejectBelow) return "rejected";
  return DELEGATE;
}
