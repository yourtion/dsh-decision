import { describe, expect, it, vi } from "vitest";
import {
  DecisionError,
  ProviderValidationError,
  type JudgmentRequest,
} from "@techs/dsh-decision/kernel";
import { createOpenAIProvider } from "./provider.js";
import { resolveOpenAIConfig } from "./spec.js";

const spec = resolveOpenAIConfig({ apiKey: "test-key", baseUrl: "https://example.test/v1/" }, {});
const request: JudgmentRequest = {
  state: { tool: "bash", arguments: { command: "ls" } },
  questions: {
    risk: {
      kind: "binary",
      instructions: "Discloses a secret?",
      criteria: {
        true: "A usable secret leaves the host.",
        false: "No usable secret leaves the host.",
      },
    },
    tier: {
      kind: "categorical",
      instructions: "Choose a tier.",
      options: { small: null, large: "Requires deep reasoning." },
    },
    severity: {
      kind: "ordinal",
      instructions: "Rate severity.",
      levels: ["low", "medium", "high"],
    },
  },
};
const binaryRequest: JudgmentRequest = {
  state: "evidence",
  questions: { risk: request.questions.risk! },
};
const wireAnswers = () => [
  { type: "predicate", name: "risk", probability: 0.2 },
  {
    type: "choice",
    name: "tier",
    choice: "large",
    probabilities: [
      { value: "small", probability: 0.1 },
      { value: "large", probability: 0.9 },
    ],
    confidence: 0.8,
  },
  {
    type: "score",
    name: "severity",
    score: 1.1,
    probabilities: [
      { value: 0, label: "low", probability: 0.1 },
      { value: 1, label: "medium", probability: 0.7 },
      { value: 2, label: "high", probability: 0.2 },
    ],
    confidence: 0.55,
  },
];
const reply = (answers: unknown = wireAnswers(), model: unknown = "gpt-6-luna-resolved") =>
  Response.json({ model, answers });
const providerWith = (answers: unknown, model: unknown = "gpt-6-luna-resolved") =>
  createOpenAIProvider(
    spec,
    vi.fn(async () => reply(answers, model)),
  );

