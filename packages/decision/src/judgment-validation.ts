import { ProviderValidationError } from "./types.js";
import type {
  JudgmentAnswer,
  JudgmentQuestion,
  JudgmentRequest,
  JudgmentResult,
} from "./judgment.js";

function probability(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ProviderValidationError(`${path} must be a finite probability in [0, 1].`);
  }
}

function distribution(value: unknown, allowed: readonly string[], path: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderValidationError(`${path} must be an object.`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.includes(key)) {
      throw new ProviderValidationError(`${path} contains undeclared option ${key}.`);
    }
    probability(item, `${path}.${key}`);
  }
}

export function validateJudgmentAnswer(
  key: string,
  question: JudgmentQuestion,
  answer: JudgmentAnswer | undefined,
): void {
  if (answer === undefined || answer.kind !== question.kind) {
    throw new ProviderValidationError(
      `Answer ${JSON.stringify(key)} is missing or has the wrong kind.`,
    );
  }
  switch (answer.kind) {
    case "binary":
      probability(answer.probability, `${key}.probability`);
      return;
    case "categorical":
      if (question.kind !== "categorical" || !Object.hasOwn(question.options, answer.choice)) {
        throw new ProviderValidationError(
          `Answer ${JSON.stringify(key)} chose an undeclared option.`,
        );
      }
      distribution(answer.probabilities, Object.keys(question.options), `${key}.probabilities`);
      if (answer.confidence !== undefined) probability(answer.confidence, `${key}.confidence`);
      return;
    case "ordinal":
      if (
        question.kind !== "ordinal" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > question.levels.length - 1
      ) {
        throw new ProviderValidationError(`Answer ${JSON.stringify(key)} has an invalid score.`);
      }
      distribution(
        answer.probabilities,
        question.levels.map((_, index) => String(index)),
        `${key}.probabilities`,
      );
      if (answer.confidence !== undefined) probability(answer.confidence, `${key}.confidence`);
  }
}

export function validateJudgmentResult(request: JudgmentRequest, result: JudgmentResult): void {
  if (
    result === null ||
    typeof result !== "object" ||
    result.answers === null ||
    typeof result.answers !== "object" ||
    Array.isArray(result.answers)
  ) {
    throw new ProviderValidationError("Provider returned no answers.");
  }
  for (const [key, question] of Object.entries(request.questions)) {
    validateJudgmentAnswer(key, question, result.answers[key]);
  }
}
