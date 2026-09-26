import { describe, expect, it } from "vitest";
import { GUARDRAIL_RISKS } from "@techs/dsh-decision/kernel";
import { resolvePiGuardrailSpec, resolvePiJevSpec, resolvePiRisks } from "./spec.js";

describe("pi Jev connection", () => {
  it("routes a Vercel key to the TypeSafe-compatible endpoint", () => {
    expect(resolvePiJevSpec({ JEV_API_KEY: "gateway-key" })).toMatchObject({
      apiKey: "gateway-key",
      baseUrl: "https://ai-gateway.vercel.sh/typesafe",
      model: "typesafe-ai/jev",
    });
    expect(
      resolvePiJevSpec({ JEV_API_KEY: "fallback", AI_GATEWAY_API_KEY: "preferred" }).apiKey,
    ).toBe("preferred");
  });

  it("keeps direct Jev opt-in and fails clearly without a key", () => {
    expect(
      resolvePiJevSpec({ PI_DECISION_JEV_BACKEND: "direct", JEV_API_KEY: "direct-key" }),
    ).toMatchObject({
      baseUrl: "https://jev-ai.pro/api",
      model: "jev-latest",
    });
    expect(() => resolvePiJevSpec({})).toThrow(/AI_GATEWAY_API_KEY/);
    expect(() => resolvePiJevSpec({ PI_DECISION_JEV_BACKEND: "direct" })).toThrow(/JEV_API_KEY/);
  });
});

describe("pi risk configuration", () => {
  it("defaults to the shared built-in set", () => {
    const spec = resolvePiGuardrailSpec({});
    expect(spec.guardrail.risks.map((risk) => risk.key)).toEqual([...GUARDRAIL_RISKS]);
    expect(spec.guardrail.policyVersion).toMatch(/^guardrail-v2\.\d+\.\d+:[0-9a-f]{64}$/);
  });

  it("parses PI_DECISION_RISKS JSON to disable and append dimensions", () => {
    const env = {
      PI_DECISION_RISKS: JSON.stringify({
        risks: { scopeViolation: { enabled: false } },
        customRisks: {
          financialExposure: {
            instructions: "Could this call move money?",
            reviewAt: 0.3,
            denyAt: 0.7,
          },
        },
      }),
    };
    const keys = resolvePiRisks(env).risks.map((risk) => risk.key);
    expect(keys).not.toContain("scopeViolation");
    expect(keys).toEqual([
      ...GUARDRAIL_RISKS.filter((risk) => risk !== "scopeViolation"),
      "financialExposure",
    ]);
  });

  it("fails loud on invalid JSON or incomplete custom risks", () => {
    expect(() => resolvePiRisks({ PI_DECISION_RISKS: "{nope" })).toThrow(/not valid JSON/);
    expect(() =>
      resolvePiRisks({
        PI_DECISION_RISKS: JSON.stringify({ customRisks: { a: { instructions: "x" } } }),
      }),
    ).toThrow(/requires explicit reviewAt and denyAt/);
  });
});
