import {
  prepareGuardrailRequest,
  decideGuardrail,
  validateJudgmentResult,
  traceErrorKind,
  type DecisionTraceRecord,
  type JudgmentProvider,
  type TraceSink,
  type ToolDecisionContext,
} from "@techs/dsh-decision/kernel";
import type { PiGuardrailSpec } from "./spec.js";

export interface ToolCall {
  readonly toolName: string;
  readonly input: unknown;
  readonly context?: ToolDecisionContext;
}

export interface BlockedToolCall {
  readonly block: true;
  readonly reason: string;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

/** Host-independent handler: pi's review state has no approval waterfall, so it blocks. */
export function createToolCallHandler(
  provider: JudgmentProvider,
  spec: PiGuardrailSpec,
  logger: Logger,
  trace: TraceSink = { record: () => {} },
): (call: ToolCall, signal?: AbortSignal) => Promise<BlockedToolCall | undefined> {
  return async (call, signal) => {
    if (spec.guardrail.tools.size > 0 && !spec.guardrail.tools.has(call.toolName)) return;
    if (signal?.aborted) return;

    const prepared = prepareGuardrailRequest(
      call.toolName,
      call.input,
      spec.guardrail.risks,
      call.context,
      spec.outbound,
    );
    const audit = (fields: Omit<DecisionTraceRecord, "time" | "host" | "seam" | "mode">): void => {
      trace.record({
        time: new Date().toISOString(),
        host: "pi",
        seam: "guardrail",
        mode: spec.mode,
        tool: call.toolName,
        ...fields,
      });
    };

    const evaluate = async () => {
      const result =
        Object.keys(prepared.request.questions).length === 0
          ? { provider: provider.id, answers: {} }
          : await provider.evaluate(prepared.request, signal);
      validateJudgmentResult(prepared.request, result);
      return { result, verdict: decideGuardrail(result, spec.guardrail, prepared) };
    };
    if (spec.mode === "shadow") {
      void evaluate()
        .then(({ result, verdict }) => {
          if (verdict.action !== "allow") {
            logger.info(
              `pi-decision shadow: ${call.toolName} would ${verdict.action} (${verdict.reason}).`,
            );
          }
          audit({
            action: verdict.action,
            policyVersion: verdict.policyVersion,
            judgments: binaryJudgments(result),
            ...(prepared.redactions === 0 ? {} : { redactions: prepared.redactions }),
          });
        })
        .catch((error: unknown) => {
          logger.warn(
            `pi-decision shadow: evaluation failed for ${call.toolName}: ${String(error)}.`,
          );
          audit({ action: "error", errorKind: traceErrorKind(error) });
        });
      return;
    }

    try {
      const { result, verdict } = await evaluate();
      audit({
        action: verdict.action,
        policyVersion: verdict.policyVersion,
        judgments: binaryJudgments(result),
        ...(prepared.redactions === 0 ? {} : { redactions: prepared.redactions }),
      });
      if (verdict.action === "allow") return;
      return {
        block: true,
        reason:
          verdict.action === "review"
            ? `${verdict.reason} Human review required before running this tool call.`
            : verdict.reason,
      };
    } catch (error) {
      logger.warn(`pi-decision: evaluation failed for ${call.toolName}: ${String(error)}.`);
      audit({ action: "error", errorKind: traceErrorKind(error) });
      if (spec.guardrail.onFailure === "allow") return;
      return {
        block: true,
        reason:
          spec.guardrail.onFailure === "ask"
            ? "pi-decision: evaluation failed; human review required before running this tool call."
            : "pi-decision: evaluation failed; tool call denied.",
      };
    }
  };
}

/** Binary-answer probabilities by question key, for the audit record. */
function binaryJudgments(result: {
  answers: Readonly<Record<string, { kind: string; probability?: number }>>;
}): Record<string, number> {
  const judgments: Record<string, number> = {};
  for (const [key, answer] of Object.entries(result.answers)) {
    if (answer.kind === "binary") judgments[key] = answer.probability!;
  }
  return judgments;
}
