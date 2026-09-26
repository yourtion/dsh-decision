/** Multi-dimensional tool-risk judgment with a deterministic policy. */
import type { DecisionState } from "../types.js";
import type { JudgmentRequest, JudgmentResult } from "../judgment.js";
import type { GuardrailSpec } from "../config.js";
import {
  evaluateGuardrailPolicy,
  type PolicyDecision,
  type RiskDefinition,
} from "../policy/risk.js";

export type GuardrailVerdict = PolicyDecision;

export function buildGuardrailRequest(
  toolName: string,
  args: unknown,
  risks: readonly RiskDefinition[],
): JudgmentRequest {
  return {
    // ToolRuntime guarantees lossless JSON arguments at this boundary.
    state: { tool: toolName, arguments: args as DecisionState },
    questions: Object.fromEntries(
      risks.map((risk) => [risk.key, { kind: "binary" as const, instructions: risk.instructions }]),
    ),
  };
}

export function decideGuardrail(result: JudgmentResult, spec: GuardrailSpec): GuardrailVerdict {
  const probabilities = Object.fromEntries(
    spec.risks.map((risk) => {
      const answer = result.answers[risk.key];
      if (answer?.kind !== "binary") {
        throw new Error(`dsh-decision: guardrail expected a binary answer for "${risk.key}".`);
      }
      return [risk.key, answer.probability];
    }),
  );
  return evaluateGuardrailPolicy(probabilities, spec.risks);
}
