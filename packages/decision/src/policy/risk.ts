import { createHash } from "node:crypto";

/** Stable order makes ties and explanation text deterministic. */
export const GUARDRAIL_RISKS = [
  "destructive",
  "secretExposure",
  "privacyExposure",
  "externalSideEffect",
  "privilegeEscalation",
  "scopeViolation",
] as const;

export type GuardrailRisk = (typeof GUARDRAIL_RISKS)[number];
export type RiskAction = "allow" | "review" | "deny";

export interface RiskThresholds {
  readonly reviewAt: number;
  readonly denyAt: number;
  /** Action at or above denyAt. Some factual risks require review, not refusal. */
  readonly highAction?: "review" | "deny";
}

/**
 * One judgeable risk dimension: a question, its wording, and its thresholds.
 * The built-in six are defaults; users may disable or reword them and append
 * custom dimensions — wording and thresholds are calibrated as a pair, so the
 * policy version hashes both.
 */
export interface RiskDefinition {
  readonly key: string;
  readonly instructions: string;
  readonly reviewAt: number;
  readonly denyAt: number;
  readonly criteria?: { readonly true: string; readonly false: string };
  readonly highAction?: "review" | "deny";
}

/**
 * Experimental starting thresholds. The previous 22-case live evaluation
 * used different questions and state; its calibration does not transfer to
 * these definitions. Re-evaluate before treating scores as calibrated.
 */
export const DEFAULT_GUARDRAIL_RISKS: Readonly<Record<GuardrailRisk, RiskThresholds>> = {
  destructive: { reviewAt: 0.45, denyAt: 0.55 },
  secretExposure: { reviewAt: 0.55, denyAt: 0.85 },
  privacyExposure: { reviewAt: 0.65, denyAt: 0.88 },
  externalSideEffect: { reviewAt: 0.45, denyAt: 0.7, highAction: "review" },
  privilegeEscalation: { reviewAt: 0.25, denyAt: 0.85 },
  scopeViolation: { reviewAt: 0.48, denyAt: 0.72 },
};

/** Default question wording for the built-in dimensions. */
export const BUILTIN_RISK_INSTRUCTIONS: Readonly<Record<GuardrailRisk, string>> = {
  destructive:
    "Will this action cause irreversible or not readily recoverable loss of existing data or systems?",
  secretExposure:
    "Will this action disclose a credential or secret to an unintended recipient or output?",
  privacyExposure:
    "Will this action disclose private personal data outside its authorized audience?",
  externalSideEffect:
    "Will this action send a message or upload, publish data, or mutate shared or remote state?",
  privilegeEscalation: "Will this action broaden privileges or bypass an access control?",
  scopeViolation:
    "Does this action exceed the user's requested task and its necessary supporting steps?",
};

/** Concrete positive and negative boundaries for each single-condition question. */
export const BUILTIN_RISK_CRITERIA: Readonly<
  Record<GuardrailRisk, { readonly true: string; readonly false: string }>
> = {
  destructive: {
    true: "Irreversibly destroys existing data or systems, or makes them not readily recoverable.",
    false:
      "Reads data, makes an ordinary reversible workspace edit, deletes recoverable items, or removes disposable generated files.",
  },
  secretExposure: {
    true: "Places a password, token, key, or other secret in tool output, logs, a message, a publication, or an unintended service request.",
    false:
      "Performs no secret disclosure, including when the action involves no secret, or uses a credential only to authenticate to its intended service without revealing its value.",
  },
  privacyExposure: {
    true: "Sends or publishes identifiable private personal data to a recipient outside the authorized audience.",
    false:
      "Processes private data locally or sends it only to an audience explicitly authorized for this action.",
  },
  externalSideEffect: {
    true: "Sends a message or uploads/publishes data, mutates remote or shared state, or changes system configuration or scheduled jobs.",
    false:
      "Makes an ordinary read-only request (including GET), reads public information, or changes local workspace files without publishing or mutating shared systems.",
  },
  privilegeEscalation: {
    true: "Broadens permissions, disables a control, obtains additional authority, or bypasses an access boundary.",
    false:
      "Narrows permissions, uses already granted authority, or performs an action without changing or bypassing access controls.",
  },
  scopeViolation: {
    true: "Performs an independent new action outside the user request or contradicts an explicit user limit.",
    false:
      "Performs the requested action or a necessary supporting step within the user's stated limits.",
  },
};

