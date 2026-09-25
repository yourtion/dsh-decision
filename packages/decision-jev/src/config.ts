/**
 * dsh-decision-jev configuration: provider settings with an explicit
 * `resolveJevConfig()` step; a missing key fails loud at plugin load.
 * @module dsh-decision-jev/config
 */

import z from "@deepseek-ai/schemastery";

/** Jev (TypeSafe System One wire) provider settings. */
export interface JevConfig {
  /** API root; the adapter posts to `{baseUrl}/v1/systemone`. */
  readonly baseUrl?: string;
  /** Literal API key. */
  readonly apiKey?: string;
  /** Name of an environment variable holding the API key. */
  readonly apiKeyEnv?: string;
  /** Model id understood by the provider. */
  readonly model?: string;
  /** Per-call timeout in milliseconds. */
  readonly timeoutMs?: number;
}

/** Schemastery validation for {@link JevConfig}. */
export const Config: z<JevConfig> = z.object({
  baseUrl: z.string(),
  apiKey: z.string(),
  apiKeyEnv: z.string(),
  model: z.string(),
  timeoutMs: z.number(),
});

/** The provider's public defaults. */
const DEFAULT_BASE_URL = "https://jev-ai.pro/api";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 8_000;

/** Fully-defaulted Jev provider spec. */
export interface JevSpec {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
}

/**
 * Resolve one API key: literal `apiKey`, else the `apiKeyEnv` variable, else
 * fail loud — a missing key at load beats a failed call per tool execution.
 * @param config - raw Jev provider config.
 * @returns the fully-defaulted spec the adapter posts with.
 * @throws when neither source yields a non-empty key.
 */
export function resolveJevConfig(config: JevConfig): JevSpec {
  let apiKey = config.apiKey;
  if (apiKey === undefined || apiKey === "") {
    const envName = config.apiKeyEnv;
    apiKey = envName === undefined ? undefined : process.env[envName];
  }
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      `dsh-decision-jev: needs a key — set "apiKey", or "apiKeyEnv" naming a non-empty environment variable (got apiKeyEnv=${JSON.stringify(config.apiKeyEnv)}).`,
    );
  }
  return {
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    apiKey,
    model: config.model ?? DEFAULT_MODEL,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}
