/**
 * Core plugin configuration: raw schemastery validation plus an explicit
 * `resolveConfig()` step that fills every default in one visible place.
 * Provider credentials live in the adapter packages (e.g. dsh-decision-jev).
 * @module dsh-decision/config
 */

import z from "@deepseek-ai/schemastery";
import type { GuardrailRisk, RiskThresholds } from "./policy/risk.js";
import { DEFAULT_GUARDRAIL_RISKS, GUARDRAIL_RISKS } from "./policy/risk.js";
import type { OutboundPrivacy } from "./privacy/sanitizer.js";
import { defaultAuditPath } from "./trace/trace.js";

/** Where decisions take effect. `shadow` observes and logs without enforcing. */
export type DecisionMode = "shadow" | "enforce";
export type EnforcementMode = DecisionMode;
/** `native` delegates approval to DSH; `machine` may answer an existing DSH ask. */
export type PermissionMode = "native" | "machine";
export type UncertainPolicy = "human" | "deny";

export interface MachineConfig {
  readonly uncertain?: UncertainPolicy;
}

/** Guardrail stance when the adapter call itself fails. */
export type GuardrailFailure = "allow" | "ask" | "deny";

export interface GuardrailConfig {
  readonly enabled?: boolean;
  /** Exact tool names to screen; empty screens every tool (including PTC inner calls). */
  readonly tools?: string[];
  /** @deprecated Translated to every risk's reviewAt when risks is omitted. */
  readonly allowBelow?: number;
  /** @deprecated Translated to every risk's denyAt when risks is omitted. */
  readonly denyAt?: number;
  /** Experimental per-risk thresholds; not calibrated probabilities. */
  readonly risks?: Partial<Record<GuardrailRisk, Partial<RiskThresholds>>>;
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
  /** @deprecated v2 always requires a matching scoped calibration profile. */
  readonly requireCalibrated?: boolean;
}

/** Outbound data policy for judgment requests leaving the host. */
export interface PrivacyConfig {
  /** `redact` masks detected secrets in tool arguments, results, and hints. */
  readonly outbound?: OutboundPrivacy;
}

/** Audit-trace settings for the sanitized decision record. */
export interface AuditConfig {
  /** Write one JSONL record per judgment outcome; default on. */
  readonly enabled?: boolean;
  /** Audit file path; defaults under the XDG state directory. */
  readonly path?: string;
}

/** Raw plugin config; every field optional, defaults live in {@link resolveConfig}. */
export interface Config {
  /** Active adapter id; must match an adapter registered on `ctx.decision` (e.g. by dsh-decision-jev). */
  readonly provider?: string;
  /** Maximum duration of one JudgmentProvider evaluation. */
  readonly timeoutMs?: number;
  readonly permission?: PermissionMode;
  readonly enforcement?: EnforcementMode;
  readonly machine?: MachineConfig;
  /** @deprecated Use `enforcement`. */
  readonly mode?: DecisionMode;
  readonly privacy?: PrivacyConfig;
  readonly audit?: AuditConfig;
  readonly guardrail?: GuardrailConfig;
  readonly routing?: RoutingConfig;
  readonly judge?: JudgeConfig;
  readonly approval?: ApprovalConfig;
}

const probability = z.number().min(0).max(1);

