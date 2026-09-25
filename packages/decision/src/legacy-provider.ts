/** Transitional bridge for v1 DecisionAdapter implementations. */
import type { DecisionAdapter, DecisionAnswer, DecisionQuestion } from "./types.js";
import type { JudgmentAnswer, JudgmentProvider, JudgmentQuestion } from "./judgment.js";
import { ProviderValidationError } from "./types.js";

function toLegacy(question: JudgmentQuestion): DecisionQuestion {
  switch (question.kind) {
    case "binary":
      return { kind: "noul", instructions: question.instructions, criteria: question.criteria };
    case "categorical":
      return { kind: "choice", instructions: question.instructions, options: question.options };
    case "ordinal":
      return { kind: "score", instructions: question.instructions, levels: question.levels };
  }
}

function fromLegacy(key: string, answer: DecisionAnswer | undefined): JudgmentAnswer {
  switch (answer?.kind) {
    case "noul":
      return { kind: "binary", probability: answer.probability };
    case "choice":
      return {
        kind: "categorical",
        choice: answer.choice,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
      };
    case "score":
      return {
        kind: "ordinal",
        score: answer.score,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
      };
    default:
      throw new ProviderValidationError(`Legacy adapter omitted answer ${JSON.stringify(key)}.`);
  }
}

export function legacyAdapterProvider(adapter: DecisionAdapter): JudgmentProvider {
  return {
    id: adapter.id,
    capabilities: () => ({ binary: true, categorical: true, ordinal: true }),
    async evaluate(request, signal) {
      const questions = Object.fromEntries(
        Object.entries(request.questions).map(([key, question]) => [key, toLegacy(question)]),
      );
      const answers = await adapter.evaluate({ state: request.state, questions, signal });
      return {
        provider: adapter.id,
        answers: Object.fromEntries(
          Object.keys(request.questions).map((key) => [key, fromLegacy(key, answers[key])]),
        ),
      };
    },
  };
}