describe("OpenAI Decisions provider", () => {
  it("posts all three native question types and maps answers by name", async () => {
    const fetchImpl = vi.fn(async () => reply(wireAnswers().toReversed()));
    const provider = createOpenAIProvider(spec, fetchImpl);
    const result = await provider.evaluate(request);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://example.test/v1/decisions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      authorization: "Bearer test-key",
      "content-type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt-6-luna",
      input: JSON.stringify(request.state),
      questions: [
        {
          name: "risk",
          type: "predicate",
          instructions:
            "Discloses a secret?\n\nTrue criteria: A usable secret leaves the host.\n\nFalse criteria: No usable secret leaves the host.",
        },
        {
          name: "tier",
          type: "choice",
          instructions: "Choose a tier.",
          choices: [
            { value: "small" },
            { value: "large", description: "Requires deep reasoning." },
          ],
        },
        {
          name: "severity",
          type: "score",
          instructions: "Rate severity.",
          levels: [{ label: "low" }, { label: "medium" }, { label: "high" }],
        },
      ],
    });
    expect(result).toEqual({
      provider: "openai",
      model: "gpt-6-luna",
      requestedModel: "gpt-6-luna",
      resolvedModel: "gpt-6-luna-resolved",
      answers: {
        risk: { kind: "binary", probability: 0.2 },
        tier: {
          kind: "categorical",
          choice: "large",
          probabilities: { small: 0.1, large: 0.9 },
          confidence: 0.8,
        },
        severity: {
          kind: "ordinal",
          score: 1.1,
          probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
          confidence: 0.55,
        },
      },
    });
    expect(provider.capabilities()).toEqual({
      binary: true,
      categorical: true,
      ordinal: true,
      calibration: [],
    });
  });

  it("preserves string input and handles an empty batch without a request", async () => {
    const fetchImpl = vi.fn(async () => reply([wireAnswers()[0]]));
    const provider = createOpenAIProvider(spec, fetchImpl);
    await provider.evaluate(binaryRequest);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string).input).toBe("evidence");
    expect((await provider.evaluate({ state: null, questions: {} })).answers).toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", []],
    ["duplicate", [wireAnswers()[0], wireAnswers()[0]]],
    ["unnamed", [{ ...wireAnswers()[0], name: null }]],
    ["undeclared", [{ ...wireAnswers()[0], name: "other" }]],
    ["wrong type", [{ ...wireAnswers()[0], type: "choice" }]],
    ["refused", [{ name: "risk", type: "refusal" }]],
    ["out of range", [{ ...wireAnswers()[0], probability: 1.01 }]],
    ["string probability", [{ ...wireAnswers()[0], probability: "0.2" }]],
    ["non-object", [null]],
    ["non-array", {}],
  ])("rejects %s answers", async (_name, answers) => {
    await expect(providerWith(answers).evaluate(binaryRequest)).rejects.toBeInstanceOf(
      ProviderValidationError,
    );
  });

  it.each([
    ["incomplete distribution", { probabilities: [{ value: "large", probability: 1 }] }],
    [
      "duplicate option",
      {
        probabilities: [
          { value: "large", probability: 0.5 },
          { value: "large", probability: 0.5 },
        ],
      },
    ],
    [
      "boolean option",
      {
        probabilities: [
          { value: false, probability: 0.1 },
          { value: "large", probability: 0.9 },
        ],
      },
    ],
    [
      "undeclared option",
      {
        probabilities: [
          { value: "other", probability: 0.1 },
          { value: "large", probability: 0.9 },
        ],
      },
    ],
    [
      "invalid sum",
      {
        probabilities: [
          { value: "small", probability: 0.1 },
          { value: "large", probability: 0.5 },
        ],
      },
    ],
    [
      "negative probability",
      {
        probabilities: [
          { value: "small", probability: -0.1 },
          { value: "large", probability: 1.1 },
        ],
      },
    ],
    ["unknown choice", { choice: "other" }],
    ["boolean choice", { choice: true }],
    ["missing confidence", { confidence: undefined }],
    ["invalid confidence", { confidence: 2 }],
  ])("rejects a choice with %s", async (_name, fields) => {
    await expect(
      providerWith([{ ...wireAnswers()[1], ...fields }]).evaluate({
        state: "x",
        questions: { tier: request.questions.tier! },
      }),
    ).rejects.toBeInstanceOf(ProviderValidationError);
  });

  it.each([
    ["score range", { score: 3 }],
    ["score semantics", { score: 2 }],
    ["string index", { probabilities: [{ value: "0", label: "low", probability: 1 }] }],
    ["label mismatch", { probabilities: [{ value: 0, label: "high", probability: 1 }] }],
  ])("rejects invalid ordinal %s", async (_name, fields) => {
    await expect(
      providerWith([{ ...wireAnswers()[2], ...fields }]).evaluate({
        state: "x",
        questions: { severity: request.questions.severity! },
      }),
    ).rejects.toBeInstanceOf(ProviderValidationError);
  });

  it("rejects missing model identity and malformed JSON without echoing output", async () => {
    await expect(providerWith([wireAnswers()[0]], null).evaluate(binaryRequest)).rejects.toThrow(
      /model identity/,
    );
    const fetchImpl = vi.fn(async () => new Response("secret-model-output"));
    await expect(createOpenAIProvider(spec, fetchImpl).evaluate(binaryRequest)).rejects.toThrow(
      "openai: response is not JSON.",
    );
  });

  it("reports HTTP status without including the provider error body", async () => {
    const fetchImpl = vi.fn(async () => new Response("secret-key-and-arguments", { status: 429 }));
    const error = await createOpenAIProvider(spec, fetchImpl)
      .evaluate(binaryRequest)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DecisionError);
    expect(error).toMatchObject({ status: 429, message: "openai: HTTP 429." });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("honors pre-abort, cancellation and timeout even when fetch ignores the signal", async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const provider = createOpenAIProvider({ ...spec, timeoutMs: 20 }, fetchImpl);
    const pre = new AbortController();
    pre.abort();
    await expect(provider.evaluate(binaryRequest, pre.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = provider.evaluate(binaryRequest, controller.signal);
    const stopped = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await stopped;
    await expect(provider.evaluate(binaryRequest)).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("times out a stalled response body and rejects invalid question sets before sending", async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: true, json: () => new Promise(() => {}) }) as Response,
    );
    const provider = createOpenAIProvider({ ...spec, timeoutMs: 20 }, fetchImpl);
    await expect(provider.evaluate(binaryRequest)).rejects.toMatchObject({ name: "TimeoutError" });
    for (const question of [
      { kind: "categorical", instructions: "x", options: {} },
      { kind: "ordinal", instructions: "x", levels: [] },
    ] as const) {
      await expect(
        provider.evaluate({ state: "x", questions: { invalid: question } }),
      ).rejects.toBeInstanceOf(ProviderValidationError);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps concurrent resolved model identities separate", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      await new Promise((resolve) => setTimeout(resolve, body.input === "first" ? 10 : 0));
      return reply([wireAnswers()[0]], `resolved-${body.input}`);
    });
    const provider = createOpenAIProvider(spec, fetchImpl);
    const results = await Promise.all(
      ["first", "second"].map((state) => provider.evaluate({ ...binaryRequest, state })),
    );
    expect(results.map((r) => r.resolvedModel)).toEqual(["resolved-first", "resolved-second"]);
  });

  it("handles prototype-looking question and option names as ordinary own keys", async () => {
    const question = {
      kind: "categorical",
      instructions: "x",
      options: Object.fromEntries([
        ["__proto__", null],
        ["constructor", null],
      ]),
    } as const;
    const provider = providerWith([
      {
        type: "choice",
        name: "__proto__",
        choice: "__proto__",
        confidence: 0.9,
        probabilities: [
          { value: "__proto__", probability: 0.9 },
          { value: "constructor", probability: 0.1 },
        ],
      },
    ]);
    const result = await provider.evaluate({
      state: "x",
      questions: Object.fromEntries([["__proto__", question]]),
    });
    expect(Object.hasOwn(result.answers, "__proto__")).toBe(true);
    expect(result.answers.__proto__).toMatchObject({
      choice: "__proto__",
      probabilities: { constructor: 0.1 },
    });
  });
});
