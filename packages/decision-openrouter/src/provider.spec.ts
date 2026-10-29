import { describe, expect, it, vi } from "vitest";
import {
  DecisionError,
  ProviderValidationError,
  type JudgmentRequest,
} from "@techs/dsh-decision/kernel";
import { OpenRouterAdapter } from "./provider.js";
import { resolveOpenRouterConfig } from "./spec.js";

const spec = resolveOpenRouterConfig({
  apiKey: "test-key",
  model: "baseten/elephant-1",
  timeoutMs: 1000,
});
const request: JudgmentRequest = {
  state: { ticket: "Cancel my subscription before next week." },
  questions: {
    cancel: {
      kind: "binary",
      instructions: "Requests cancellation?",
      criteria: { true: "Explicit request.", false: "No request." },
    },
    team: {
      kind: "categorical",
      instructions: "Which team?",
      options: { billing: "Subscriptions.", technical: null },
    },
    urgency: {
      kind: "ordinal",
      instructions: "How urgent?",
      levels: ["Routine", "This week", "Critical"],
    },
  },
};
const wireAnswers = () => ({
  cancel: { type: "noul", noul: 0.99 },
  team: {
    type: "choice",
    choice: "billing",
    probabilities: { billing: 0.9, technical: 0.1 },
    confidence: 0.8,
  },
  urgency: {
    type: "score",
    score: 1.1,
    probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
    legend: { "0": "Routine", "1": "This week", "2": "Critical" },
    confidence: 0.55,
  },
});
const reply = (answers: unknown = wireAnswers(), extra = {}) =>
  Response.json({
    provider: "BaseTen",
    model: "baseten/elephant-1-20261021",
    answers,
    usage: { input_tokens: 248, output_tokens: 3, cost: 0 },
    ...extra,
  });
const stalled = async () => ({ ok: true, json: () => new Promise(() => {}) }) as Response;

