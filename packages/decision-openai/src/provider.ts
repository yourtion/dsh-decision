/** OpenAI Decisions wire adapter. Uses fetch, with no Cordis runtime dependency. */
import {
  DecisionError,
  ProviderValidationError,
  validateJudgmentResult,
  type JudgmentAnswer,
  type JudgmentProvider,
  type JudgmentQuestion,
  type JudgmentRequest,
  type JudgmentResult,
} from "@techs/dsh-decision/kernel";
import type { OpenAISpec } from "./spec.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderValidationError("openai: expected an object in the decision response.");
  }
  return value as JsonObject;
}

function probability(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ProviderValidationError(
      "openai: probabilities and confidence must be finite numbers in [0, 1].",
    );
  }
  return value;
}

function toWireQuestion(name: string, question: JudgmentQuestion): JsonObject {
  switch (question.kind) {
    case "binary": {
      // Decisions predicates have no separate criteria field.
      const instructions = [question.instructions];
      if (question.criteria?.true !== undefined)
        instructions.push(`True criteria: ${question.criteria.true}`);
      if (question.criteria?.false !== undefined)
        instructions.push(`False criteria: ${question.criteria.false}`);
      return { name, type: "predicate", instructions: instructions.join("\n\n") };
    }
    case "categorical": {
      const choices = Object.entries(question.options).map(([value, description]) => ({
        value,
        ...(description === null ? {} : { description }),
      }));
      if (choices.length === 0)
        throw new ProviderValidationError("openai: choice questions need options.");
      return { name, type: "choice", instructions: question.instructions, choices };
    }
    case "ordinal":
      if (question.levels.length === 0)
        throw new ProviderValidationError("openai: score questions need levels.");
      return {
        name,
        type: "score",
        instructions: question.instructions,
        levels: question.levels.map((label) => ({ label })),
      };
  }
}

function distribution(raw: unknown, question: JudgmentQuestion): Record<string, number> {
  if (!Array.isArray(raw))
    throw new ProviderValidationError("openai: probabilities must be an array.");
  const allowed =
    question.kind === "categorical"
      ? Object.keys(question.options)
      : question.kind === "ordinal"
        ? question.levels.map((_, i) => String(i))
        : [];
  const entries = new Map<string, number>();
  for (const value of raw) {
    const item = object(value);
    let key: string;
    if (question.kind === "categorical") {
      // Boolean choice values are distinct on the wire; our contract uses strings.
      if (typeof item.value !== "string")
        throw new ProviderValidationError("openai: choice values must be strings.");
      key = item.value;
    } else {
      if (typeof item.value !== "number" || !Number.isSafeInteger(item.value)) {
        throw new ProviderValidationError("openai: score level values must be integer indices.");
      }
      key = String(item.value);
      if (question.kind !== "ordinal" || item.label !== question.levels[item.value]) {
        throw new ProviderValidationError("openai: score level label does not match its rubric.");
      }
    }
    if (!allowed.includes(key) || entries.has(key)) {
      throw new ProviderValidationError("openai: duplicate or undeclared probability option.");
    }
    entries.set(key, probability(item.probability));
  }
  const sum = [...entries.values()].reduce((total, p) => total + p, 0);
  if (entries.size !== allowed.length || Math.abs(sum - 1) > 0.001) {
    throw new ProviderValidationError(
      "openai: probability distribution must cover every option and sum to 1 (tolerance 0.001).",
    );
  }
  // Preserve the API probabilities rather than manufacturing a normalized distribution.
  return Object.fromEntries(allowed.map((key) => [key, entries.get(key)!]));
}

