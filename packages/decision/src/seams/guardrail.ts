/** Multi-dimensional tool-risk judgment with a deterministic policy. */
import { createHash } from "node:crypto";
import type { DecisionState } from "../types.js";
import type { JudgmentRequest, JudgmentResult } from "../judgment.js";
import type { GuardrailSpec } from "../config.js";
import { redactValue, type OutboundPrivacy } from "../privacy/sanitizer.js";
import {
  evaluateGuardrailPolicy,
  type PolicyDecision,
  type RiskDefinition,
} from "../policy/risk.js";

export type GuardrailVerdict = PolicyDecision;

/** Evidence supplied by a trusted host for exactly one proposed tool action. */
export interface GuardrailActionAuthorization {
  readonly toolName: string;
  readonly argumentsHash: string;
  readonly workspaceRoot: string;
  readonly environment?: string;
  readonly granted: true;
}

/** Context from the host, kept separate from untrusted tool arguments. */
export interface ToolDecisionContext {
  readonly userRequest?: string;
  readonly workspaceRoot?: string;
  readonly environment?: string;
  /** Must come from the host's approval record, never tool arguments or reason text. */
  readonly authorization?: GuardrailActionAuthorization;
}

export interface PreparedGuardrailRequest {
  readonly request: JudgmentRequest;
  readonly redactions: number;
  readonly unknownRisks: readonly string[];
  readonly authorizedExternalSideEffect: boolean;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

/** Stable fingerprint of the exact tool name and lossless JSON arguments. */
export function guardrailActionHash(
  toolName: string,
  args: unknown,
  context?: Pick<ToolDecisionContext, "userRequest" | "workspaceRoot" | "environment">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        toolName,
        canonicalize(args),
        context?.userRequest ?? null,
        context?.workspaceRoot ?? null,
        context?.environment ?? null,
      ]),
    )
    .digest("hex");
}

/**
 * Build the outbound request and decision metadata together. Authorization is
 * checked locally and never sent to the judgment provider. Redaction covers
 * tool name, arguments, and every contextual field in the outbound state.
 */
export function prepareGuardrailRequest(
  toolName: string,
  args: unknown,
  risks: readonly RiskDefinition[],
  context?: ToolDecisionContext,
  outboundPrivacy: OutboundPrivacy = "redact",
): PreparedGuardrailRequest {
  const hasUserRequest =
    typeof context?.userRequest === "string" && context.userRequest.trim() !== "";
  const unknownRisks = risks
    .filter(
      (risk) =>
        (risk.key === "scopeViolation" && !hasUserRequest) ||
        (risk.key === "externalSideEffect" && !context?.workspaceRoot?.trim()),
    )
    .map((risk) => risk.key);
  const rawState: Record<string, DecisionState> = {
    tool: toolName,
    arguments: args as DecisionState,
    ...(hasUserRequest ? { userRequest: context!.userRequest! } : {}),
    ...(context?.workspaceRoot ? { workspaceRoot: context.workspaceRoot } : {}),
    ...(context?.environment ? { environment: context.environment } : {}),
  };
  const sanitized =
    outboundPrivacy === "redact" ? redactValue(rawState) : { value: rawState, count: 0 };
  const state: Record<string, DecisionState> = { ...sanitized.value };
  if (sanitized.count > 0) {
    state.redactionNotice =
      "[REDACTED:kind] replaces a detected secret value. The placeholder marks the original data category; it is not the secret and does not itself establish disclosure.";
  }
  const authorization = context?.authorization;
  const authorizedExternalSideEffect =
    authorization?.granted === true &&
    authorization.toolName === toolName &&
    typeof context?.workspaceRoot === "string" &&
    context.workspaceRoot.trim() !== "" &&
    authorization.workspaceRoot === context.workspaceRoot &&
    authorization.environment === context.environment &&
    authorization.argumentsHash === guardrailActionHash(toolName, args, context);
  return {
    request: {
      state,
      questions: Object.fromEntries(
        risks
          .filter((risk) => risk.key !== "scopeViolation" || hasUserRequest)
          .map((risk) => [
            risk.key,
            {
              kind: "binary" as const,
              instructions: risk.instructions,
              ...(risk.criteria === undefined ? {} : { criteria: risk.criteria }),
            },
          ]),
      ),
    },
    redactions: sanitized.count,
    unknownRisks,
    authorizedExternalSideEffect,
  };
}

/** Compatibility helper for callers that only need the request. */
export function buildGuardrailRequest(
  toolName: string,
  args: unknown,
  risks: readonly RiskDefinition[],
  context?: ToolDecisionContext,
): JudgmentRequest {
  const prepared = prepareGuardrailRequest(toolName, args, risks, context);
  const unavailable = new Set(prepared.unknownRisks);
  return {
    ...prepared.request,
    questions: Object.fromEntries(
      Object.entries(prepared.request.questions).filter(([key]) => !unavailable.has(key)),
    ),
  };
}

export function decideGuardrail(
  result: JudgmentResult,
  spec: GuardrailSpec,
  prepared?: Pick<PreparedGuardrailRequest, "unknownRisks" | "authorizedExternalSideEffect">,
): GuardrailVerdict {
  const unknown = new Set(
    prepared?.unknownRisks ??
      spec.risks
        .filter(
          (risk) =>
            (risk.key === "scopeViolation" || risk.key === "externalSideEffect") &&
            result.answers[risk.key] === undefined,
        )
        .map((risk) => risk.key),
  );
  const probabilities = Object.fromEntries(
    spec.risks
      .filter((risk) => !unknown.has(risk.key) || result.answers[risk.key] !== undefined)
      .map((risk) => {
        const answer = result.answers[risk.key];
        if (answer?.kind !== "binary") {
          throw new Error(`dsh-decision: guardrail expected a binary answer for "${risk.key}".`);
        }
        return [risk.key, answer.probability];
      }),
  );
  return evaluateGuardrailPolicy(probabilities, spec.risks, {
    unknownRisks: [...unknown],
    authorizedExternalSideEffect: prepared?.authorizedExternalSideEffect,
  });
}
