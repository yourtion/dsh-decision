/** Neutral JudgmentProvider facade over the Jev wire client. */
import {
  ProviderValidationError,
  type DecisionQuestion,
  type JudgmentAnswer,
  type JudgmentProvider,
  type JudgmentQuestion,
} from "@techs/dsh-decision/kernel";
import { createJevAdapter } from "./client.js";
import type { JevSpec } from "./spec.js";

function toJev(question: JudgmentQuestion): DecisionQuestion {
  switch (question.kind) {
    case "binary":
      return { kind: "noul", instructions: question.instructions, criteria: question.criteria };
    case "categorical":
      return { kind: "choice", instructions: question.instructions, options: question.options };
    case "ordinal":
      return { kind: "score", instructions: question.instructions, levels: question.levels };
  }
}

export function createJevProvider(
  spec: JevSpec,
  fetchImpl: typeof fetch = fetch,
): JudgmentProvider {
  const client = createJevAdapter(spec, fetchImpl);
  return {
    id: "jev",
    model: spec.model,
    capabilities: () => ({ binary: true, categorical: true, ordinal: true, calibration: [] }),
    async evaluate(request, signal) {
      const questions = Object.fromEntries(
        Object.entries(request.questions).map(([key, question]) => [key, toJev(question)]),
      );
      const legacy = await client.evaluate({ state: request.state, questions, signal });
      const answers: Record<string, JudgmentAnswer> = {};
      for (const key of Object.keys(request.questions)) {
        const answer = legacy[key];
        switch (answer?.kind) {
          case "noul":
            answers[key] = { kind: "binary", probability: answer.probability };
            break;
          case "choice":
            answers[key] = {
              kind: "categorical",
              choice: answer.choice,
              probabilities: answer.probabilities,
              confidence: answer.confidence,
            };
            break;
          case "score":
            answers[key] = {
              kind: "ordinal",
              score: answer.score,
              probabilities: answer.probabilities,
              confidence: answer.confidence,
            };
            break;
          default:
            throw new ProviderValidationError(`jev: missing answer for "${key}".`);
        }
      }
      return { provider: "jev", model: spec.model, answers };
    },
  };
}
