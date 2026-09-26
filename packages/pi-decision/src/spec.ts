import {
  defaultAuditPath,
  resolveGuardrailRisks,
  type DecisionMode,
  type GuardrailFailure,
  type GuardrailRisksInput,
  type GuardrailSpec,
  type ResolvedGuardrailRisks,
  type OutboundPrivacy,
} from "@techs/dsh-decision/kernel";
import { resolveJevConfig, type JevSpec } from "@techs/dsh-decision-jev/spec";

export interface PiGuardrailSpec {
  readonly mode: DecisionMode;
  readonly guardrail: GuardrailSpec;
  readonly outbound: OutboundPrivacy;
  /** Audit-trace switch and file path. */
  readonly audit: { readonly enabled: boolean; readonly path: string };
}

/** Select the wire-compatible Vercel gateway unless direct Jev is requested. */
export function resolvePiJevSpec(env: NodeJS.ProcessEnv): JevSpec {
  const backend = choice(
    env.PI_DECISION_JEV_BACKEND,
    ["vercel", "direct"],
    "PI_DECISION_JEV_BACKEND",
    "vercel",
  );
  if (backend === "direct") {
    if (!env.JEV_API_KEY) {
      throw new Error("pi-decision: set JEV_API_KEY to a direct Jev key.");
    }
    return resolveJevConfig({ apiKey: env.JEV_API_KEY });
  }
  const apiKey = env.AI_GATEWAY_API_KEY || env.JEV_API_KEY;
  if (!apiKey) {
    throw new Error(
      "pi-decision: set AI_GATEWAY_API_KEY or JEV_API_KEY to a Vercel AI Gateway key.",
    );
  }
  return resolveJevConfig({
    apiKey,
    baseUrl: "https://ai-gateway.vercel.sh/typesafe",
    model: "typesafe-ai/jev",
  });
}

function choice<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  name: string,
  fallback: T,
): T {
  if (value === undefined || value === "") return fallback;
  if (allowed.includes(value as T)) return value as T;
  throw new Error(`pi-decision: ${name} must be one of ${allowed.join(", ")}.`);
}

function flag(value: string | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "on" || value === "1") return true;
  if (value === "off" || value === "0") return false;
  throw new Error(`pi-decision: ${name} must be on or off.`);
}

/**
 * Parse `PI_DECISION_RISKS` as the same JSON shape as the dsh guardrail risk
 * config — `{"risks": {...}, "customRisks": {...}}` — to disable or reword
 * built-in dimensions and append custom ones. Omitted env uses the shared
 * defaults; invalid JSON or risk config fails loud at load.
 */
export function resolvePiRisks(env: NodeJS.ProcessEnv): ResolvedGuardrailRisks {
  const raw = env.PI_DECISION_RISKS;
  let input: GuardrailRisksInput;
  if (raw === undefined || raw === "") {
    input = {};
  } else {
    try {
      input = JSON.parse(raw) as GuardrailRisksInput;
    } catch (error) {
      throw new Error("pi-decision: PI_DECISION_RISKS is not valid JSON.", { cause: error });
    }
  }
  return resolveGuardrailRisks(input);
}

export function resolvePiGuardrailSpec(env: NodeJS.ProcessEnv): PiGuardrailSpec {
  const mode = choice(
    env.PI_DECISION_ENFORCEMENT,
    ["shadow", "enforce"],
    "PI_DECISION_ENFORCEMENT",
    "shadow",
  );
  const onFailure = choice<GuardrailFailure>(
    env.PI_DECISION_ON_FAILURE,
    ["allow", "ask", "deny"],
    "PI_DECISION_ON_FAILURE",
    "allow",
  );
  const tools = new Set(
    (env.PI_DECISION_TOOLS ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const { risks, policyVersion } = resolvePiRisks(env);
  return {
    mode,
    guardrail: { enabled: true, tools, risks, policyVersion, onFailure },
    outbound: choice(env.PI_DECISION_OUTBOUND, ["redact", "raw"], "PI_DECISION_OUTBOUND", "redact"),
    audit: {
      enabled: flag(env.PI_DECISION_AUDIT, "PI_DECISION_AUDIT", true),
      path: env.PI_DECISION_AUDIT_PATH ?? defaultAuditPath("pi"),
    },
  };
}
