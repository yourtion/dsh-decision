/**
 * DSH's current approval request has no origin field. The tools service copies
 * the pre-execute `ask.reason` into the approval request, so this marker carries
 * provenance across that boundary. A forged marker only forces human review.
 */
const ESCALATION_PREFIX = "[dsh-decision:decision-escalation] ";

export type DecisionOrigin = "native-policy" | "tool-policy" | "decision-escalation" | "external";

export function markDecisionEscalation(reason: string | undefined): string {
  return `${ESCALATION_PREFIX}${reason ?? "Machine decision requires human review."}`;
}

export function isDecisionEscalation(reason: string | undefined): boolean {
  return reason?.startsWith(ESCALATION_PREFIX) ?? false;
}