describe("OpenRouterAdapter", () => {
  it("uses the alpha endpoint and converts all three question types and metadata", async () => {
    const fetchImpl = vi.fn(async () => reply());
    const adapter = new OpenRouterAdapter(spec, fetchImpl);
    const result = await adapter.evaluate(request);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(init.headers).toEqual({
      authorization: "Bearer test-key",
      "content-type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      model: spec.model,
      state: request.state,
      questions: {
        cancel: {
          type: "noul",
          instructions: "Requests cancellation?",
          criteria: { true: "Explicit request.", false: "No request." },
        },
        team: {
          type: "choice",
          instructions: "Which team?",
          criteria: { billing: "Subscriptions.", technical: null },
        },
        urgency: {
          type: "score",
          instructions: "How urgent?",
          criteria: ["Routine", "This week", "Critical"],
        },
      },
    });
    expect(result).toEqual({
      provider: "openrouter",
      model: spec.model,
      requestedModel: spec.model,
      resolvedModel: "baseten/elephant-1-20261021",
      usage: { inputTokens: 248, outputTokens: 3, costUsd: 0 },
      answers: {
        cancel: { kind: "binary", probability: 0.99 },
        team: {
          kind: "categorical",
          choice: "billing",
          probabilities: { billing: 0.9, technical: 0.1 },
          confidence: 0.8,
        },
        urgency: {
          kind: "ordinal",
          score: 1.1,
          probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
          confidence: 0.55,
        },
      },
    });
    expect(adapter.capabilities()).toEqual({
      binary: true,
      categorical: true,
      ordinal: true,
      calibration: [],
    });
  });

  it("preserves absent confidence and usage instead of inventing values", async () => {
    const answers = wireAnswers();
    Reflect.deleteProperty(answers.team, "confidence");
    Reflect.deleteProperty(answers.urgency, "confidence");
    const result = await new OpenRouterAdapter(spec, async () =>
      reply(answers, { usage: undefined }),
    ).evaluate(request);
    expect(result.answers.team).not.toHaveProperty("confidence");
    expect(result.answers.urgency).not.toHaveProperty("confidence");
    expect(result).not.toHaveProperty("usage");
  });

  it.each([
    ["missing answer", { ...wireAnswers(), cancel: undefined }],
    ["undeclared answer", { ...wireAnswers(), extra: { type: "noul", noul: 0 } }],
    ["refusal", { ...wireAnswers(), cancel: { type: "refusal" } }],
    ["wrong type", { ...wireAnswers(), cancel: { type: "predicate", probability: 0.1 } }],
    ["out of range", { ...wireAnswers(), cancel: { type: "noul", noul: 1.1 } }],
    ["malformed answer", { ...wireAnswers(), cancel: null }],
    ["array answers", []],
    ["unknown choice", { ...wireAnswers(), team: { ...wireAnswers().team, choice: "other" } }],
    [
      "partial probabilities",
      { ...wireAnswers(), team: { ...wireAnswers().team, probabilities: { billing: 1 } } },
    ],
    [
      "invalid probabilities",
      {
        ...wireAnswers(),
        team: { ...wireAnswers().team, probabilities: { billing: "0.9", technical: 0.1 } },
      },
    ],
    [
      "sum mismatch",
      {
        ...wireAnswers(),
        team: { ...wireAnswers().team, probabilities: { billing: 0.5, technical: 0.1 } },
      },
    ],
    ["bad confidence", { ...wireAnswers(), team: { ...wireAnswers().team, confidence: null } }],
    ["score range", { ...wireAnswers(), urgency: { ...wireAnswers().urgency, score: 3 } }],
    ["score semantics", { ...wireAnswers(), urgency: { ...wireAnswers().urgency, score: 2 } }],
    [
      "wrong legend",
      {
        ...wireAnswers(),
        urgency: {
          ...wireAnswers().urgency,
          legend: { "0": "Wrong", "1": "This week", "2": "Critical" },
        },
      },
    ],
  ])("rejects %s", async (_name, answers) => {
    await expect(
      new OpenRouterAdapter(spec, async () => reply(answers)).evaluate(request),
    ).rejects.toBeInstanceOf(ProviderValidationError);
  });

  it.each([
    { model: undefined },
    { usage: null },
    { usage: { input_tokens: -1, output_tokens: 1 } },
    { usage: { input_tokens: 1, output_tokens: 1, cost: "0" } },
  ])("rejects invalid response metadata %j", async (extra) => {
    await expect(
      new OpenRouterAdapter(spec, async () => reply(wireAnswers(), extra)).evaluate(request),
    ).rejects.toBeInstanceOf(ProviderValidationError);
  });

  it("does not send empty batches, invalid questions or unsupported question kinds", async () => {
    const fetchImpl = vi.fn(async () => reply());
    const adapter = new OpenRouterAdapter({ ...spec, questionKinds: ["binary"] }, fetchImpl);
    expect((await adapter.evaluate({ state: null, questions: {} })).answers).toEqual({});
    await expect(adapter.evaluate(request)).rejects.toThrow(/categorical/);
    await expect(
      adapter.evaluate({
        state: null,
        questions: { a: { kind: "ordinal", instructions: "Rate", levels: [] } },
      }),
    ).rejects.toBeInstanceOf(ProviderValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("handles prototype-looking names as own keys", async () => {
    const questions = Object.fromEntries([
      [
        "__proto__",
        {
          kind: "categorical",
          instructions: "Choose",
          options: Object.fromEntries([
            ["__proto__", null],
            ["constructor", null],
          ]),
        },
      ],
    ]) as JudgmentRequest["questions"];
    const answers = Object.fromEntries([
      [
        "__proto__",
        {
          type: "choice",
          choice: "__proto__",
          probabilities: Object.fromEntries([
            ["__proto__", 0.9],
            ["constructor", 0.1],
          ]),
        },
      ],
    ]);
    const result = await new OpenRouterAdapter(spec, async () => reply(answers)).evaluate({
      state: "x",
      questions,
    });
    expect(Object.hasOwn(result.answers, "__proto__")).toBe(true);
    expect(result.answers.__proto__).toMatchObject({ kind: "categorical", choice: "__proto__" });
  });

  it("keeps concurrent model identities separate", async () => {
    const fetchImpl = (async (_url, init) => {
      const { state } = JSON.parse(init!.body as string);
      await new Promise((resolve) => setTimeout(resolve, state === "first" ? 10 : 0));
      return reply({ cancel: wireAnswers().cancel }, { model: `resolved-${state}` });
    }) as typeof fetch;
    const adapter = new OpenRouterAdapter(spec, fetchImpl);
    const results = await Promise.all(
      ["first", "second"].map((state) =>
        adapter.evaluate({ state, questions: { cancel: request.questions.cancel! } }),
      ),
    );
    expect(results.map((result) => result.resolvedModel)).toEqual([
      "resolved-first",
      "resolved-second",
    ]);
  });

  it("reports HTTP and network failures without echoing secrets and without paid fallback or retries", async () => {
    const fetchImpl = vi.fn(async () => new Response("secret request and key", { status: 429 }));
    await expect(new OpenRouterAdapter(spec, fetchImpl).evaluate(request)).rejects.toMatchObject({
      status: 429,
      message: "openrouter: HTTP 429.",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(
      new OpenRouterAdapter(spec, async () => {
        throw new Error("secret key");
      }).evaluate(request),
    ).rejects.toEqual(new DecisionError("openrouter: decision request failed."));
    await expect(
      new OpenRouterAdapter(spec, async () => new Response("secret body")).evaluate(request),
    ).rejects.toThrow("openrouter: response is not JSON.");
  });

  it("honors pre-abort, cancellation and timeout, including stalled response bodies", async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const adapter = new OpenRouterAdapter({ ...spec, timeoutMs: 20 }, fetchImpl);
    const pre = new AbortController();
    pre.abort();
    await expect(adapter.evaluate(request, pre.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = expect(adapter.evaluate(request, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await pending;
    await expect(adapter.evaluate(request)).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(
      new OpenRouterAdapter({ ...spec, timeoutMs: 20 }, stalled).evaluate(request),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