/** The default effective set: six built-ins, in stable order. */
export function defaultRiskDefinitions(): RiskDefinition[] {
  return GUARDRAIL_RISKS.map((risk) => ({
    key: risk,
    instructions: BUILTIN_RISK_INSTRUCTIONS[risk],
    criteria: BUILTIN_RISK_CRITERIA[risk],
    ...DEFAULT_GUARDRAIL_RISKS[risk],
  }));
}

/** Per-dimension guardrail config accepted for built-ins and customs alike. */
export interface RiskEntryInput {
  /** `false` drops the dimension: not asked, not judged, not sent. */
  readonly enabled?: boolean;
  /** Overrides the question wording; requires recalibrating thresholds. */
  readonly instructions?: string;
  /** Explicit descriptions of the true and false cases. */
  readonly criteria?: { readonly true: string; readonly false: string };
  readonly reviewAt?: number;
  readonly denyAt?: number;
  readonly highAction?: "review" | "deny";
}

/** Host-neutral input to {@link resolveGuardrailRisks}. */
export interface GuardrailRisksInput {
  /** @deprecated Translated to every risk's reviewAt when `risks` is omitted. */
  readonly allowBelow?: number;
  /** @deprecated Translated to every risk's denyAt when `risks` is omitted. */
  readonly denyAt?: number;
  /** Overrides for the built-in dimensions. */
  readonly risks?: Readonly<Partial<Record<GuardrailRisk, RiskEntryInput>>>;
  /**
   * User-defined dimensions appended after the built-ins. Instructions and
   * both thresholds are required — an uncalibrated dimension has no defaults.
   */
  readonly customRisks?: Readonly<Record<string, RiskEntryInput>>;
}

function assertThresholds(key: string, reviewAt: number, denyAt: number): void {
  if (
    !Number.isFinite(reviewAt) ||
    !Number.isFinite(denyAt) ||
    reviewAt < 0 ||
    denyAt > 1 ||
    reviewAt >= denyAt
  ) {
    throw new Error(`dsh-decision: invalid guardrail thresholds for ${key}.`);
  }
}

function normalizeCriteria(key: string, criteria: unknown): RiskDefinition["criteria"] {
  if (criteria === undefined) return undefined;
  if (criteria === null || typeof criteria !== "object" || Array.isArray(criteria)) {
    throw new Error(`dsh-decision: guardrail criteria for ${key} must be an object.`);
  }
  const record = criteria as Record<string, unknown>;
  if (Object.keys(record).some((property) => property !== "true" && property !== "false")) {
    throw new Error(`dsh-decision: guardrail criteria for ${key} has unknown properties.`);
  }
  if (record.true === undefined && record.false === undefined) return undefined;
  for (const property of ["true", "false"] as const) {
    if (typeof record[property] !== "string" || record[property].trim() === "") {
      throw new Error(
        `dsh-decision: guardrail criteria for ${key} requires non-empty true and false descriptions.`,
      );
    }
  }
  return { true: record.true as string, false: record.false as string };
}

function assertHighAction(key: string, action: RiskDefinition["highAction"]): void {
  if (action !== undefined && action !== "review" && action !== "deny") {
    throw new Error(`dsh-decision: invalid highAction for ${key}.`);
  }
}

export interface ResolvedGuardrailRisks {
  /** Effective, ordered dimension set: built-ins (minus disabled) then customs. */
  readonly risks: readonly RiskDefinition[];
  readonly policyVersion: string;
}

