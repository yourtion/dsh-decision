import { createHash } from "node:crypto";
import {
  guardrailActionHash,
  prepareGuardrailRequest,
  guardrailPolicyVersion,
  OUTBOUND_PRIVACY_VERSION,
} from "@techs/dsh-decision/kernel";

export const RESULT_FORMAT = 2;
export const STATE_SCHEMA = "guardrail-context-v2";
export const PRIVACY_MODE = "redact";
export const RISK_LABELS = [
  "destructive",
  "secretExposure",
  "privacyExposure",
  "externalSideEffect",
  "privilegeEscalation",
  "scopeViolation",
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

export function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function normalizeFixture(fixture, risks) {
  if (!fixture || typeof fixture.id !== "string" || typeof fixture.tool !== "string") {
    throw new Error("fixture requires string id and tool");
  }
  if (!["allow", "review", "deny"].includes(fixture.expected)) {
    throw new Error(`fixture ${fixture.id}: expected must be allow, review or deny`);
  }
  const split = fixture.split ?? "calibration";
  if (!["calibration", "holdout"].includes(split)) {
    throw new Error(`fixture ${fixture.id}: split must be calibration or holdout`);
  }
  const labels = fixture.riskLabels;
  if (labels !== undefined) {
    for (const risk of risks) {
      if (typeof labels[risk.key] !== "boolean" && labels[risk.key] !== null) {
        throw new Error(
          `fixture ${fixture.id}: riskLabels.${risk.key} must be boolean or null (unknown)`,
        );
      }
    }
  }
  const context = { ...(fixture.context ?? {}) };
  if (context.authorization === "granted") {
    context.authorization = {
      toolName: fixture.tool,
      argumentsHash: guardrailActionHash(fixture.tool, fixture.arguments, {
        userRequest: context.userRequest,
        workspaceRoot: context.workspaceRoot,
        environment: context.environment,
      }),
      workspaceRoot: context.workspaceRoot,
      environment: context.environment,
      granted: true,
    };
  } else if (context.authorization !== undefined && context.authorization !== null) {
    throw new Error(`fixture ${fixture.id}: context.authorization must be "granted"`);
  }
  return { ...fixture, split, context };
}

export function prepareEvalRequest(fixture, risks) {
  const normalized = normalizeFixture(fixture, risks);
  return prepareGuardrailRequest(
    normalized.tool,
    normalized.arguments,
    risks,
    normalized.context,
    PRIVACY_MODE,
  );
}

export function evaluationMetadata(risks, fixtures, requestedModel, provider = "jev") {
  return {
    formatVersion: RESULT_FORMAT,
    stateSchema: STATE_SCHEMA,
    privacyMode: PRIVACY_MODE,
    promptFingerprint: fingerprint(
      risks.map(({ key, instructions, criteria }) => ({
        key,
        instructions,
        criteria,
      })),
    ),
    policyFingerprint: guardrailPolicyVersion(risks),
    privacyFingerprint: fingerprint({ mode: PRIVACY_MODE, version: OUTBOUND_PRIVACY_VERSION }),
    fixtureFingerprint: fingerprint(
      fixtures.map((fixture) => ({
        ...fixture,
        context:
          fixture.context?.authorization === "granted"
            ? { ...fixture.context, authorization: "granted" }
            : fixture.context,
      })),
    ),
    riskKeys: risks.map((risk) => risk.key),
    requestedModel,
    provider,
  };
}

export function compatibilityIssues(stored, current) {
  const meta = stored?.evaluation;
  if (stored?.formatVersion !== RESULT_FORMAT || !meta) {
    return ["legacy result lacks prompt, policy, privacy and state fingerprints"];
  }
  const fields = [
    "stateSchema",
    "privacyMode",
    "promptFingerprint",
    "policyFingerprint",
    "privacyFingerprint",
    "riskKeys",
  ];
  return fields.flatMap((field) =>
    JSON.stringify(meta[field]) === JSON.stringify(current[field])
      ? []
      : [`${field} differs from current evaluation semantics`],
  );
}

export function assertCompatible(stored, current, allowIncompatible = false) {
  const issues = compatibilityIssues(stored, current);
  if (issues.length && !allowIncompatible) {
    throw new Error(
      `incompatible evaluation result: ${issues.join("; ")}. ` +
        "Use --allow-incompatible only for exploratory re-scoring; these probabilities do not validate current defaults.",
    );
  }
  return issues;
}

export function validateRows(rows, riskKeys) {
  if (!Array.isArray(rows)) throw new Error("results file has no rows array");
  for (const row of rows) {
    if (!["allow", "review", "deny"].includes(row.expected)) {
      throw new Error(`row ${row.id}: invalid expected action`);
    }
    for (const key of riskKeys) {
      const score = row.probabilities?.[key];
      if (row.unknownRisks?.includes(key) && score === undefined) continue;
      if (typeof score !== "number" || score < 0 || score > 1 || !Number.isFinite(score)) {
        throw new Error(`row ${row.id}: missing or invalid ${key} probability`);
      }
    }
  }
}
