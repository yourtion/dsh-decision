import type {
  DecisionConnectionConfig,
  DecisionConnectionSpec,
  JudgmentQuestion,
} from "@techs/dsh-decision/kernel";

/** API root includes /api/alpha; the adapter appends /decisions. */
export interface OpenRouterConfig extends DecisionConnectionConfig {
  /** Model-specific restrictions. Defaults to all three wire-supported types. */
  readonly questionKinds?: JudgmentQuestion["kind"][];
}
export interface OpenRouterSpec extends DecisionConnectionSpec {
  readonly questionKinds: readonly JudgmentQuestion["kind"][];
}

export function resolveOpenRouterConfig(
  config: OpenRouterConfig,
  env: NodeJS.ProcessEnv = process.env,
): OpenRouterSpec {
  const apiKey = config.apiKey || env[config.apiKeyEnv ?? "OPENROUTER_API_KEY"];
  if (!apiKey?.trim()) {
    throw new Error(
      "dsh-decision-openrouter: set apiKey or apiKeyEnv (default OPENROUTER_API_KEY).",
    );
  }
  const baseUrl = (config.baseUrl ?? "https://openrouter.ai/api/alpha").replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("dsh-decision-openrouter: baseUrl must be a versioned HTTP(S) API root.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "dsh-decision-openrouter: baseUrl must be HTTP(S), without credentials, query or fragment.",
    );
  }
  const model = config.model ?? "";
  if (!model.trim())
    throw new Error("dsh-decision-openrouter: model must be explicitly configured and non-empty.");
  const timeoutMs = config.timeoutMs ?? 8_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 4_294_967_295) {
    throw new Error("dsh-decision-openrouter: timeoutMs must be a positive uint32 integer.");
  }
  const questionKinds = [
    ...new Set(config.questionKinds ?? ["binary", "categorical", "ordinal"]),
  ] as JudgmentQuestion["kind"][];
  if (
    questionKinds.length === 0 ||
    questionKinds.some((kind) => !["binary", "categorical", "ordinal"].includes(kind))
  ) {
    throw new Error(
      "dsh-decision-openrouter: questionKinds must contain binary, categorical or ordinal.",
    );
  }
  return { baseUrl, apiKey, model, timeoutMs, questionKinds };
}