/** Schemastery validation for {@link Config}; structural defaults come from {@link resolveConfig}. */
export const Config: z<Config> = z.object({
  provider: z.string(),
  timeoutMs: z.number().min(1),
  permission: z.union(["native", "machine"] as const),
  enforcement: z.union(["shadow", "enforce"] as const),
  machine: z.object({ uncertain: z.union(["human", "deny"] as const) }),
  mode: z.union(["shadow", "enforce"] as const),
  privacy: z.object({ outbound: z.union(["redact", "raw"] as const) }),
  audit: z.object({ enabled: z.boolean(), path: z.string() }),
  guardrail: z.object({
    enabled: z.boolean(),
    tools: z.array(z.string()),
    allowBelow: probability,
    denyAt: probability,
    risks: z.object({
      destructive: z.object({ reviewAt: probability, denyAt: probability }),
      secretExposure: z.object({ reviewAt: probability, denyAt: probability }),
      privacyExposure: z.object({ reviewAt: probability, denyAt: probability }),
      externalSideEffect: z.object({ reviewAt: probability, denyAt: probability }),
      privilegeEscalation: z.object({ reviewAt: probability, denyAt: probability }),
      scopeViolation: z.object({ reviewAt: probability, denyAt: probability }),
    }),
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
  /** @deprecated v2 policy reads {@link risks}; kept for v1 adapter callers. */
  readonly allowBelow?: number;
  /** @deprecated v2 policy reads {@link risks}; kept for v1 adapter callers. */
  readonly denyAt?: number;
  readonly risks: Readonly<Record<GuardrailRisk, RiskThresholds>>;
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
  readonly timeoutMs: number;
  readonly permission: PermissionMode;
  readonly enforcement: EnforcementMode;
  readonly machine: { readonly uncertain: UncertainPolicy };
  /** @deprecated Alias for `enforcement` during migration. */
  readonly mode: DecisionMode;
  readonly privacy: { readonly outbound: OutboundPrivacy };
  readonly audit: { readonly enabled: boolean; readonly path: string };
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
  const timeoutMs = config.timeoutMs ?? 8_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("dsh-decision: timeoutMs must be a positive integer.");
  }
  if (
    config.mode !== undefined &&
    config.enforcement !== undefined &&
    config.mode !== config.enforcement
  ) {
    throw new Error("dsh-decision: mode and enforcement disagree.");
  }
  const enforcement = config.enforcement ?? config.mode ?? "shadow";
  const permission = config.permission ?? (config.approval?.enabled ? "machine" : "native");
  const guardrailRaw = config.guardrail ?? {};
  const legacyThresholds =
    guardrailRaw.allowBelow !== undefined || guardrailRaw.denyAt !== undefined;
  if (legacyThresholds && guardrailRaw.risks !== undefined) {
    throw new Error("dsh-decision: legacy guardrail thresholds cannot be combined with risks.");
  }
  const risks = Object.fromEntries(
    GUARDRAIL_RISKS.map((risk) => [
      risk,
      {
        reviewAt:
          guardrailRaw.risks?.[risk]?.reviewAt ??
          (legacyThresholds
            ? (guardrailRaw.allowBelow ?? 0.2)
            : DEFAULT_GUARDRAIL_RISKS[risk].reviewAt),
        denyAt:
          guardrailRaw.risks?.[risk]?.denyAt ??
          (legacyThresholds ? (guardrailRaw.denyAt ?? 0.7) : DEFAULT_GUARDRAIL_RISKS[risk].denyAt),
      },
    ]),
  ) as Record<GuardrailRisk, RiskThresholds>;
  for (const risk of GUARDRAIL_RISKS) {
    const thresholds = risks[risk];
    if (
      !Number.isFinite(thresholds.reviewAt) ||
      !Number.isFinite(thresholds.denyAt) ||
      thresholds.reviewAt < 0 ||
      thresholds.denyAt > 1 ||
      thresholds.reviewAt >= thresholds.denyAt
    ) {
      throw new Error(`dsh-decision: invalid guardrail thresholds for ${risk}.`);
    }
  }
  const guardrail: GuardrailSpec = {
    enabled: guardrailRaw.enabled ?? true,
    tools: new Set(guardrailRaw.tools ?? []),
    allowBelow: guardrailRaw.allowBelow ?? 0.2,
    denyAt: guardrailRaw.denyAt ?? 0.7,
    risks,
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
    enabled: approvalRaw.enabled ?? permission === "machine",
    allowAt: approvalRaw.allowAt ?? 0.85,
    rejectBelow: approvalRaw.rejectBelow ?? 0.5,
    requireCalibrated: approvalRaw.requireCalibrated ?? true,
  };
  if (permission === "machine" && !approval.enabled) {
    throw new Error("dsh-decision: machine permission requires approval.enabled.");
  }

  // Guardrail inversion is enforced per risk above; approval is the only
  // seam whose pair still needs a cross-field check.
  if (approval.rejectBelow >= approval.allowAt) {
    throw new Error(
      `dsh-decision: approval thresholds are inverted (lower bound ${approval.rejectBelow} >= upper bound ${approval.allowAt}).`,
    );
  }
  if (routing.enabled && routing.routes.length === 0) {
    throw new Error("dsh-decision: routing is enabled but routing.routes is empty.");
  }

  return {
    provider: config.provider ?? "jev",
    timeoutMs,
    permission,
    enforcement,
    machine: { uncertain: config.machine?.uncertain ?? "human" },
    mode: enforcement,
    privacy: { outbound: config.privacy?.outbound ?? "redact" },
    audit: {
      enabled: config.audit?.enabled ?? true,
      path: config.audit?.path ?? defaultAuditPath("dsh"),
    },
    guardrail,
    routing,
    judge,
    approval,
  };
}
