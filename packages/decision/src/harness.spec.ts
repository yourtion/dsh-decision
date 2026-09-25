import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";
import DecisionLayer from "./index.js";
import type { DecisionAdapter, DecisionAnswer } from "./types.js";

const agent = {} as Agent;
const signal = new AbortController().signal;
const message = (text: string): UserMessage =>
  ({ content: [{ type: "text", text }] }) as UserMessage;

async function layer(
  config: ConstructorParameters<typeof DecisionLayer>[1],
  adapter: DecisionAdapter,
) {
  const ctx = new Context();
  await ctx.plugin(DecisionLayer, config);
  ctx.decision.registerAdapter(adapter);
  return ctx;
}

describe("DSH event seam integration", () => {
  it("routes from the final accepted pre-step messages for the matching step", async () => {
    let seenTask: unknown;
    const ctx = await layer(
      {
        mode: "enforce",
        guardrail: { enabled: false },
        routing: {
          enabled: true,
          routes: [
            { key: "small", model: "small" },
            { key: "large", model: "large" },
          ],
        },
      },
      {
        id: "jev",
        calibrated: false,
        async evaluate(request) {
          seenTask = request.state;
          return {
            tier: {
              kind: "choice",
              choice: "large",
              probabilities: { small: 0.1, large: 0.9 },
              confidence: 0.9,
            },
          };
        },
      },
    );
    try {
      await ctx.waterfall(
        "agent/pre-step",
        { agent, turn: 2, step: 3, messages: [message("original")], signal },
        async () => ({ kind: "enter", messages: [message("accepted steering")] }),
      );
      const routed = await ctx.waterfall(
        "agent/request",
        { agent, turn: 2, step: 3, signal },
        async () => ({ provider: "default", model: "small" }),
      );
      expect(seenTask).toEqual({ task: "accepted steering" });
      expect(routed.model).toBe("large");
      const second = await ctx.waterfall(
        "agent/request",
        { agent, turn: 2, step: 4, signal },
        async () => ({ provider: "default", model: "small" }),
      );
      expect(second.model).toBe("small");
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("delegates its own guardrail review to human even when machine approval would allow", async () => {
    let approvalCalls = 0;
    const ctx = await layer(
      { mode: "enforce", approval: { enabled: true } },
      {
        id: "jev",
        calibrated: true,
        async evaluate(request): Promise<Readonly<Record<string, DecisionAnswer>>> {
          if (request.questions.harmful) {
            return {
              harmful: { kind: "noul", probability: 0.4 },
              exposure: { kind: "noul", probability: 0.1 },
            };
          }
          approvalCalls += 1;
          return { allow: { kind: "noul", probability: 0.99 } };
        },
      },
    );
    try {
      const pre = await ctx.waterfall(
        "tools/pre-execute",
        { name: "bash", arguments: { command: "echo hi" }, signal },
        async () => ({ kind: "allow" }),
      );
      expect(pre.kind).toBe("ask");
      const outcome = await ctx.waterfall(
        "approval/request",
        { agent, toolName: "bash", reason: pre.reason, signal },
        async () => "rejected",
      );
      expect(outcome).toBe("rejected");
      expect(approvalCalls).toBe(0);
      const nativeOutcome = await ctx.waterfall(
        "approval/request",
        { agent, toolName: "bash", reason: "native policy", signal },
        async () => "rejected",
      );
      expect(nativeOutcome).toBe("allowed-once");
      expect(approvalCalls).toBe(1);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("keeps native behavior while a shadow provider is pending or fails", async () => {
    let rejectEvaluation: ((reason: Error) => void) | undefined;
    const pending = new Promise<Readonly<Record<string, DecisionAnswer>>>((_, reject) => {
      rejectEvaluation = reject;
    });
    const ctx = await layer(
      {
        mode: "shadow",
        routing: { enabled: true, routes: [{ key: "large", model: "large" }] },
        judge: { enabled: true },
        approval: { enabled: true },
      },
      { id: "jev", calibrated: false, evaluate: async () => pending },
    );
    try {
      const pre = await ctx.waterfall(
        "tools/pre-execute",
        { name: "bash", arguments: {}, signal },
        async () => ({ kind: "deny", reason: "native policy" }),
      );
      expect(pre).toEqual({ kind: "deny", reason: "native policy" });
      await ctx.waterfall(
        "agent/pre-step",
        { agent, turn: 1, step: 1, messages: [message("current")], signal },
        async () => ({ kind: "enter", messages: [message("current")] }),
      );
      expect(
        await ctx.waterfall("agent/request", { agent, turn: 1, step: 1, signal }, async () => ({
          provider: "native",
          model: "small",
        })),
      ).toEqual({ provider: "native", model: "small" });
      expect(
        await ctx.waterfall(
          "tools/post-execute",
          { name: "bash", arguments: {}, signal },
          { content: [{ type: "text", text: "tool output" }] },
          async () => ({ kind: "accept" }),
        ),
      ).toEqual({ kind: "accept" });
      expect(
        await ctx.waterfall(
          "approval/request",
          { agent, toolName: "bash", reason: "native policy", signal },
          async () => "rejected",
        ),
      ).toBe("rejected");
      rejectEvaluation!(new Error("provider failed"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
