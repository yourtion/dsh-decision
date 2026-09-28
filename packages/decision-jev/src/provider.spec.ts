import { describe, expect, it } from "vitest";
import { createJevProvider } from "./provider.js";
import type { JevSpec } from "./config.js";

const spec: JevSpec = {
  baseUrl: "https://example.test",
  apiKey: "test-key",
  model: "jev-latest",
  timeoutMs: 1_000,
};

describe("Jev JudgmentProvider", () => {
  it("maps binary, categorical and ordinal questions in one request", async () => {
    let sent: unknown;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          answers: {
            risk: { type: "noul", noul: 0.2 },
            tier: {
              type: "choice",
              choice: "large",
              probabilities: { small: 0.1, large: 0.9 },
              confidence: 0.9,
            },
            severity: {
              type: "score",
              score: 1.5,
              probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 },
              confidence: 0.8,
            },
          },
        }),
      );
    }) as typeof fetch;
    const result = await createJevProvider(spec, fetchImpl).evaluate({
      state: { tool: "bash" },
      questions: {
        risk: {
          kind: "binary",
          instructions: "Risk?",
          criteria: { true: "Discloses a secret", false: "No secret disclosure" },
        },
        tier: {
          kind: "categorical",
          instructions: "Tier?",
          options: { small: null, large: null },
        },
        severity: {
          kind: "ordinal",
          instructions: "Severity?",
          levels: ["low", "medium", "high"],
        },
      },
    });
    const body = sent as { questions: Record<string, { type: string; criteria?: unknown }> };
    expect(body.questions.risk.type).toBe("noul");
    expect(body.questions.risk.criteria).toEqual({
      true: "Discloses a secret",
      false: "No secret disclosure",
    });
    expect(body.questions.tier.type).toBe("choice");
    expect(body.questions.severity).toMatchObject({
      type: "score",
      criteria: ["low", "medium", "high"],
    });
    expect(result.answers.risk).toEqual({ kind: "binary", probability: 0.2 });
    expect(result.answers.tier).toMatchObject({ kind: "categorical", choice: "large" });
    expect(result.answers.severity).toMatchObject({ kind: "ordinal", score: 1.5 });
    expect(result.requestedModel).toBe("jev-latest");
    expect(result.model).toBe("jev-latest");
    expect(result.resolvedModel).toBeUndefined();
  });

  it("keeps concurrent responses' actual model identity separate from the requested alias", async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const { state } = JSON.parse(init.body as string);
      await new Promise((resolve) => setTimeout(resolve, state === "first" ? 10 : 0));
      return new Response(
        JSON.stringify({
          model: `resolved-${state}`,
          answers: { risk: { type: "noul", noul: 0.1 } },
        }),
      );
    }) as typeof fetch;
    const provider = createJevProvider(spec, fetchImpl);
    const results = await Promise.all(
      ["first", "second"].map((state) =>
        provider.evaluate({
          state,
          questions: { risk: { kind: "binary", instructions: "Risk?" } },
        }),
      ),
    );
    expect(results.map((result) => result.resolvedModel)).toEqual([
      "resolved-first",
      "resolved-second",
    ]);
    expect(results.every((result) => result.requestedModel === "jev-latest")).toBe(true);
  });
});
