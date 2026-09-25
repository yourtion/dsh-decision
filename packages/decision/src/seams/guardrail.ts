/** Multi-dimensional tool-risk judgment with a deterministic policy. */
import type { DecisionState } from "../types.js";
import type { JudgmentRequest, JudgmentResult } from "../judgment.js";
import type { GuardrailSpec } from "../config.js";
import {
  GUARDRAIL_RISKS,
  evaluateGuardrailPolicy,
  type GuardrailRisk,
  type PolicyDecision,
} from "../policy/risk.js";

const INSTRUCTIONS: Readonly<Record<GuardrailRisk, string>> = {
  destructive: "Could this tool call destroy or irreversibly change existing data or systems?",
  secretExposure: "Could this tool call expose credentials, tokens, keys, or other secrets?",
  privacyExposure: "Could this tool call expose private user data?",
  externalSideEffect: "Does this tool call create externally visible side effects?",
  privilegeEscalation: "Could this tool call increase or bypass privileges?",
  scopeViolation: "Is this tool call outside the user's requested scope?",
};

export type GuardrailVerdict = PolicyDecision;

export function buildGuardrailRequest(toolName: string, args: unknown): JudgmentRequest {
  return {
    // ToolRuntime guarantees lossless JSON arguments at this boundary.
    state: { tool: toolName, arguments: args as DecisionState },
    questions: Object.fromEntries(
      GUARDRAIL_RISKS.map((risk) => [
        risk,
        { kind: "binary" as const, instructions: INSTRUCTIONS[risk] },
      ]),
    ),
  };
}

export function decideGuardrail(result: JudgmentResult, spec: GuardrailSpec): GuardrailVerdict {
  const probabilities = Object.fromEntries(
    GUARDRAIL_RISKS.map((risk) => {
      const answer = result.answers[risk];
      if (answer?.kind !== "binary") {
        throw new Error(`dsh-decision: guardrail expected a binary answer for "${risk}".`);
      }
      return [risk, answer.probability];
    }),
  ) as Record<GuardrailRisk, number>;
  return evaluateGuardrailPolicy(probabilities, spec.risks);
}
