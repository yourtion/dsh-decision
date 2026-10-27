/** Cordis plugin; provider and spec exports can also be used by other hosts. */
import type { Context } from "@deepseek-ai/cordis";
import type DecisionLayer from "@techs/dsh-decision";
import { Config } from "./config.js";
import { resolveOpenRouterConfig, type OpenRouterConfig } from "./spec.js";
import { OpenRouterAdapter, createOpenRouterProvider } from "./provider.js";

export const name = "decision-openrouter";
export const inject = ["decision"];
export { Config, OpenRouterAdapter, createOpenRouterProvider, resolveOpenRouterConfig };
export type { OpenRouterConfig, OpenRouterSpec } from "./spec.js";

export function apply(ctx: Context, config: OpenRouterConfig): void {
  const spec = resolveOpenRouterConfig(config);
  ctx.effect(() => {
    const decision: DecisionLayer = ctx.decision;
    return decision.registerProvider(createOpenRouterProvider(spec));
  });
}
