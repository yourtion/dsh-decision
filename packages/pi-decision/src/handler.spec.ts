import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GUARDRAIL_RISKS,
  GUARDRAIL_RISKS,
  type GuardrailFailure,
  type JudgmentProvider,
  type JudgmentResult,
} from "@techs/dsh-decision/kernel";
import { createToolCallHandler } from "./handler.js";
import { resolvePiGuardrailSpec } from "./spec.js";

function result(
  changes: Partial<Record<(typeof GUARDRAIL_RISKS)[number], number>> = {},
): JudgmentResult {
  return {
    provider: "fake",
    answers: Object.fromEntries(
      GUARDRAIL_RISKS.map((risk) => [risk, { kind: "binary", probability: changes[risk] ?? 0.01 }]),
    ),
  };
}

function provider(evaluate: JudgmentProvider["evaluate"]): JudgmentProvider {
  return {
    id: "fake",
    capabilities: () => ({ binary: true, categorical: false, ordinal: false }),
    evaluate,
  };
}

const call = { toolName: "bash", input: { command: "echo ok" } };
const logger = { info: vi.fn(), warn: vi.fn() };

describe("pi tool guardrail", () => {
  it("uses shared risk questions and allows low-risk calls in enforce mode", async () => {
    const evaluate = vi.fn<JudgmentProvider["evaluate"]>(async () => result());
    const signal = new AbortController().signal;
    const handler = createToolCallHandler(
      provider(evaluate),
      resolvePiGuardrailSpec({ PI_DECISION_ENFORCEMENT: "enforce" }),
      logger,
    );

    expect(await handler(call, signal)).toBeUndefined();
    const [request, passedSignal] = evaluate.mock.calls[0]!;
    expect(Object.keys(request.questions)).toEqual([...GUARDRAIL_RISKS]);
    expect(request.state).toEqual({ tool: "bash", arguments: call.input });
    expect(passedSignal).toBe(signal);
    expect(call.input).toEqual({ command: "echo ok" });
  });

  it.each([
    [{ destructive: 0.9 }, "destructive"],
    [{ privacyExposure: 0.4 }, "Human review required"],
  ] as const)("blocks risk %s", async (risks, reason) => {
    const handler = createToolCallHandler(
      provider(async () => result(risks)),
      resolvePiGuardrailSpec({ PI_DECISION_ENFORCEMENT: "enforce" }),
      logger,
    );
    const outcome = await handler(call);
    expect(outcome).toMatchObject({ block: true });
    expect(outcome?.reason).toContain(reason);
  });

  it("keeps shadow calls non-blocking while still evaluating", async () => {
    let finish!: (value: JudgmentResult) => void;
    const evaluate = vi.fn(
      () =>
        new Promise<JudgmentResult>((resolve) => {
          finish = resolve;
        }),
    );
    const info = vi.fn();
    const handler = createToolCallHandler(provider(evaluate), resolvePiGuardrailSpec({}), {
      info,
      warn: vi.fn(),
    });
    expect(await handler(call)).toBeUndefined();
    expect(evaluate).toHaveBeenCalledOnce();
    finish(result({ destructive: 0.9 }));
    await vi.waitFor(() =>
      expect(info).toHaveBeenCalledWith(expect.stringContaining("would deny")),
    );
  });

  it.each(["allow", "ask", "deny"] as const)(
    "applies %s on provider failure",
    async (onFailure: GuardrailFailure) => {
      const spec = resolvePiGuardrailSpec({
        PI_DECISION_ENFORCEMENT: "enforce",
        PI_DECISION_ON_FAILURE: onFailure,
      });
      const handler = createToolCallHandler(
        provider(async () => {
          throw new Error("unavailable");
        }),
        spec,
        logger,
      );
      const outcome = await handler(call);
      if (onFailure === "allow") expect(outcome).toBeUndefined();
      else expect(outcome).toMatchObject({ block: true });
      if (onFailure === "ask") expect(outcome?.reason).toContain("human review");
    },
  );

  it("skips tools outside the configured set", async () => {
    const evaluate = vi.fn(async () => result({ destructive: 0.9 }));
    const spec = resolvePiGuardrailSpec({
      PI_DECISION_ENFORCEMENT: "enforce",
      PI_DECISION_TOOLS: "write, edit",
    });
    expect(spec.guardrail.risks).toBe(DEFAULT_GUARDRAIL_RISKS);
    expect(await createToolCallHandler(provider(evaluate), spec, logger)(call)).toBeUndefined();
    expect(evaluate).not.toHaveBeenCalled();
  });
});
