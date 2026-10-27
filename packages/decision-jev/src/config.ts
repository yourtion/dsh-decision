/**
 * dsh-decision-jev configuration: provider settings with an explicit
 * `resolveJevConfig()` step; a missing key fails loud at plugin load.
 * @module dsh-decision-jev/config
 */

import z from "@deepseek-ai/schemastery";
import type { DecisionConnectionConfig } from "@techs/dsh-decision/kernel";
export { resolveJevConfig } from "./spec.js";
export type { JevSpec } from "./spec.js";

/** Jev (TypeSafe System One wire) provider settings. */
export type JevConfig = DecisionConnectionConfig;

/** Schemastery validation for {@link JevConfig}. */
export const Config: z<JevConfig> = z.object({
  baseUrl: z.string(),
  apiKey: z.string(),
  apiKeyEnv: z.string(),
  model: z.string(),
  timeoutMs: z.number(),
});
