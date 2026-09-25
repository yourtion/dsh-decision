import { describe, expect, it } from "vitest";
import { resolveJevConfig } from "./config.js";

describe("jev config resolution", () => {
  it("defaults the endpoint, model, and timeout", () => {
    process.env.DSH_DECISION_TEST_KEY = "from-env";
    try {
      const spec = resolveJevConfig({ apiKeyEnv: "DSH_DECISION_TEST_KEY" });
      expect(spec).toEqual({
        baseUrl: "https://jev-ai.pro/api",
        apiKey: "from-env",
        model: "jev-latest",
        timeoutMs: 8_000,
      });
    } finally {
      delete process.env.DSH_DECISION_TEST_KEY;
    }
  });

  it("prefers a literal key and fails loud without either source", () => {
    expect(resolveJevConfig({ apiKey: "literal" }).apiKey).toBe("literal");
    expect(() => resolveJevConfig({})).toThrow(/key/);
    expect(() => resolveJevConfig({ apiKeyEnv: "DSH_DECISION_TEST_KEY" })).toThrow(/key/);
  });
});
