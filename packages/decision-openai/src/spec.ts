/** Host-neutral connection settings for POST /v1/decisions. */
export interface OpenAIConfig {
  /** Versioned API root; the provider appends /decisions. */
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

export interface OpenAISpec {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
}

export function resolveOpenAIConfig(
  config: OpenAIConfig,
  env: NodeJS.ProcessEnv = process.env,
): OpenAISpec {
  const apiKey = config.apiKey || env[config.apiKeyEnv ?? "OPENAI_API_KEY"];
  if (!apiKey?.trim()) {
    throw new Error("dsh-decision-openai: set apiKey or apiKeyEnv (default OPENAI_API_KEY).");
  }
  const baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("dsh-decision-openai: baseUrl must be a versioned HTTP(S) API root.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "dsh-decision-openai: baseUrl must be HTTP(S), without credentials, query or fragment.",
    );
  }
  const model = config.model ?? "gpt-6-luna";
  if (!model.trim()) throw new Error("dsh-decision-openai: model must be non-empty.");
  const timeoutMs = config.timeoutMs ?? 8_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 4_294_967_295) {
    throw new Error("dsh-decision-openai: timeoutMs must be a positive uint32 integer.");
  }
  return { baseUrl, apiKey, model, timeoutMs };
}
