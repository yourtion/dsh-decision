/**
 * Decision layer for dsh: provider-agnostic typed judgments behind four
 * waterfall seams (tool guardrail, model routing, result judging, machine
 * approval). Jev (TypeSafe System One) is the first adapter.
 * @module dsh-decision
 */

import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type { PreToolDecision, ToolExecution, ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import type { LlmCallConfig } from "@deepseek-ai/dsh-llm";
import type { ApprovalRequestEvent, ApprovalOutcome } from "@deepseek-ai/dsh-user-approval/types";
import { Config, resolveConfig } from "./config.js";
import type { DecisionMode, GuardrailFailure, ResolvedConfig } from "./config.js";
import { DecisionRuntime } from "./service.js";
import { buildGuardrailRequest, decideGuardrail } from "./seams/guardrail.js";
import { buildRoutingRequest, decideRouting } from "./seams/routing.js";
import { buildJudgeRequest, decideJudge, judgeFeedback } from "./seams/judge.js";
import { buildMachineApprovalRequest, decideMachineApproval } from "./seams/approval.js";
import { approvalPolicyVersion, trustedForAutoAllow } from "./policy/approval.js";
import { StepContextStore, taskHint } from "./context/step-context.js";
import { isDecisionEscalation, markDecisionEscalation } from "./context/provenance.js";
import { redactText, redactValue } from "./privacy/sanitizer.js";
import {
  JsonlTraceSink,
  NULL_TRACE_SINK,
  traceErrorKind,
  type DecisionTraceRecord,
  type TraceSeam,
  type TraceSink,
} from "./trace/trace.js";
import type { DecisionAdapter } from "./types.js";
import type { JudgmentProvider } from "./judgment.js";

export { Config, resolveConfig } from "./config.js";
export type {
  Config as DecisionConfig,
  DecisionMode,
  EnforcementMode,
  PermissionMode,
  UncertainPolicy,
  GuardrailFailure,
  ResolvedConfig,
  RouteConfig,
  PrivacyConfig,
  AuditConfig,
} from "./config.js";
export { DecisionRuntime } from "./service.js";
export { DecisionError, ProviderValidationError } from "./types.js";
export { validateAnswer } from "./validation.js";
export { validateJudgmentResult } from "./judgment-validation.js";
export { redactText, redactValue } from "./privacy/sanitizer.js";
export type { OutboundPrivacy, RedactionResult } from "./privacy/sanitizer.js";
export {
  JsonlTraceSink,
  NULL_TRACE_SINK,
  defaultAuditPath,
  traceErrorKind,
} from "./trace/trace.js";
export type { DecisionTraceRecord, TraceErrorKind, TraceSeam, TraceSink } from "./trace/trace.js";
export {
  GUARDRAIL_RISKS,
  GUARDRAIL_POLICY_VERSION,
  guardrailPolicyVersion,
  evaluateRisk,
  evaluateGuardrailPolicy,
} from "./policy/risk.js";
export {
  APPROVAL_POLICY_VERSION,
  approvalPolicyVersion,
  trustedForAutoAllow,
  evaluateMachineApproval,
} from "./policy/approval.js";
export type { MachineApprovalDecision } from "./policy/approval.js";
export type { GuardrailRisk, RiskThresholds, PolicyDecision, PolicyEngine } from "./policy/risk.js";
export type {
  BinaryQuestion,
  CategoricalQuestion,
  OrdinalQuestion,
  BinaryAnswer,
  CategoricalAnswer,
  OrdinalAnswer,
  JudgmentQuestion,
  JudgmentAnswer,
  JudgmentRequest,
  JudgmentResult,
  JudgmentProvider,
  JudgmentCapabilities,
  CalibrationProfile,
  JudgmentDomain,
} from "./judgment.js";
export type { DecisionOrigin } from "./context/provenance.js";
export type {
  DecisionAdapter,
  DecisionAnswer,
  DecisionQuestion,
  DecisionRequest,
  DecisionState,
  NoulAnswer,
  NoulQuestion,
  ChoiceAnswer,
  ChoiceQuestion,
  ScoreAnswer,
  ScoreQuestion,
} from "./types.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Decision-layer adapter registry; register future decision models here. */
    decision: DecisionLayer;
  }
  interface Events {
    /** Sanitized outcome of one judgment, mirrored from the audit trace. */
    "decision/trace"(this: Context, record: DecisionTraceRecord): void | Promise<void>;
  }
}

/** Binary-answer probabilities by question key, for the audit record. */
function binaryJudgments(result: import("./judgment.js").JudgmentResult): Record<string, number> {
  const judgments: Record<string, number> = {};
  for (const [key, answer] of Object.entries(result.answers)) {
    if (answer.kind === "binary") judgments[key] = answer.probability;
  }
  return judgments;
}

