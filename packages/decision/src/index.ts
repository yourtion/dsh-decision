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
import { buildApprovalRequest, decideApproval, DELEGATE } from "./seams/approval.js";
import { StepContextStore, taskHint } from "./context/step-context.js";
import { isDecisionEscalation, markDecisionEscalation } from "./context/provenance.js";
import type { DecisionAdapter } from "./types.js";

export { Config, resolveConfig } from "./config.js";
export type {
  Config as DecisionConfig,
  DecisionMode,
  GuardrailFailure,
  ResolvedConfig,
  RouteConfig,
} from "./config.js";
export { DecisionRuntime } from "./service.js";
export { DecisionError, ProviderValidationError } from "./types.js";
export { validateAnswer } from "./validation.js";
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
}

/**
 * The decision-layer service. Loading resolves configuration (fail loud),
 * registers the built-in Jev adapter, and installs the enabled seams. In
 * `shadow` mode every seam calls its decision model and logs the verdict
 * while delegating `next()` unchanged.
 */
export default class DecisionLayer extends Service {
  static Config: z<Config> = Config;

  readonly decision: DecisionRuntime;
  readonly #spec: ResolvedConfig;
  readonly #stepContexts = new StepContextStore();

  constructor(ctx: Context, config: Config) {
    super(ctx, "decision");
    const spec = (this.#spec = resolveConfig(config));
    this.decision = new DecisionRuntime(spec);
    if (spec.guardrail.enabled) this.#installGuardrail();
    if (spec.routing.enabled) this.#installRouting();
    if (spec.judge.enabled) this.#installJudge();
    if (spec.approval.enabled) this.#installApproval();
  }

  /** Provider plugins register through the Cordis service visible as `ctx.decision`. */
  registerAdapter(adapter: DecisionAdapter): () => void {
    return this.decision.registerAdapter(adapter);
  }

  /** Enforce or observe: map a guardrail verdict onto a pre-execute decision. */
  #applyGuardrail(
    action: "allow" | "deny" | "ask",
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
        if (spec.mode === "shadow") {
          void Promise.resolve()
            .then(async () => {
              const answers = await this.decision
                .active()
                .evaluate(buildGuardrailRequest(exec.name, exec.arguments, exec.signal));
              const verdict = decideGuardrail(answers, guardrail);
              if (verdict.action !== "allow") {
                this.ctx.logger.info(
                  `decision shadow: ${exec.name} would ${verdict.action} (risk ${verdict.pMax.toFixed(2)}).`,
                );
              }
            })
            .catch((error: unknown) =>
              this.ctx.logger.warn(
                `decision shadow: guardrail evaluation failed: ${String(error)}.`,
              ),
            );
          return next();
        }
        try {
          const answers = await this.decision
            .active()
            .evaluate(buildGuardrailRequest(exec.name, exec.arguments, exec.signal));
          const verdict = decideGuardrail(answers, guardrail);
          return this.#applyGuardrail(verdict.action, verdict.reason, spec.mode, next);
        } catch (error) {
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
      if (spec.mode === "shadow") {
        void Promise.resolve()
          .then(async () => {
            const answers = await this.decision
              .active()
              .evaluate(buildRoutingRequest(hint, routing.routes, signal));
            const routed = decideRouting(answers, routing, fallback);
            if (routed !== fallback) {
              this.ctx.logger.info(
                `decision shadow: would route to ${routed.provider}/${routed.model}.`,
              );
            }
          })
          .catch((error: unknown) =>
            this.ctx.logger.warn(`decision shadow: routing evaluation failed: ${String(error)}.`),
          );
        return fallback;
      }
      try {
        const answers = await this.decision
          .active()
          .evaluate(buildRoutingRequest(hint, routing.routes, signal));
        const routed = decideRouting(answers, routing, fallback);
        return routed;
      } catch (error) {
        this.ctx.logger.warn(
          `decision: routing evaluation failed, keeping default: ${String(error)}.`,
        );
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
        if (spec.mode === "shadow") {
          void Promise.resolve()
            .then(async () => {
              const answers = await this.decision
                .active()
                .evaluate(buildJudgeRequest(exec.name, result, exec.signal));
              const verdict = decideJudge(answers, judge);
              if (verdict.action === "block") {
                this.ctx.logger.info(
                  `decision shadow: ${exec.name} result would be blocked (${verdict.pMax.toFixed(2)}).`,
                );
              }
            })
            .catch((error: unknown) =>
              this.ctx.logger.warn(`decision shadow: judge evaluation failed: ${String(error)}.`),
            );
          return next();
        }
        try {
          const answers = await this.decision
            .active()
            .evaluate(buildJudgeRequest(exec.name, result, exec.signal));
          const verdict = decideJudge(answers, judge);
          if (verdict.action === "accept") return next();
          return { kind: "block", feedback: judgeFeedback(verdict.reason) };
        } catch (error) {
          this.ctx.logger.warn(
            `decision: judge evaluation failed for ${exec.name}, accepting: ${String(error)}.`,
          );
          return next();
        }
      },
    );
  }

  #installApproval(): void {
    const spec = this.#spec;
    const approval = spec.approval;
    this.ctx.on(
      "approval/request",
      async (req: ApprovalRequestEvent, next): Promise<ApprovalOutcome> => {
        if (isDecisionEscalation(req.reason)) return next();
        if (spec.mode === "shadow") {
          void Promise.resolve()
            .then(async () => {
              const adapter = this.decision.active();
              const answers = await adapter.evaluate(
                buildApprovalRequest(req.toolName, req.reason, req.signal),
              );
              const machine = decideApproval(answers, approval, adapter.calibrated);
              if (machine !== DELEGATE) {
                this.ctx.logger.info(`decision shadow: ${req.toolName} would be ${machine}.`);
              }
            })
            .catch((error: unknown) =>
              this.ctx.logger.warn(
                `decision shadow: approval evaluation failed: ${String(error)}.`,
              ),
            );
          return next();
        }
        try {
          const adapter = this.decision.active();
          const answers = await adapter.evaluate(
            buildApprovalRequest(req.toolName, req.reason, req.signal),
          );
          const machine = decideApproval(answers, approval, adapter.calibrated);
          if (machine === DELEGATE) return next();
          return machine;
        } catch (error) {
          // An evaluation failure never auto-answers: delegate to the remaining
          // answerers (humans, UI) instead of guessing open.
          this.ctx.logger.warn(
            `decision: approval evaluation failed for ${req.toolName}, delegating: ${String(error)}.`,
          );
          return next();
        }
      },
    );
  }
}