/**
 * Resolve the effective dimension set from raw input. Pure and host-neutral
 * (no Cordis or Schemastery) so dsh config and pi env share one validator.
 * @throws on inverted or missing thresholds, reserved custom keys, legacy
 *   thresholds combined with per-risk config, or empty effective sets.
 */
export function resolveGuardrailRisks(input: GuardrailRisksInput): ResolvedGuardrailRisks {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("dsh-decision: guardrail risks config must be an object.");
  }
  if (
    input.risks !== undefined &&
    (input.risks === null || typeof input.risks !== "object" || Array.isArray(input.risks))
  ) {
    throw new Error("dsh-decision: guardrail risks must be an object.");
  }
  if (
    input.customRisks !== undefined &&
    (input.customRisks === null ||
      typeof input.customRisks !== "object" ||
      Array.isArray(input.customRisks))
  ) {
    throw new Error("dsh-decision: custom guardrail risks must be an object.");
  }
  const legacyThresholds = input.allowBelow !== undefined || input.denyAt !== undefined;
  if (legacyThresholds && (input.risks !== undefined || input.customRisks !== undefined)) {
    throw new Error("dsh-decision: legacy guardrail thresholds cannot be combined with risks.");
  }
  const risks: RiskDefinition[] = [];
  for (const risk of GUARDRAIL_RISKS) {
    const entry = input.risks?.[risk] ?? {};
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`dsh-decision: guardrail risk config for ${risk} must be an object.`);
    }
    if (entry.enabled === false) continue;
    const defaults = DEFAULT_GUARDRAIL_RISKS[risk];
    const reviewAt =
      entry.reviewAt ?? (legacyThresholds ? (input.allowBelow ?? 0.2) : defaults.reviewAt);
    const denyAt = entry.denyAt ?? (legacyThresholds ? (input.denyAt ?? 0.7) : defaults.denyAt);
    assertThresholds(risk, reviewAt, denyAt);
    const instructions = entry.instructions ?? BUILTIN_RISK_INSTRUCTIONS[risk];
    if (instructions.trim() === "") {
      throw new Error(`dsh-decision: guardrail instructions for ${risk} must not be empty.`);
    }
    const explicitCriteria = normalizeCriteria(risk, entry.criteria);
    const criteria =
      explicitCriteria ??
      (entry.instructions === undefined ? BUILTIN_RISK_CRITERIA[risk] : undefined);
    const highAction = entry.highAction ?? defaults.highAction ?? "deny";
    assertHighAction(risk, highAction);
    risks.push({ key: risk, instructions, criteria, reviewAt, denyAt, highAction });
  }
  for (const [key, entry] of Object.entries(input.customRisks ?? {})) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`dsh-decision: custom risk config for ${key} must be an object.`);
    }
    if (key.trim() === "") throw new Error("dsh-decision: custom risk keys must not be empty.");
    if ((GUARDRAIL_RISKS as readonly string[]).includes(key)) {
      throw new Error(
        `dsh-decision: custom risk key "${key}" collides with a built-in dimension; configure it under guardrail.risks instead.`,
      );
    }
    if (typeof entry.instructions !== "string" || entry.instructions.trim() === "") {
      throw new Error(`dsh-decision: custom risk "${key}" requires non-empty instructions.`);
    }
    if (entry.reviewAt === undefined || entry.denyAt === undefined) {
      throw new Error(
        `dsh-decision: custom risk "${key}" requires explicit reviewAt and denyAt — calibrate them (pnpm run eval, docs/eval.md).`,
      );
    }
    if (entry.enabled === false) continue;
    assertThresholds(key, entry.reviewAt, entry.denyAt);
    const criteria = normalizeCriteria(key, entry.criteria);
    assertHighAction(key, entry.highAction);
    risks.push({
      key,
      instructions: entry.instructions,
      ...(criteria === undefined ? {} : { criteria }),
      reviewAt: entry.reviewAt,
      denyAt: entry.denyAt,
      highAction: entry.highAction ?? "deny",
    });
  }
  if (risks.length === 0) {
    throw new Error("dsh-decision: guardrail has no enabled risk dimensions.");
  }
  return { risks, policyVersion: guardrailPolicyVersion(risks) };
}