/**
 * The decision-layer service. Loading resolves configuration (fail loud)
 * and installs the enabled seams. Provider plugins register separately. In
 * `shadow` mode every seam calls its decision model and logs the verdict
 * while delegating `next()` unchanged.
 */
export default class DecisionLayer extends Service {
  static Config: z<Config> = Config;

  readonly decision: DecisionRuntime;
  readonly #spec: ResolvedConfig;
  readonly #stepContexts = new StepContextStore();
  readonly #trace: TraceSink;

  constructor(ctx: Context, config: Config) {
    super(ctx, "decision");
    const spec = (this.#spec = resolveConfig(config));
    this.decision = new DecisionRuntime(spec);
    this.#trace = spec.audit.enabled
      ? new JsonlTraceSink(spec.audit.path, (message) => this.ctx.logger.warn(message))
      : NULL_TRACE_SINK;
    if (spec.enforcement === "enforce") {
      this.ctx.logger.warn(
        "decision: enforce is experimental — guardrail thresholds are not calibrated; review the audit trace before trusting verdicts.",
      );
    }
    if (spec.guardrail.enabled) this.#installGuardrail();
    if (spec.routing.enabled) this.#installRouting();
    if (spec.judge.enabled) this.#installJudge();
    if (spec.approval.enabled) this.#installApproval();
  }

  /** Provider plugins register through the Cordis service visible as `ctx.decision`. */
  registerAdapter(adapter: DecisionAdapter): () => void {
    return this.decision.registerAdapter(adapter);
  }

  registerProvider(provider: JudgmentProvider): () => void {
    return this.decision.registerProvider(provider);
  }

  /** Apply the outbound privacy policy to a deep-frozen judgment state value. */
  #redact<T>(value: T): { value: T; count: number } {
    if (this.#spec.privacy.outbound === "raw") return { value, count: 0 };
    return redactValue(value);
  }

  /** Apply the outbound privacy policy to a string (hints, reasons, results). */
  #redactString(value: string): { value: string; count: number } {
    if (this.#spec.privacy.outbound === "raw") return { value, count: 0 };
    return redactText(value);
  }

  /** Persist and publish one sanitized audit record; failures stay contained. */
  #audit(
    seam: TraceSeam,
    fields: Omit<DecisionTraceRecord, "time" | "host" | "seam" | "mode">,
  ): void {
    const record: DecisionTraceRecord = {
      time: new Date().toISOString(),
      host: "dsh",
      seam,
      mode: this.#spec.enforcement,
      ...fields,
    };
    this.#trace.record(record);
    void this.ctx.parallel("decision/trace", record);
  }

  /** Enforce or observe: map a guardrail verdict onto a pre-execute decision. */
  #applyGuardrail(
    action: "allow" | "deny" | "review",
    reason: string | undefined,
    mode: DecisionMode,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> | PreToolDecision {
    if (mode === "shadow" || action === "allow") return next();
    if (action === "deny") return { kind: "deny", reason: reason ?? "decision-layer: denied." };
    return { kind: "ask", reason: markDecisionEscalation(reason) };
  }

