import { Context } from "@deepseek-ai/cordis";
import DecisionLayer from "@techs/dsh-decision";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as openrouter from "./index.js";

afterEach(() => vi.unstubAllGlobals());

describe("dsh OpenRouter plugin lifecycle", () => {
  it("registers a usable provider and unregisters it when unloaded", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        model: "baseten/elephant-1",
        answers: { risk: { type: "noul", noul: 0.1 } },
      }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const ctx = new Context();
    try {
      await ctx.plugin(DecisionLayer, { provider: "openrouter", audit: { enabled: false } });
      const fork = ctx.plugin(openrouter, { apiKey: "test-key", model: "baseten/elephant-1" });
      await fork;
      const result = await ctx.decision.decision.evaluate({
        state: "evidence",
        questions: { risk: { kind: "binary", instructions: "Risk?" } },
      });
      expect(result.answers.risk).toEqual({ kind: "binary", probability: 0.1 });
      expect(result.provider).toBe("openrouter");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await fork.dispose();
      expect(() => ctx.decision.decision.provider()).toThrow(/not registered/);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