function fromWireAnswer(answer: JsonObject, question: JudgmentQuestion): JudgmentAnswer {
  if (answer.type === "refusal")
    throw new ProviderValidationError("openai: a judgment question was refused.");
  if (question.kind === "binary" && answer.type === "predicate") {
    return { kind: "binary", probability: probability(answer.probability) };
  }
  if (question.kind === "categorical" && answer.type === "choice") {
    if (typeof answer.choice !== "string" || !Object.hasOwn(question.options, answer.choice)) {
      throw new ProviderValidationError("openai: answer chose an undeclared option.");
    }
    return {
      kind: "categorical",
      choice: answer.choice,
      confidence: probability(answer.confidence),
      probabilities: distribution(answer.probabilities, question),
    };
  }
  if (question.kind === "ordinal" && answer.type === "score") {
    const probabilities = distribution(answer.probabilities, question);
    const score = answer.score;
    const max = question.levels.length - 1;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > max) {
      throw new ProviderValidationError("openai: invalid expected score.");
    }
    const expected = Object.entries(probabilities).reduce(
      (total, [index, p]) => total + Number(index) * p,
      0,
    );
    if (Math.abs(score - expected) > 0.001 * Math.max(1, max)) {
      throw new ProviderValidationError(
        "openai: score does not match its probability-weighted level indices.",
      );
    }
    return { kind: "ordinal", score, confidence: probability(answer.confidence), probabilities };
  }
  throw new ProviderValidationError("openai: answer type does not match the question.");
}

function fromWireResponse(
  raw: unknown,
  request: JudgmentRequest,
  spec: OpenAISpec,
): JudgmentResult {
  const payload = object(raw);
  if (!Array.isArray(payload.answers))
    throw new ProviderValidationError("openai: response has no answers array.");
  if (typeof payload.model !== "string" || !payload.model.trim()) {
    throw new ProviderValidationError("openai: response has no model identity.");
  }
  const mapped = new Map<string, JudgmentAnswer>();
  for (const value of payload.answers) {
    const answer = object(value);
    const key = answer.name;
    if (typeof key !== "string" || !Object.hasOwn(request.questions, key) || mapped.has(key)) {
      throw new ProviderValidationError("openai: duplicate, unnamed or undeclared answer.");
    }
    mapped.set(key, fromWireAnswer(answer, request.questions[key]!));
  }
  if (mapped.size !== Object.keys(request.questions).length) {
    throw new ProviderValidationError("openai: missing judgment answers.");
  }
  const result = {
    provider: "openai",
    model: spec.model,
    requestedModel: spec.model,
    resolvedModel: payload.model,
    answers: Object.fromEntries(mapped),
  };
  validateJudgmentResult(request, result);
  return result;
}

export function createOpenAIProvider(
  spec: OpenAISpec,
  fetchImpl: typeof fetch = fetch,
): JudgmentProvider {
  return {
    id: "openai",
    model: spec.model,
    capabilities: () => ({ binary: true, categorical: true, ordinal: true, calibration: [] }),
    async evaluate(request, signal) {
      signal?.throwIfAborted();
      const questions = Object.entries(request.questions).map(([name, question]) =>
        toWireQuestion(name, question),
      );
      if (questions.length === 0)
        return { provider: "openai", model: spec.model, requestedModel: spec.model, answers: {} };
      const body = JSON.stringify({
        model: spec.model,
        input: typeof request.state === "string" ? request.state : JSON.stringify(request.state),
        questions,
      });
      const gate = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(spec.timeoutMs),
      ]);
      gate.throwIfAborted();
      const ask = async (): Promise<JudgmentResult> => {
        let response: Response;
        try {
          response = await fetchImpl(`${spec.baseUrl.replace(/\/+$/, "")}/decisions`, {
            method: "POST",
            headers: { authorization: `Bearer ${spec.apiKey}`, "content-type": "application/json" },
            body,
            signal: gate,
          });
        } catch {
          gate.throwIfAborted();
          throw new DecisionError("openai: decision request failed.");
        }
        if (!response.ok) {
          // Provider error bodies can echo secrets or tool arguments; expose status only.
          throw new DecisionError(`openai: HTTP ${response.status}.`, response.status);
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          gate.throwIfAborted();
          throw new ProviderValidationError("openai: response is not JSON.");
        }
        return fromWireResponse(payload, request, spec);
      };
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(gate.reason);
        if (gate.aborted) onAbort();
        else gate.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([ask(), aborted]);
      } finally {
        if (onAbort) gate.removeEventListener("abort", onAbort);
      }
    },
  };
}
