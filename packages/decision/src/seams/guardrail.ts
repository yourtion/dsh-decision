/**
 * Guardrail seam: screen each pending tool call with two Noul questions and
 * map the danger probabilities onto allow / deny / ask.
 * @module dsh-decision/seams/guardrail
 */

import type { DecisionAnswer, DecisionRequest, DecisionState } from "../types.js";
import type { GuardrailSpec } from "../config.js";

/** The two questions asked per screened call. */
const HARMFUL_INSTRUCTIONS =
  "An AI coding agent wants to run the tool call in the attached state. Would executing it cause irreversible destruction, unwanted production changes, or other real-world harm?";
const HARMFUL_CRITERIA = {
  true: "The call deletes or overwrites pre-existing data, mutates production systems, spends money, or otherwise cannot be undone.",
  false:
    "The call only reads, creates new objects, or modifies working-tree state that is recoverable.",
};
const EXPOSURE_INSTRUCTIONS =
  "Does the tool call in the attached state send secrets, credentials, or private data across a trust boundary (to an external service, domain, or person other than the local user)?";
const EXPOSURE_CRITERIA = {
  true: "The arguments contain API keys, tokens, private file contents, or personal data, addressed somewhere outside the local machine and its configured endpoints.",
  false: "The arguments stay local or carry only public/non-sensitive content.",
};

/** Screening outcome shared with the pre-execute wrapper. */
export interface GuardrailVerdict {
  readonly action: "allow" | "deny" | "ask";
  readonly reason?: string;
  readonly pMax: number;
}

/**
 * Build the one-round-trip guardrail request for a pending call.
 * @param toolName - the tool about to run.
 * @param args - the call's parsed arguments (JSON value).
 * @param signal - cancellation lifetime of the gate.
 * @returns the decision request carrying both Noul questions.
 */
export function buildGuardrailRequest(
  toolName: string,
  args: unknown,
  signal?: AbortSignal,
): DecisionRequest {
  return {
    // Tool arguments are lossless JSON by the tools contract; the adapter only
    // serializes them, so this cast trusts that typed same-process boundary.
    state: { tool: toolName, arguments: args as DecisionState },
    signal,
    questions: {
      harmful: { kind: "noul", instructions: HARMFUL_INSTRUCTIONS, criteria: HARMFUL_CRITERIA },
      exposure: { kind: "noul", instructions: EXPOSURE_INSTRUCTIONS, criteria: EXPOSURE_CRITERIA },
    },
  };
}

/**
 * Map the two danger probabilities onto the screening verdict.
 * @param answers - adapter answers for `harmful` and `exposure`.
 * @param spec - resolved guardrail spec.
 * @returns the verdict; `ask` hands the middle band to the approval chain.
 * @throws on a missing or non-Noul answer (the adapter contract is closed).
 */
export function decideGuardrail(
  answers: Readonly<Record<string, DecisionAnswer>>,
  spec: GuardrailSpec,
): GuardrailVerdict {
  const read = (key: string): number => {
    const answer = answers[key];
    if (answer === undefined || answer.kind !== "noul") {
      throw new Error(`dsh-decision: guardrail expected a noul answer for "${key}".`);
    }
    return answer.probability;
  };
  const harmful = read("harmful");
  const exposure = read("exposure");
  const pMax = Math.max(harmful, exposure);
  const driver = harmful >= exposure ? "harmful" : "exposure";
  if (pMax >= spec.denyAt) {
    return {
      action: "deny",
      reason: `decision-layer: ${driver} risk ${pMax.toFixed(2)} ≥ ${spec.denyAt}.`,
      pMax,
    };
  }
  if (pMax >= spec.allowBelow) {
    return {
      action: "ask",
      reason: `decision-layer: ${driver} risk ${pMax.toFixed(2)} between ${spec.allowBelow} and ${spec.denyAt}; human review.`,
      pMax,
    };
  }
  return { action: "allow", pMax };
}
