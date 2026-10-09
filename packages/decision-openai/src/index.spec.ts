import { Context } from "@deepseek-ai/cordis";
import DecisionLayer from "@techs/dsh-decision";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as openai from "./index.js";

afterEach(() => vi.unstubAllGlobals());

describe("dsh OpenAI plugin lifecycle", () => {
  it("registers a usable provider and unregisters it when unloaded", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        model: "gpt-6-luna",
        answers: [{ type: "predicate", name: "risk", probability: 0.1 }],
      }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const ctx = new Context();
    try {
      await ctx.plugin(DecisionLayer, { provider: "openai", audit: { enabled: false } });
      const fork = ctx.plugin(openai, { apiKey: "test-key" });
      await fork;
      const result = await ctx.decision.decision.evaluate({
        state: "evidence",
        questions: { risk: { kind: "binary", instructions: "Risk?" } },
      });
      expect(result.answers.risk).toEqual({ kind: "binary", probability: 0.1 });
      expect(result.provider).toBe("openai");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await fork.dispose();
      expect(() => ctx.decision.decision.provider()).toThrow(/not registered/);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
