import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import { DecisionRuntime } from "./service.js";
import type { JudgmentProvider } from "./judgment.js";
import { GUARDRAIL_RISKS, evaluateGuardrailPolicy } from "./policy/risk.js";

const binaryRequest = {
  state: { tool: "bash" },
  questions: { destructive: { kind: "binary" as const, instructions: "Destructive?" } },
};

function provider(probability: number): JudgmentProvider {
  return {
    id: "jev",
    capabilities: () => ({ binary: true, categorical: false, ordinal: false }),
    evaluate: async () => ({
      provider: "jev",
      answers: { destructive: { kind: "binary", probability } },
    }),
  };
}

describe("provider runtime contract", () => {
  it("validates every answer before policy consumption", async () => {
    const runtime = new DecisionRuntime(resolveConfig({}));
    runtime.registerProvider(provider(0.5));
    expect((await runtime.evaluate(binaryRequest)).answers.destructive).toEqual({
      kind: "binary",
      probability: 0.5,
    });
    const invalid = new DecisionRuntime(resolveConfig({}));
    invalid.registerProvider(provider(Infinity));
    await expect(invalid.evaluate(binaryRequest)).rejects.toMatchObject({
      name: "ProviderValidationError",
    });
  });

  it("rejects unsupported questions before calling a provider", async () => {
    let calls = 0;
    const runtime = new DecisionRuntime(resolveConfig({}));
    runtime.registerProvider({
      ...provider(0),
      evaluate: async () => {
        calls += 1;
        return { provider: "jev", answers: {} };
      },
    });
    await expect(
      runtime.evaluate({
        state: "x",
        questions: {
          tier: { kind: "categorical", instructions: "Tier?", options: { small: null } },
        },
      }),
    ).rejects.toMatchObject({ name: "ProviderValidationError" });
    expect(calls).toBe(0);
  });

  it("times out a provider that ignores cancellation", async () => {
    const runtime = new DecisionRuntime(resolveConfig({ timeoutMs: 10 }));
    runtime.registerProvider({
      id: "jev",
      capabilities: () => ({ binary: true, categorical: false, ordinal: false }),
      evaluate: async () => new Promise(() => {}),
    });
    await expect(runtime.evaluate(binaryRequest)).rejects.toBeInstanceOf(Error);
  });

  it("produces identical policy results for identical validated judgments", () => {
    const risks = resolveConfig({}).guardrail.risks;
    const judgments = Object.fromEntries(
      GUARDRAIL_RISKS.map((risk) => [risk, risk === "privacyExposure" ? 0.4 : 0]),
    ) as Record<(typeof GUARDRAIL_RISKS)[number], number>;
    const first = evaluateGuardrailPolicy(judgments, risks);
    expect(evaluateGuardrailPolicy({ ...judgments }, risks)).toEqual(first);
    expect(first.policyVersion).toMatch(/^guardrail-v2\.0\.0:[0-9a-f]{64}$/);
    expect(
      evaluateGuardrailPolicy(judgments, {
        ...risks,
        privacyExposure: { ...risks.privacyExposure, reviewAt: 0.3 },
      }).policyVersion,
    ).not.toBe(first.policyVersion);
  });
});
