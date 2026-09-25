/**
 * Routing seam: pick the model tier for one agent request with a Categorical
 * question, falling back to the machine's selection below the confidence floor.
 * @module dsh-decision/seams/routing
 */

import type { JudgmentRequest, JudgmentResult } from "../judgment.js";
import type { LlmCallConfig } from "@deepseek-ai/dsh-llm";
import type { RouteConfig, RoutingSpec } from "../config.js";

const ROUTING_INSTRUCTIONS =
  "Which model tier should serve this coding-agent request? Choose by task difficulty and risk of the work described, not by length.";

/**
 * Build the routing request: the task hint plus one Categorical question whose
 * options are the configured route keys.
 * @param taskHint - the last user message text (already truncated by the caller).
 * @param routes - the configured routes, providing the option keys.
 * @param signal - cancellation lifetime of the gate.
 * @returns the judgment request carrying the Categorical question.
 */
export function buildRoutingRequest(
  taskHint: string,
  routes: readonly RouteConfig[],
): JudgmentRequest {
  const options: Record<string, string | null> = {};
  for (const route of routes) options[route.key] = route.description ?? null;
  return {
    state: { task: taskHint },
    questions: { tier: { kind: "categorical", instructions: ROUTING_INSTRUCTIONS, options } },
  };
}

/**
 * Merge the chosen tier onto the fallback config.
 * @param answers - adapter answers for `tier`.
 * @param spec - resolved routing spec.
 * @param fallback - the config the machine would use (`await next()`).
 * @returns the replacement config, or the fallback when the confidence floor
 *   is missed, the chosen key has no route, or the route pins no field.
 * @throws on a missing or non-Categorical answer.
 */
export function decideRouting(
  result: JudgmentResult,
  spec: RoutingSpec,
  fallback: LlmCallConfig,
): LlmCallConfig {
  const answer = result.answers.tier;
  if (answer === undefined || answer.kind !== "categorical") {
    throw new Error('dsh-decision: routing expected a categorical answer for "tier".');
  }
  if ((answer.confidence ?? answer.probabilities[answer.choice] ?? 0) < spec.confidenceFloor)
    return fallback;
  const route = spec.routes.find((candidate) => candidate.key === answer.choice);
  if (route === undefined) return fallback;
  const merged: LlmCallConfig = { ...fallback };
  if (route.provider !== undefined) merged.provider = route.provider;
  if (route.model !== undefined) merged.model = route.model;
  if (route.reasoningEffort !== undefined)
    merged.reasoningEffort = route.reasoningEffort as LlmCallConfig["reasoningEffort"];
  if (route.maxTokens !== undefined) merged.maxTokens = route.maxTokens;
  return merged;
}
