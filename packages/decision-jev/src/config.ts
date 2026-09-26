/**
 * dsh-decision-jev configuration: provider settings with an explicit
 * `resolveJevConfig()` step; a missing key fails loud at plugin load.
 * @module dsh-decision-jev/config
 */

import z from "@deepseek-ai/schemastery";
export { resolveJevConfig } from "./spec.js";
export type { JevSpec } from "./spec.js";

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
