import { describe, expect, it } from "vitest";
import { resolveOpenAIConfig } from "./spec.js";

describe("OpenAI Decisions config", () => {
  it("uses OPENAI_API_KEY and the Decisions model by default", () => {
    expect(resolveOpenAIConfig({}, { OPENAI_API_KEY: "env-key" })).toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "env-key",
      model: "gpt-6-luna",
      timeoutMs: 8_000,
    });
  });
  it("supports an explicit key, custom env source and versioned gateway", () => {
    expect(
      resolveOpenAIConfig(
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
    });
    expect(
      resolveOpenAIConfig(
        { apiKeyEnv: "CUSTOM_KEY" },
        { CUSTOM_KEY: "custom", OPENAI_API_KEY: "other" },
      ).apiKey,
    ).toBe("custom");
    expect(() =>
      resolveOpenAIConfig({ apiKeyEnv: "MISSING" }, { OPENAI_API_KEY: "other" }),
    ).toThrow(/apiKey/);
  });
  it("fails on missing credentials and invalid settings", () => {
    expect(() => resolveOpenAIConfig({}, {})).toThrow(/OPENAI_API_KEY/);
    expect(() => resolveOpenAIConfig({ apiKey: " " }, {})).toThrow(/apiKey/);
    for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2 ** 32])
      expect(() => resolveOpenAIConfig({ apiKey: "x", timeoutMs }, {})).toThrow(/timeoutMs/);
    for (const baseUrl of [
      "invalid",
      "file:///tmp",
      "https://key@example.com/v1",
      "https://example.com/v1?key=x",
      "https://example.com/v1#x",
    ])
      expect(() => resolveOpenAIConfig({ apiKey: "x", baseUrl }, {})).toThrow(/baseUrl/);
    expect(() => resolveOpenAIConfig({ apiKey: "x", model: " " }, {})).toThrow(/model/);
  });
});
