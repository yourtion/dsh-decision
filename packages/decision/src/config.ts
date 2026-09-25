/**
 * Core plugin configuration: raw schemastery validation plus an explicit
 * `resolveConfig()` step that fills every default in one visible place.
 * Provider credentials live in the adapter packages (e.g. dsh-decision-jev).
 * @module dsh-decision/config
 */

import z from "@deepseek-ai/schemastery";

/** Where decisions take effect. `shadow` observes and logs without enforcing. */
export type DecisionMode = "shadow" | "enforce";

/** Guardrail stance when the adapter call itself fails. */
export type GuardrailFailure = "allow" | "ask" | "deny";

export interface GuardrailConfig {
  readonly enabled?: boolean;
  /** Exact tool names to screen; empty screens every tool (including PTC inner calls). */
  readonly tools?: string[];
  /** max(harmful, exposure) below this always allows. */
  readonly allowBelow?: number;
  /** max(harmful, exposure) at or above this denies. Between the thresholds asks. */
  readonly denyAt?: number;
  /** Stance when the adapter call fails. */
  readonly onFailure?: GuardrailFailure;
}

/** One routable model tier; provider/model come from the deployment, never built in. */
export interface RouteConfig {
  readonly key: string;
  /** Shown to the decision model as the option's description. */
  readonly description?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly maxTokens?: number;
}

export interface RoutingConfig {
  readonly enabled?: boolean;
  /** Choice answers with lower confidence keep the default model selection. */
  readonly confidenceFloor?: number;
  readonly routes?: RouteConfig[];
}

export interface JudgeConfig {
  readonly enabled?: boolean;
  /** Exact tool names whose results are judged; empty judges every result. */
  readonly tools?: string[];
  /** max(injection, exposure) at or above this blocks the result. */
  readonly blockAt?: number;
}

export interface ApprovalConfig {
  readonly enabled?: boolean;
  /** P(allow) at or above this answers `allowed-once`. */
  readonly allowAt?: number;
  /** P(allow) below this answers `rejected`. Between the two delegates to humans. */
  readonly rejectBelow?: number;
  /** Require a calibrated adapter for `allowed-once` (never auto-allow uncalibrated). */
  readonly requireCalibrated?: boolean;
}

/** Raw plugin config; every field optional, defaults live in {@link resolveConfig}. */
export interface Config {
  /** Active adapter id; must match an adapter registered on `ctx.decision` (e.g. by dsh-decision-jev). */
  readonly provider?: string;
  readonly mode?: DecisionMode;
  readonly guardrail?: GuardrailConfig;
  readonly routing?: RoutingConfig;
  readonly judge?: JudgeConfig;
  readonly approval?: ApprovalConfig;
}

const probability = z.number().min(0).max(1);

/** Schemastery validation for {@link Config}; structural defaults come from {@link resolveConfig}. */
export const Config: z<Config> = z.object({
  provider: z.string(),
  mode: z.union(["shadow", "enforce"] as const),
  guardrail: z.object({
    enabled: z.boolean(),
    tools: z.array(z.string()),
    allowBelow: probability,
    denyAt: probability,
    onFailure: z.union(["allow", "ask", "deny"] as const),
  }),
  routing: z.object({
    enabled: z.boolean(),
    confidenceFloor: probability,
    routes: z.array(
      z.object({
        key: z.string().required(),
        description: z.string(),
        provider: z.string(),
        model: z.string(),
        reasoningEffort: z.string(),
        maxTokens: z.number(),
      }),
    ),
  }),
  judge: z.object({
    enabled: z.boolean(),
    tools: z.array(z.string()),
    blockAt: probability,
  }),
  approval: z.object({
    enabled: z.boolean(),
    allowAt: probability,
    rejectBelow: probability,
    requireCalibrated: z.boolean(),
  }),
});

/** Fully-defaulted guardrail spec. */
export interface GuardrailSpec {
  readonly enabled: boolean;
  readonly tools: ReadonlySet<string>;
  readonly allowBelow: number;
  readonly denyAt: number;
  readonly onFailure: GuardrailFailure;
}

/** Fully-defaulted routing spec. */
export interface RoutingSpec {
  readonly enabled: boolean;
  readonly confidenceFloor: number;
  readonly routes: readonly RouteConfig[];
}

/** Fully-defaulted judge spec. */
export interface JudgeSpec {
  readonly enabled: boolean;
  readonly tools: ReadonlySet<string>;
  readonly blockAt: number;
}

/** Fully-defaulted approval spec. */
export interface ApprovalSpec {
  readonly enabled: boolean;
  readonly allowAt: number;
  readonly rejectBelow: number;
  readonly requireCalibrated: boolean;
}

/** Resolved configuration: every field concrete, computed once at plugin load. */
export interface ResolvedConfig {
  readonly provider: string;
  readonly mode: DecisionMode;
  readonly guardrail: GuardrailSpec;
  readonly routing: RoutingSpec;
  readonly judge: JudgeSpec;
  readonly approval: ApprovalSpec;
}

/**
 * Explicit defaulting step: fill every seam's spec from the raw config in one
 * visible place. Threshold relationships are validated here, not in handlers.
 * @param config - raw validated config.
 * @returns the fully-defaulted spec the seams switch on.
 * @throws when a seam's thresholds are inverted or routing is enabled without routes.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const guardrailRaw = config.guardrail ?? {};
  const guardrail: GuardrailSpec = {
    enabled: guardrailRaw.enabled ?? true,
    tools: new Set(guardrailRaw.tools ?? []),
    allowBelow: guardrailRaw.allowBelow ?? 0.2,
    denyAt: guardrailRaw.denyAt ?? 0.7,
    onFailure: guardrailRaw.onFailure ?? "allow",
  };

  const routingRaw = config.routing ?? {};
  const routing: RoutingSpec = {
    enabled: routingRaw.enabled ?? false,
    confidenceFloor: routingRaw.confidenceFloor ?? 0.6,
    routes: routingRaw.routes ?? [],
  };

  const judgeRaw = config.judge ?? {};
  const judge: JudgeSpec = {
    enabled: judgeRaw.enabled ?? false,
    tools: new Set(judgeRaw.tools ?? []),
    blockAt: judgeRaw.blockAt ?? 0.75,
  };

  const approvalRaw = config.approval ?? {};
  const approval: ApprovalSpec = {
    enabled: approvalRaw.enabled ?? false,
    allowAt: approvalRaw.allowAt ?? 0.85,
    rejectBelow: approvalRaw.rejectBelow ?? 0.5,
    requireCalibrated: approvalRaw.requireCalibrated ?? true,
  };

  for (const [seam, spec] of [
    ["guardrail", { low: guardrail.allowBelow, high: guardrail.denyAt }],
    ["approval", { low: approval.rejectBelow, high: approval.allowAt }],
  ] as const) {
    if (spec.low >= spec.high) {
      throw new Error(
        `dsh-decision: ${seam} thresholds are inverted (lower bound ${spec.low} >= upper bound ${spec.high}).`,
      );
    }
  }
  if (routing.enabled && routing.routes.length === 0) {
    throw new Error("dsh-decision: routing is enabled but routing.routes is empty.");
  }

  return {
    provider: config.provider ?? "jev",
    mode: config.mode ?? "shadow",
    guardrail,
    routing,
    judge,
    approval,
  };
}
