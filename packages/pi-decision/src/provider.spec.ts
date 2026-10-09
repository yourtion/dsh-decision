import { describe, expect, it, vi } from "vitest";
import { createPiProvider } from "./provider.js";
import { resolvePiGuardrailSpec, resolvePiOpenAISpec } from "./spec.js";
import { createToolCallHandler } from "./handler.js";

describe("pi provider selection", () => {
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
