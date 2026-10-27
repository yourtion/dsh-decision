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
  const values = Object.values(value) as number[];
  if (
    values.length !== allowed.length ||
    Math.abs(values.reduce((sum, p) => sum + p, 0) - 1) > 0.001
  ) {
    throw new ProviderValidationError(
      `${path} must cover every option and sum to 1 (tolerance 0.001).`,
    );
  }
}

/** Validate the shared contract before a provider performs network I/O. */
export function validateJudgmentRequest(request: JudgmentRequest): void {
  for (const [key, question] of Object.entries(request.questions)) {
    if (typeof question.instructions !== "string" || !question.instructions.trim()) {
      throw new ProviderValidationError(`Question ${JSON.stringify(key)} needs instructions.`);
    }
    switch (question.kind) {
      case "binary":
        if (
          question.criteria !== undefined &&
          (question.criteria === null ||
            typeof question.criteria !== "object" ||
            Object.values(question.criteria).some((value) => typeof value !== "string"))
        ) {
          throw new ProviderValidationError(
            `Question ${JSON.stringify(key)} has invalid binary criteria.`,
          );
        }
        break;
      case "categorical":
        if (
          question.options === null ||
          typeof question.options !== "object" ||
          Array.isArray(question.options) ||
          Object.keys(question.options).length === 0 ||
          Object.values(question.options).some(
            (value) => value !== null && typeof value !== "string",
          )
        ) {
          throw new ProviderValidationError(`Question ${JSON.stringify(key)} needs named options.`);
        }
        break;
      case "ordinal":
        if (
          !Array.isArray(question.levels) ||
          question.levels.length === 0 ||
          question.levels.some((value) => typeof value !== "string" || !value.trim())
        ) {
          throw new ProviderValidationError(
            `Question ${JSON.stringify(key)} needs ordered levels.`,
          );
        }
        break;
      default:
        throw new ProviderValidationError(`Question ${JSON.stringify(key)} has an unknown kind.`);
    }
  }
}

export function validateJudgmentAnswer(
  key: string,
  question: JudgmentQuestion,
  answer: JudgmentAnswer | undefined,
): void {
  if (answer === undefined || answer === null || answer.kind !== question.kind) {
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
      const expected = Object.entries(answer.probabilities).reduce(
        (total, [index, p]) => total + Number(index) * p,
        0,
      );
      if (Math.abs(answer.score - expected) > 0.001 * Math.max(1, question.levels.length - 1)) {
        throw new ProviderValidationError(
          `${key}.score must match probability-weighted level indices.`,
        );
      }
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
  for (const key of Object.keys(result.answers)) {
    if (!Object.hasOwn(request.questions, key)) {
      throw new ProviderValidationError(
        `Provider returned undeclared answer ${JSON.stringify(key)}.`,
      );
    }
  }
  for (const [key, question] of Object.entries(request.questions)) {
    validateJudgmentAnswer(
      key,
      question,
      Object.hasOwn(result.answers, key) ? result.answers[key] : undefined,
    );
  }
  if (result.usage !== undefined) {
    const usage = result.usage;
    if (
      !usage ||
      !Number.isSafeInteger(usage.inputTokens) ||
      usage.inputTokens < 0 ||
      !Number.isSafeInteger(usage.outputTokens) ||
      usage.outputTokens < 0 ||
      (usage.costUsd !== undefined &&
        (typeof usage.costUsd !== "number" || !Number.isFinite(usage.costUsd) || usage.costUsd < 0))
    ) {
      throw new ProviderValidationError("Provider returned invalid usage.");
    }
  }
}
