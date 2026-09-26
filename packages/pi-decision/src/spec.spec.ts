import { describe, expect, it } from "vitest";
import { resolvePiJevSpec } from "./spec.js";

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
