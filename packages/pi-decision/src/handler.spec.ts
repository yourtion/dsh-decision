import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GUARDRAIL_RISKS,
  GUARDRAIL_RISKS,
  type DecisionTraceRecord,
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
    [{ privacyExposure: 0.7 }, "Human review required"],
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
    expect(spec.guardrail.risks.map((risk) => [risk.key, risk.reviewAt, risk.denyAt])).toEqual(
      GUARDRAIL_RISKS.map((risk) => [
        risk,
        DEFAULT_GUARDRAIL_RISKS[risk].reviewAt,
        DEFAULT_GUARDRAIL_RISKS[risk].denyAt,
      ]),
    );
    expect(await createToolCallHandler(provider(evaluate), spec, logger)(call)).toBeUndefined();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("redacts secrets in tool input before the provider sees them", async () => {
    const evaluate = vi.fn<JudgmentProvider["evaluate"]>(async () => result());
    const secretCall = {
      toolName: "bash",
      input: { command: "echo ok", headers: { authorization: "Bearer abcdef1234567890" } },
    };
    const handler = createToolCallHandler(
      provider(evaluate),
      resolvePiGuardrailSpec({ PI_DECISION_ENFORCEMENT: "enforce" }),
      logger,
    );
    await handler(secretCall, new AbortController().signal);
    const [request] = evaluate.mock.calls[0]!;
    expect(JSON.stringify(request.state)).not.toContain("abcdef1234567890");
    expect(secretCall.input.headers.authorization).toBe("Bearer abcdef1234567890");
  });

  it("keeps raw input under outbound=raw", async () => {
    const evaluate = vi.fn<JudgmentProvider["evaluate"]>(async () => result());
    const secretCall = { toolName: "bash", input: { api_key: "abcdefgh12345678" } };
    const handler = createToolCallHandler(
      provider(evaluate),
      resolvePiGuardrailSpec({ PI_DECISION_ENFORCEMENT: "enforce", PI_DECISION_OUTBOUND: "raw" }),
      logger,
    );
    await handler(secretCall);
    expect(evaluate.mock.calls[0]![0].state).toEqual({ tool: "bash", arguments: secretCall.input });
  });

  it("writes a sanitized audit record per verdict", async () => {
    const records: DecisionTraceRecord[] = [];
    const handler = createToolCallHandler(
      provider(async () => result({ destructive: 0.9 })),
      resolvePiGuardrailSpec({ PI_DECISION_ENFORCEMENT: "enforce" }),
      logger,
      { record: (r) => records.push(r) },
    );
    const outcome = await handler({
      toolName: "bash",
      input: { command: "rm -rf /tmp/x", api_key: "abcdefgh12345678" },
    });
    expect(outcome).toMatchObject({ block: true });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      host: "pi",
      seam: "guardrail",
      mode: "enforce",
      tool: "bash",
      action: "deny",
    });
    expect(records[0]!.judgments).toMatchObject({ destructive: 0.9 });
    expect(records[0]!.redactions).toBe(1);
    expect(JSON.stringify(records)).not.toContain("abcdefgh12345678");
    expect(JSON.stringify(records)).not.toContain("rm -rf");
  });
});
