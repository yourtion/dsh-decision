import z from "@deepseek-ai/schemastery";
import type { OpenAIConfig } from "./spec.js";

export { resolveOpenAIConfig } from "./spec.js";
export type { OpenAIConfig, OpenAISpec } from "./spec.js";

export const Config: z<OpenAIConfig> = z.object({
  baseUrl: z.string(),
  apiKey: z.string(),
  apiKeyEnv: z.string(),
  model: z.string(),
  timeoutMs: z.number().min(1),
});
