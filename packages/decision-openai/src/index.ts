/** Cordis plugin; provider and spec exports can also be used by other hosts. */
import type { Context } from "@deepseek-ai/cordis";
import type DecisionLayer from "@techs/dsh-decision";
import { Config } from "./config.js";
import { resolveOpenAIConfig, type OpenAIConfig } from "./spec.js";
import { createOpenAIProvider } from "./provider.js";

export const name = "decision-openai";
export const inject = ["decision"];
export { Config, createOpenAIProvider, resolveOpenAIConfig };
export type { OpenAIConfig, OpenAISpec } from "./spec.js";

export function apply(ctx: Context, config: OpenAIConfig): void {
  const spec = resolveOpenAIConfig(config);
  ctx.effect(() => {
    const decision: DecisionLayer = ctx.decision;
    return decision.registerProvider(createOpenAIProvider(spec));
  });
}
