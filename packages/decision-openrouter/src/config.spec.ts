import { describe, expect, it } from "vitest";
import { resolveOpenRouterConfig } from "./spec.js";

describe("OpenRouter Decisions config", () => {
  it("uses OPENROUTER_API_KEY with an explicitly selected Decisions model", () => {
    expect(
      resolveOpenRouterConfig({ model: "baseten/elephant-1" }, { OPENROUTER_API_KEY: "env-key" }),
    ).toEqual({
      baseUrl: "https://openrouter.ai/api/alpha",
      apiKey: "env-key",
      model: "baseten/elephant-1",
      timeoutMs: 8_000,
      questionKinds: ["binary", "categorical", "ordinal"],
    });
  });
  it("supports an explicit key, custom env source and versioned gateway", () => {
    expect(
      resolveOpenRouterConfig(
        {
          apiKey: "literal",
          apiKeyEnv: "CUSTOM_KEY",
          baseUrl: "http://localhost:8000/v1/",
          model: "future-model",
          timeoutMs: 30000,
        },
        { CUSTOM_KEY: "custom" },
      ),
    ).toEqual({
      apiKey: "literal",
      baseUrl: "http://localhost:8000/v1",
      model: "future-model",
      timeoutMs: 30000,
      questionKinds: ["binary", "categorical", "ordinal"],
    });
    expect(
      resolveOpenRouterConfig(
        { apiKeyEnv: "CUSTOM_KEY", model: "x" },
        { CUSTOM_KEY: "custom", OPENROUTER_API_KEY: "other" },
      ).apiKey,
    ).toBe("custom");
    expect(() =>
      resolveOpenRouterConfig({ apiKeyEnv: "MISSING" }, { OPENROUTER_API_KEY: "other" }),
    ).toThrow(/apiKey/);
  });
  it("fails on missing credentials and invalid settings", () => {
    expect(() => resolveOpenRouterConfig({}, {})).toThrow(/OPENROUTER_API_KEY/);
    expect(() => resolveOpenRouterConfig({ apiKey: " " }, {})).toThrow(/apiKey/);
    for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2 ** 32])
      expect(() => resolveOpenRouterConfig({ apiKey: "x", model: "x", timeoutMs }, {})).toThrow(
        /timeoutMs/,
      );
    for (const baseUrl of [
      "invalid",
      "file:///tmp",
      "https://key@example.com/v1",
      "https://example.com/v1?key=x",
      "https://example.com/v1#x",
    ])
      expect(() => resolveOpenRouterConfig({ apiKey: "x", baseUrl }, {})).toThrow(/baseUrl/);
    expect(() => resolveOpenRouterConfig({ apiKey: "x", model: " " }, {})).toThrow(/model/);
    expect(() => resolveOpenRouterConfig({ apiKey: "x" }, {})).toThrow(/model/);
    expect(() =>
      resolveOpenRouterConfig({ apiKey: "x", model: "x", questionKinds: [] }, {}),
    ).toThrow(/questionKinds/);
  });
});