export interface PolicyDecision {
  readonly action: RiskAction;
  readonly reason: string;
  readonly policyVersion: string;
  readonly driver?: string;
  readonly probability?: number;
}

export interface PolicyEngine<Context, Judgments, Decision extends { readonly action: string }> {
  evaluate(context: Context, judgments: Judgments): Decision;
}

export const GUARDRAIL_POLICY_VERSION = "guardrail-v3.0.0-experimental";

/**
 * Version the whole effective dimension set: keys, thresholds, and question
 * wording. Rewording a question changes judgments (proven by the
 * 2026-09-26 externalSideEffect case), so wording is part of policy identity.
 */
export function guardrailPolicyVersion(risks: readonly RiskDefinition[]): string {
  const canonical = risks.map((risk) => [
    risk.key,
    risk.reviewAt,
    risk.denyAt,
    risk.highAction ?? "deny",
    createHash("sha256").update(risk.instructions).digest("hex"),
    createHash("sha256")
      .update(JSON.stringify(risk.criteria ?? null))
      .digest("hex"),
  ]);
  const digest = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return `${GUARDRAIL_POLICY_VERSION}:${digest}`;
}

export function evaluateRisk(probability: number, thresholds: RiskThresholds): RiskAction {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error("dsh-decision: risk probability must be finite and in [0, 1].");
  }
  if (probability >= thresholds.denyAt) return thresholds.highAction ?? "deny";
  if (probability >= thresholds.reviewAt) return "review";
  return "allow";
}

/** Deny > review > allow; declaration order resolves equal-priority ties. */
export function evaluateGuardrailPolicy(
  judgments: Readonly<Record<string, number>>,
  risks: readonly RiskDefinition[],
  options: {
    readonly unknownRisks?: readonly string[];
    readonly authorizedExternalSideEffect?: boolean;
  } = {},
): PolicyDecision {
  let action: RiskAction = "allow";
  let driver: string | undefined;
  let probability: number | undefined;
  const unknownRisks = new Set(options.unknownRisks ?? []);
  for (const key of unknownRisks) {
    if (key !== "scopeViolation" && key !== "externalSideEffect") {
      throw new Error(`dsh-decision: ${key} cannot be marked unknown by context.`);
    }
  }
  for (const risk of risks) {
    const value = judgments[risk.key];
    if (value === undefined) {
      if (unknownRisks.has(risk.key)) continue;
      throw new Error(`dsh-decision: guardrail judgment missing for "${risk.key}".`);
    }
    const candidate =
      risk.key === "externalSideEffect" && options.authorizedExternalSideEffect
        ? "allow"
        : evaluateRisk(value, risk);
    if (
      (candidate === "deny" && action !== "deny") ||
      (candidate === "review" && action === "allow")
    ) {
      action = candidate;
      driver = risk.key;
      probability = value;
    }
  }
  if (action === "allow" && unknownRisks.size > 0) {
    const firstUnknown = risks.find((risk) => unknownRisks.has(risk.key));
    if (firstUnknown !== undefined) {
      action = "review";
      driver = firstUnknown.key;
    }
  }
  return {
    action,
    reason:
      driver === undefined
        ? "decision-layer: no configured risk crossed its review threshold."
        : probability === undefined
          ? `decision-layer: ${driver} could not be judged without required context.`
          : `decision-layer: ${driver} risk ${probability.toFixed(2)} crossed ${action} threshold.`,
    policyVersion: guardrailPolicyVersion(risks),
    ...(driver === undefined ? {} : { driver }),
    ...(probability === undefined ? {} : { probability }),
  };
}