  #installGuardrail(): void {
    const spec = this.#spec;
    const guardrail = spec.guardrail;
    this.ctx.on(
      "tools/pre-execute",
      async (exec: ToolExecution, next): Promise<PreToolDecision> => {
        if (guardrail.tools.size > 0 && !guardrail.tools.has(exec.name)) return next();
        if (exec.signal.aborted) return next();
        const safeArgs = this.#redact(exec.arguments);
        const sessionId = exec.agent?.id;
        const base = { tool: exec.name, ...(sessionId === undefined ? {} : { sessionId }) };
        if (spec.mode === "shadow") {
          void Promise.resolve()
            .then(async () => {
              const result = await this.decision.evaluate(
                buildGuardrailRequest(exec.name, safeArgs.value),
                exec.signal,
              );
              const verdict = decideGuardrail(result, guardrail);
              if (verdict.action !== "allow") {
                this.ctx.logger.info(
                  `decision shadow: ${exec.name} would ${verdict.action} (${verdict.driver} ${verdict.probability?.toFixed(2)}).`,
                );
              }
              this.#audit("guardrail", {
                ...base,
                action: verdict.action,
                policyVersion: verdict.policyVersion,
                judgments: binaryJudgments(result),
                ...(safeArgs.count === 0 ? {} : { redactions: safeArgs.count }),
              });
            })
            .catch((error: unknown) => {
              this.ctx.logger.warn(
                `decision shadow: guardrail evaluation failed: ${String(error)}.`,
              );
              this.#audit("guardrail", {
                ...base,
                action: "error",
                errorKind: traceErrorKind(error),
              });
            });
          return next();
        }
        try {
          const result = await this.decision.evaluate(
            buildGuardrailRequest(exec.name, safeArgs.value),
            exec.signal,
          );
          const verdict = decideGuardrail(result, guardrail);
          this.#audit("guardrail", {
            ...base,
            action: verdict.action,
            policyVersion: verdict.policyVersion,
            judgments: binaryJudgments(result),
            ...(safeArgs.count === 0 ? {} : { redactions: safeArgs.count }),
          });
          return this.#applyGuardrail(verdict.action, verdict.reason, spec.mode, next);
        } catch (error) {
          this.#audit("guardrail", { ...base, action: "error", errorKind: traceErrorKind(error) });
          return this.#guardrailFailure(error, guardrail.onFailure, exec.name, next);
        }
      },
      { prepend: true },
    );
  }

  /** Adapter failure stance: log once, then allow/ask/deny per config (shadow always allows). */
  #guardrailFailure(
    error: unknown,
    onFailure: GuardrailFailure,
    toolName: string,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> | PreToolDecision {
    this.ctx.logger.warn(
      `decision: guardrail evaluation failed for ${toolName}: ${String(error)}.`,
    );
    if (this.#spec.mode === "shadow" || onFailure === "allow") return next();
    if (onFailure === "deny")
      return { kind: "deny", reason: `decision-layer: evaluation failed (${String(error)}).` };
    return {
      kind: "ask",
      reason: markDecisionEscalation(
        `decision-layer: evaluation failed; human review (${String(error)}).`,
      ),
    };
  }

  #installRouting(): void {
    const spec = this.#spec;
    const routing = spec.routing;
    this.ctx.on("agent/pre-step", async ({ agent, turn, step }, next) => {
      const accepted = await next();
      this.#stepContexts.record(agent, turn, step, accepted);
      return accepted;
    });
    this.ctx.on("agent/disposed", ({ agent }) => this.#stepContexts.clear(agent));
    this.ctx.on("agent/request", async ({ agent, turn, step, signal }, next) => {
      const fallback: LlmCallConfig = await next();
      if (signal.aborted) return fallback;
      const hint = taskHint(this.#stepContexts.take(agent, turn, step)?.messages ?? []);
      if (hint === undefined) return fallback;
      const safeHint = this.#redactString(hint);
      const base = { sessionId: agent.id };
      if (spec.mode === "shadow") {
        void Promise.resolve()
          .then(async () => {
            const result = await this.decision.evaluate(
              buildRoutingRequest(safeHint.value, routing.routes),
              signal,
            );
            const routed = decideRouting(result, routing, fallback);
            if (routed !== fallback) {
              this.ctx.logger.info(
                `decision shadow: would route to ${routed.provider}/${routed.model}.`,
              );
            }
            this.#audit("routing", {
              ...base,
              action: routed === fallback ? "fallback" : `route:${routed.provider}/${routed.model}`,
              ...(safeHint.count === 0 ? {} : { redactions: safeHint.count }),
            });
          })
          .catch((error: unknown) => {
            this.ctx.logger.warn(`decision shadow: routing evaluation failed: ${String(error)}.`);
            this.#audit("routing", { ...base, action: "error", errorKind: traceErrorKind(error) });
          });
        return fallback;
      }
      try {
        const result = await this.decision.evaluate(
          buildRoutingRequest(safeHint.value, routing.routes),
          signal,
        );
        const routed = decideRouting(result, routing, fallback);
        this.#audit("routing", {
          ...base,
          action: routed === fallback ? "fallback" : `route:${routed.provider}/${routed.model}`,
          ...(safeHint.count === 0 ? {} : { redactions: safeHint.count }),
        });
        return routed;
      } catch (error) {
        this.ctx.logger.warn(
          `decision: routing evaluation failed, keeping default: ${String(error)}.`,
        );
        this.#audit("routing", { ...base, action: "error", errorKind: traceErrorKind(error) });
        return fallback;
      }
    });
  }

  #installJudge(): void {
    const spec = this.#spec;
    const judge = spec.judge;
    this.ctx.on(
      "tools/post-execute",
      async (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next) => {
        if (judge.tools.size > 0 && !judge.tools.has(exec.name)) return next();
        if (result.content.length === 0) return next();
        const safeResult = this.#redact(result);
        const sessionId = exec.agent?.id;
        const base = { tool: exec.name, ...(sessionId === undefined ? {} : { sessionId }) };
        if (spec.mode === "shadow") {
          void Promise.resolve()
            .then(async () => {
              const judgment = await this.decision.evaluate(
                buildJudgeRequest(exec.name, safeResult.value),
                exec.signal,
              );
              const verdict = decideJudge(judgment, judge);
              if (verdict.action === "block") {
                this.ctx.logger.info(
                  `decision shadow: ${exec.name} result would be blocked (${verdict.pMax.toFixed(2)}).`,
                );
              }
              this.#audit("judge", {
                ...base,
                action: verdict.action,
                judgments: binaryJudgments(judgment),
                ...(safeResult.count === 0 ? {} : { redactions: safeResult.count }),
              });
            })
            .catch((error: unknown) => {
              this.ctx.logger.warn(`decision shadow: judge evaluation failed: ${String(error)}.`);
              this.#audit("judge", { ...base, action: "error", errorKind: traceErrorKind(error) });
            });
          return next();
        }
        try {
          const judgment = await this.decision.evaluate(
            buildJudgeRequest(exec.name, safeResult.value),
            exec.signal,
          );
          const verdict = decideJudge(judgment, judge);
          this.#audit("judge", {
            ...base,
            action: verdict.action,
            judgments: binaryJudgments(judgment),
            ...(safeResult.count === 0 ? {} : { redactions: safeResult.count }),
          });
          if (verdict.action === "accept") return next();
          return { kind: "block", feedback: judgeFeedback(verdict.reason) };
        } catch (error) {
          this.ctx.logger.warn(
            `decision: judge evaluation failed for ${exec.name}, accepting: ${String(error)}.`,
          );
          this.#audit("judge", { ...base, action: "error", errorKind: traceErrorKind(error) });
          return next();
        }
      },
    );
  }

  #installApproval(): void {
    const spec = this.#spec;
    const approval = spec.approval;
    const policyVersion = approvalPolicyVersion(approval, spec.machine.uncertain);
    this.ctx.on(
      "approval/request",
      async (req: ApprovalRequestEvent, next): Promise<ApprovalOutcome> => {
        if (spec.permission !== "machine") return next();
        if (isDecisionEscalation(req.reason)) {
          return spec.enforcement === "enforce" && spec.machine.uncertain === "deny"
            ? "rejected"
            : next();
        }
        const safeReason = this.#redactString(req.reason ?? "");
        const base = { tool: req.toolName, sessionId: req.agent.id };
        if (spec.enforcement === "shadow") {
          void Promise.resolve()
            .then(async () => {
              const result = await this.decision.evaluate(
                buildMachineApprovalRequest(req.toolName, safeReason.value),
                req.signal,
              );
              const qualified = trustedForAutoAllow(
                this.decision.provider().capabilities(),
                this.decision.provider().model,
                "approval",
                policyVersion,
              );
              const verdict = decideMachineApproval(
                result,
                approval,
                qualified,
                spec.machine.uncertain,
              );
              this.ctx.logger.info(`decision shadow: ${req.toolName} would ${verdict.action}.`);
              this.#audit("approval", {
                ...base,
                action: verdict.action,
                policyVersion,
                judgments: binaryJudgments(result),
              });
            })
            .catch((error: unknown) => {
              this.ctx.logger.warn(
                `decision shadow: approval evaluation failed: ${String(error)}.`,
              );
              this.#audit("approval", {
                ...base,
                action: "error",
                policyVersion,
                errorKind: traceErrorKind(error),
              });
            });
          return next();
        }
        let action: "allow" | "review" | "deny";
        try {
          const result = await this.decision.evaluate(
            buildMachineApprovalRequest(req.toolName, safeReason.value),
            req.signal,
          );
          const qualified = trustedForAutoAllow(
            this.decision.provider().capabilities(),
            this.decision.provider().model,
            "approval",
            policyVersion,
          );
          action = decideMachineApproval(
            result,
            approval,
            qualified,
            spec.machine.uncertain,
          ).action;
          this.#audit("approval", {
            ...base,
            action,
            policyVersion,
            judgments: binaryJudgments(result),
          });
        } catch (error) {
          this.ctx.logger.warn(
            `decision: approval evaluation failed for ${req.toolName}: ${String(error)}.`,
          );
          action = "review";
          this.#audit("approval", {
            ...base,
            action: "error",
            policyVersion,
            errorKind: traceErrorKind(error),
          });
        }
        if (action === "allow") return "allowed-once";
        if (action === "deny" || spec.machine.uncertain === "deny") return "rejected";
        return next();
      },
    );
  }
}
