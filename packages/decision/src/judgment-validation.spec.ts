import { describe, expect, it } from "vitest";
import { validateJudgmentRequest, validateJudgmentResult } from "./judgment-validation.js";
import { ProviderValidationError } from "./types.js";
import type { JudgmentRequest, JudgmentResult } from "./judgment.js";

const request: JudgmentRequest = {
  state: "evidence",
  questions: {
    route: { kind: "categorical", instructions: "Choose a route", options: { a: null, b: null } },
    severity: { kind: "ordinal", instructions: "Rate severity", levels: ["Low", "High"] },
  },
};
const result: JudgmentResult = {
  provider: "test",
  answers: {
    route: { kind: "categorical", choice: "a", probabilities: { a: 0.8, b: 0.2 }, confidence: 0.7 },
    severity: { kind: "ordinal", score: 0.7, probabilities: { "0": 0.3, "1": 0.7 } },
  },
};

describe("shared judgment contract", () => {
  it("preserves fractional scores and optional confidence without modifying probabilities", () => {
    validateJudgmentRequest(request);
    const before = JSON.stringify(result);
    validateJudgmentResult(request, result);
    expect(JSON.stringify(result)).toBe(before);
  });

  it.each([
    { ...result, answers: { ...result.answers, extra: { kind: "binary", probability: 0 } } },
    { ...result, answers: { severity: result.answers.severity! } },
    {
      ...result,
      answers: {
        ...result.answers,
        route: { kind: "categorical", choice: "a", probabilities: { a: 1 } },
      },
    },
    {
      ...result,
      answers: {
        ...result.answers,
        severity: { kind: "ordinal", score: 1, probabilities: { "0": 0.3, "1": 0.7 } },
      },
    },
    { ...result, usage: { inputTokens: 0.5, outputTokens: 1 } },
    { ...result, usage: { inputTokens: 1, outputTokens: 1, costUsd: -1 } },
  ])("rejects a broken contract", (broken) => {
    expect(() => validateJudgmentResult(request, broken as JudgmentResult)).toThrow(
      ProviderValidationError,
    );
  });

  it("rejects invalid question definitions before network I/O", () => {
    for (const question of [
      { kind: "binary", instructions: "" },
      { kind: "binary", instructions: "Check", criteria: { true: 42 } },
      { kind: "categorical", instructions: "Choose", options: {} },
      { kind: "ordinal", instructions: "Rate", levels: [] },
    ])
      expect(() =>
        validateJudgmentRequest({ state: null, questions: { q: question } } as JudgmentRequest),
      ).toThrow(ProviderValidationError);
  });
});
