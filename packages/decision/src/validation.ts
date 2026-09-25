import { ProviderValidationError } from "./types.js";
import type { DecisionAnswer, DecisionQuestion } from "./types.js";

function probability(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ProviderValidationError(`${path} must be a finite probability in [0, 1].`);
  }
}

function distribution(
  value: unknown,
  options: readonly string[],
  path: string,
): asserts value is Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderValidationError(`${path} must be an object.`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (!options.includes(key)) {
      throw new ProviderValidationError(
        `${path} contains undeclared option ${JSON.stringify(key)}.`,
      );
    }
    probability(item, `${path}.${key}`);
  }
}

export function validateAnswer(
  key: string,
  question: DecisionQuestion,
  answer: DecisionAnswer,
): void {
  if (answer.kind !== question.kind) {
    throw new ProviderValidationError(`Answer ${JSON.stringify(key)} has the wrong kind.`);
  }
  switch (answer.kind) {
    case "noul":
      probability(answer.probability, `${key}.probability`);
      return;
    case "choice":
      if (question.kind !== "choice" || !Object.hasOwn(question.options, answer.choice)) {
        throw new ProviderValidationError(
          `Answer ${JSON.stringify(key)} chose an undeclared option.`,
        );
      }
      distribution(answer.probabilities, Object.keys(question.options), `${key}.probabilities`);
      probability(answer.confidence, `${key}.confidence`);
      return;
    case "score":
      if (question.kind !== "score" || !Number.isFinite(answer.score)) {
        throw new ProviderValidationError(`Answer ${JSON.stringify(key)} has an invalid score.`);
      }
      distribution(answer.probabilities, question.levels, `${key}.probabilities`);
      probability(answer.confidence, `${key}.confidence`);
  }
}
