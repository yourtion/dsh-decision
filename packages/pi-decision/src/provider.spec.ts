import { describe, expect, it, vi } from "vitest";
import { createPiProvider } from "./provider.js";
import { resolvePiGuardrailSpec, resolvePiOpenAISpec, resolvePiOpenRouterSpec } from "./spec.js";
import { createToolCallHandler } from "./handler.js";

describe("pi provider selection", () => {
  it("selects OpenRouter independently and validates its explicit model and timeout", () => {
    const env = {
      PI_DECISION_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "key",
      PI_DECISION_OPENROUTER_MODEL: "baseten/elephant-1",
    };
    expect(createPiProvider(env).id).toBe("openrouter");
    expect(resolvePiOpenRouterSpec(env)).toMatchObject({
      baseUrl: "https://openrouter.ai/api/alpha",
      model: env.PI_DECISION_OPENROUTER_MODEL,
    });
    expect(() =>
      createPiProvider({ ...env, OPENROUTER_API_KEY: undefined, OPENAI_API_KEY: "other" }),
    ).toThrow(/OPENROUTER_API_KEY/);
    expect(() => createPiProvider({ ...env, PI_DECISION_OPENROUTER_MODEL: undefined })).toThrow(
      /model/,
    );
    for (const value of ["0", "-1", "1.5", "NaN", "1e3", "4294967296"]) {
      expect(() =>
        resolvePiOpenRouterSpec({ ...env, PI_DECISION_OPENROUTER_TIMEOUT_MS: value }),
      ).toThrow(/(TIMEOUT_MS|timeoutMs)/);
    }
  });

  it("runs OpenRouter through Pi's redaction, audit and failure policy", async () => {
    const env = {
      PI_DECISION_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "key",
      PI_DECISION_OPENROUTER_MODEL: "baseten/elephant-1",
      PI_DECISION_ENFORCEMENT: "enforce",
      PI_DECISION_ON_FAILURE: "deny",
    };
    let refuse = false;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      expect(JSON.stringify(body.state)).not.toContain("very-secret-value-123456789");
      expect(
        Object.values(body.questions).every((q) => (q as { type: string }).type === "noul"),
      ).toBe(true);
      return Response.json({
        model: "resolved-free-model",
        answers: Object.fromEntries(
          Object.keys(body.questions).map((key) => [
            key,
            refuse ? { type: "refusal" } : { type: "noul", noul: 0.01 },
          ]),
        ),
      });
    });
    const trace = { record: vi.fn() };
    const handler = createToolCallHandler(
      createPiProvider(env, fetchImpl),
      resolvePiGuardrailSpec(env),
      { info: vi.fn(), warn: vi.fn() },
      trace,
    );
    const call = {
      toolName: "read",
      input: { path: "README.md", note: "Bearer very-secret-value-123456789" },
      context: { userRequest: "Read README.md.", workspaceRoot: "/project" },
    };
    expect(await handler(call)).toBeUndefined();
    expect(trace.record).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "pi",
        judgments: expect.objectContaining({ secretExposure: 0.01 }),
      }),
    );
    refuse = true;
    expect(await handler(call)).toEqual({
      block: true,
      reason: "pi-decision: evaluation failed; tool call denied.",
    });
    expect(trace.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "error", errorKind: "validation" }),
    );
  });
  it("retains Jev as default and explicitly selects OpenAI without Jev credentials", () => {
    expect(createPiProvider({ AI_GATEWAY_API_KEY: "gateway" }).id).toBe("jev");
    expect(createPiProvider({ PI_DECISION_PROVIDER: "openai", OPENAI_API_KEY: "openai" }).id).toBe(
      "openai",
    );
    expect(() => createPiProvider({ OPENAI_API_KEY: "openai" })).toThrow(/AI_GATEWAY_API_KEY/);
    expect(() =>
      createPiProvider({ PI_DECISION_PROVIDER: "openai", AI_GATEWAY_API_KEY: "gateway" }),
    ).toThrow(/OPENAI_API_KEY/);
    expect(() => createPiProvider({ PI_DECISION_PROVIDER: "unknown" })).toThrow(
      /PI_DECISION_PROVIDER/,
    );
  });
  it("resolves independent OpenAI settings and validates timeout", () => {
    expect(
      resolvePiOpenAISpec({
        OPENAI_API_KEY: "key",
        PI_DECISION_OPENAI_BASE_URL: "https://gateway.test/v1",
        PI_DECISION_OPENAI_MODEL: "custom",
        PI_DECISION_OPENAI_TIMEOUT_MS: "1234",
      }),
    ).toEqual({
      apiKey: "key",
      baseUrl: "https://gateway.test/v1",
      model: "custom",
      timeoutMs: 1234,
    });
    for (const value of ["0", "-1", "1.5", "NaN", "1e3", "4294967296"])
      expect(() =>
        resolvePiOpenAISpec({ OPENAI_API_KEY: "key", PI_DECISION_OPENAI_TIMEOUT_MS: value }),
      ).toThrow(/(TIMEOUT_MS|timeoutMs)/);
  });

  it("passes redacted guardrail evidence to Decisions and audits an enforce result", async () => {
    let body: { input: string; questions: { name: string; type: string }[] } | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(init!.body as string);
      return Response.json({
        model: "gpt-6-luna",
        answers: body!.questions.map(({ name }) => ({
          name,
          type: "predicate",
          probability: 0.01,
        })),
      });
    });
    const env = {
      PI_DECISION_PROVIDER: "openai",
      OPENAI_API_KEY: "key",
      PI_DECISION_ENFORCEMENT: "enforce",
    };
    const trace = { record: vi.fn() };
    const handler = createToolCallHandler(
      createPiProvider(env, fetchImpl),
      resolvePiGuardrailSpec(env),
      { info: vi.fn(), warn: vi.fn() },
      trace,
    );
    await handler({
      toolName: "read",
      input: { path: "README.md", note: "Bearer very-secret-value-123456789" },
      context: { userRequest: "Read README.md.", workspaceRoot: "/project" },
    });
    expect(body!.input).not.toContain("very-secret-value-123456789");
    expect(body!.questions).toHaveLength(6);
    expect(body!.questions.every((q) => q.type === "predicate")).toBe(true);
    expect(trace.record).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "pi",
        seam: "guardrail",
        judgments: expect.objectContaining({ secretExposure: 0.01 }),
      }),
    );
  });

  it("routes a per-question refusal through the configured failure policy", async () => {
    const env = {
      PI_DECISION_PROVIDER: "openai",
      OPENAI_API_KEY: "key",
      PI_DECISION_ENFORCEMENT: "enforce",
      PI_DECISION_ON_FAILURE: "deny",
    };
    const fetchImpl = vi.fn(async () =>
      Response.json({ model: "gpt-6-luna", answers: [{ type: "refusal", name: "destructive" }] }),
    );
    const trace = { record: vi.fn() };
    const handler = createToolCallHandler(
      createPiProvider(env, fetchImpl),
      resolvePiGuardrailSpec(env),
      { info: vi.fn(), warn: vi.fn() },
      trace,
    );
    expect(await handler({ toolName: "read", input: { path: "README.md" } })).toEqual({
      block: true,
      reason: "pi-decision: evaluation failed; tool call denied.",
    });
    expect(trace.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "error", errorKind: "validation" }),
    );
  });
});
