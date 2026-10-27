import z from "@deepseek-ai/schemastery";
import type { OpenRouterConfig } from "./spec.js";

export { resolveOpenRouterConfig } from "./spec.js";
export type { OpenRouterConfig, OpenRouterSpec } from "./spec.js";

export const Config: z<OpenRouterConfig> = z.object({
  baseUrl: z.string(),
  apiKey: z.string(),
  apiKeyEnv: z.string(),
  model: z.string(),
  timeoutMs: z.number().min(1),
  questionKinds: z
    .array(z.union(["binary", "categorical", "ordinal"] as const))
    .default(["binary", "categorical", "ordinal"]),
});
