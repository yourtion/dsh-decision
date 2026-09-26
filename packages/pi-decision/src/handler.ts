import {
  buildGuardrailRequest,
  decideGuardrail,
  type JudgmentProvider,
} from "@techs/dsh-decision/kernel";
import type { PiGuardrailSpec } from "./spec.js";

export interface ToolCall {
  readonly toolName: string;
  readonly input: unknown;
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
): (call: ToolCall, signal?: AbortSignal) => Promise<BlockedToolCall | undefined> {
  return async (call, signal) => {
    if (spec.guardrail.tools.size > 0 && !spec.guardrail.tools.has(call.toolName)) return;
    if (signal?.aborted) return;

    const evaluate = async () => {
      const result = await provider.evaluate(
        buildGuardrailRequest(call.toolName, call.input),
        signal,
      );
      return decideGuardrail(result, spec.guardrail);
    };
    if (spec.mode === "shadow") {
      void evaluate()
        .then((verdict) => {
          if (verdict.action !== "allow") {
            logger.info(
              `pi-decision shadow: ${call.toolName} would ${verdict.action} (${verdict.reason}).`,
            );
          }
        })
        .catch((error: unknown) =>
          logger.warn(
            `pi-decision shadow: evaluation failed for ${call.toolName}: ${String(error)}.`,
          ),
        );
      return;
    }

    try {
      const verdict = await evaluate();
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
