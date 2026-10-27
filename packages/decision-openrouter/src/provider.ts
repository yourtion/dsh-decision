/** OpenRouter Decisions protocol, isolated from the native OpenAI wire format. */
import {
  DecisionError,
  ProviderValidationError,
  validateJudgmentRequest,
  validateJudgmentResult,
  type JudgmentAnswer,
  type JudgmentCapabilities,
  type JudgmentProvider,
  type JudgmentQuestion,
  type JudgmentRequest,
  type JudgmentResult,
} from "@techs/dsh-decision/kernel";
import type { OpenRouterSpec } from "./spec.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderValidationError("openrouter: expected an object in the decision response.");
  }
  return value as JsonObject;
}

function toWireQuestion(question: JudgmentQuestion): JsonObject {
  switch (question.kind) {
    case "binary":
      return {
        type: "noul",
        instructions: question.instructions,
        ...(question.criteria === undefined ? {} : { criteria: question.criteria }),
      };
    case "categorical":
      return { type: "choice", instructions: question.instructions, criteria: question.options };
    case "ordinal":
      return { type: "score", instructions: question.instructions, criteria: question.levels };
  }
}

function fromWireAnswer(raw: unknown, question: JudgmentQuestion): JudgmentAnswer {
  const answer = object(raw);
  if (answer.type === "refusal") {
    throw new ProviderValidationError("openrouter: a judgment question was refused.");
  }
  if (question.kind === "binary" && answer.type === "noul") {
    return { kind: "binary", probability: answer.noul as number };
  }
  // Optional confidence stays absent; it is not the winning option probability.
  const confidence =
    answer.confidence === undefined ? {} : { confidence: answer.confidence as number };
  if (question.kind === "categorical" && answer.type === "choice") {
    if (typeof answer.choice !== "string") {
      throw new ProviderValidationError("openrouter: choice must be a string.");
    }
    return {
      kind: "categorical",
      choice: answer.choice,
      probabilities: object(answer.probabilities) as Record<string, number>,
      ...confidence,
    };
  }
  if (question.kind === "ordinal" && answer.type === "score") {
    if (answer.legend !== undefined) {
      const legend = object(answer.legend);
      if (
        Object.keys(legend).length !== question.levels.length ||
        question.levels.some(
          (label, index) => !Object.hasOwn(legend, String(index)) || legend[index] !== label,
        )
      ) {
        throw new ProviderValidationError("openrouter: score legend does not match its rubric.");
      }
    }
    return {
      kind: "ordinal",
      score: answer.score as number,
      probabilities: object(answer.probabilities) as Record<string, number>,
      ...confidence,
    };
  }
  throw new ProviderValidationError("openrouter: answer type does not match the question.");
}

function fromWireResponse(
  raw: unknown,
  request: JudgmentRequest,
  spec: OpenRouterSpec,
): JudgmentResult {
  const payload = object(raw);
  const wireAnswers = object(payload.answers);
  if (typeof payload.model !== "string" || !payload.model.trim()) {
    throw new ProviderValidationError("openrouter: response has no model identity.");
  }
  for (const key of Object.keys(wireAnswers)) {
    if (!Object.hasOwn(request.questions, key)) {
      throw new ProviderValidationError("openrouter: response contains an undeclared answer.");
    }
  }
  const answers = Object.fromEntries(
    Object.entries(request.questions).map(([key, question]) => {
      if (!Object.hasOwn(wireAnswers, key)) {
        throw new ProviderValidationError("openrouter: response is missing a judgment answer.");
      }
      return [key, fromWireAnswer(wireAnswers[key], question)];
    }),
  );
  const usage = payload.usage === undefined ? undefined : object(payload.usage);
  const result: JudgmentResult = {
    // payload.provider identifies an upstream, not this registered adapter.
    provider: "openrouter",
    model: spec.model,
    requestedModel: spec.model,
    resolvedModel: payload.model,
    answers,
    ...(usage === undefined
      ? {}
      : {
          usage: {
            inputTokens: usage.input_tokens as number,
            outputTokens: usage.output_tokens as number,
            ...(usage.cost === undefined ? {} : { costUsd: usage.cost as number }),
          },
        }),
  };
  validateJudgmentResult(request, result);
  return result;
}

export class OpenRouterAdapter implements JudgmentProvider {
  readonly id = "openrouter";
  readonly model: string;
  readonly #spec: OpenRouterSpec;
  readonly #fetch: typeof fetch;

  constructor(spec: OpenRouterSpec, fetchImpl: typeof fetch = fetch) {
    this.#spec = spec;
    this.#fetch = fetchImpl;
    this.model = spec.model;
  }

  capabilities(): JudgmentCapabilities {
    return {
      binary: this.#spec.questionKinds.includes("binary"),
      categorical: this.#spec.questionKinds.includes("categorical"),
      ordinal: this.#spec.questionKinds.includes("ordinal"),
      calibration: [],
    };
  }

  async evaluate(request: JudgmentRequest, signal?: AbortSignal): Promise<JudgmentResult> {
    signal?.throwIfAborted();
    validateJudgmentRequest(request);
    const capabilities = this.capabilities();
    for (const question of Object.values(request.questions)) {
      if (!capabilities[question.kind]) {
        throw new ProviderValidationError(
          `openrouter: model is not configured for ${question.kind} questions.`,
        );
      }
    }
    const spec = this.#spec;
    if (Object.keys(request.questions).length === 0) {
      return { provider: this.id, model: spec.model, requestedModel: spec.model, answers: {} };
    }
    const body = JSON.stringify({
      model: spec.model,
      state: request.state,
      questions: Object.fromEntries(
        Object.entries(request.questions).map(([key, question]) => [key, toWireQuestion(question)]),
      ),
    });
    const gate = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(spec.timeoutMs),
    ]);
    gate.throwIfAborted();
    const ask = async (): Promise<JudgmentResult> => {
      let response: Response;
      try {
        response = await this.#fetch(`${spec.baseUrl.replace(/\/+$/, "")}/decisions`, {
          method: "POST",
          headers: { authorization: `Bearer ${spec.apiKey}`, "content-type": "application/json" },
          body,
          signal: gate,
        });
      } catch {
        gate.throwIfAborted();
        throw new DecisionError("openrouter: decision request failed.");
      }
      if (!response.ok) {
        // Never expose a body which could echo the key or private state.
        throw new DecisionError(`openrouter: HTTP ${response.status}.`, response.status);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        gate.throwIfAborted();
        throw new ProviderValidationError("openrouter: response is not JSON.");
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
  }
}

/** Factory matching the existing provider entry points. */
export function createOpenRouterProvider(
  spec: OpenRouterSpec,
  fetchImpl: typeof fetch = fetch,
): OpenRouterAdapter {
  return new OpenRouterAdapter(spec, fetchImpl);
}
