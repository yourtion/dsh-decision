/** Model tier routing by Choice or opt-in composite ordinal scoring. */

import type { JudgmentRequest, JudgmentResult } from "../judgment.js";
import type { LlmCallConfig } from "@deepseek-ai/dsh-llm";
import type { RouteConfig, RoutingSpec } from "../config.js";

export const INSUFFICIENT_CONTEXT = "insufficient_context";

const ROUTING_INSTRUCTIONS =
  "Which configured model tier fits this coding-agent request? Consider the reasoning needed, scope of changes, and ambiguity. Select insufficient_context when the task is too vague to distinguish tiers.";

/** Rubrics are intentionally concrete; score 0 is the first level. */
export const ROUTING_RUBRICS = {
  reasoningComplexity: {
    instructions:
      "How much reasoning does this task require? Judge the work described, not the message length.",
    levels: [
      "Direct, known steps with a clear local answer.",
      "Several connected steps with familiar tradeoffs.",
      "Cross-module reasoning or an uncertain cause that needs investigation.",
      "Novel architecture, difficult root cause, or competing constraints requiring deep reasoning.",
    ],
  },
  changeScope: {
    instructions: "How broad are the requested changes? Judge only the work described.",
    levels: [
      "No code change or one small local edit.",
      "A few edits within one component or module.",
      "Changes across multiple modules or interfaces.",
      "System-wide behavior or several interacting subsystems must change.",
    ],
  },
  ambiguity: {
    instructions: "How much uncertainty must be resolved before implementing the request?",
    levels: [
      "Goal, constraints, and expected behavior are explicit.",
      "One or two routine details need inference.",
      "Important behavior or constraints require investigation or interpretation.",
      "Core goal or constraints are unclear and materially affect the solution.",
    ],
  },
} as const;

const DIMENSIONS = ["reasoningComplexity", "changeScope", "ambiguity"] as const;

/** One provider round trip. Choice descriptions are required by resolveConfig. */
export function buildRoutingRequest(taskHint: string, spec: RoutingSpec): JudgmentRequest {
  if (spec.strategy === "composite") {
    return {
      state: { task: taskHint },
      questions: Object.fromEntries(
        DIMENSIONS.map((key) => [
          key,
          {
            kind: "ordinal" as const,
            instructions: ROUTING_RUBRICS[key].instructions,
            levels: ROUTING_RUBRICS[key].levels,
          },
        ]),
      ),
    };
  }
  const options: Record<string, string> = {};
  for (const route of spec.routes) options[route.key] = route.description ?? "";
  options[INSUFFICIENT_CONTEXT] =
    "The request lacks enough information to choose a model tier; keep the host's default selection.";
  return {
    state: { task: taskHint },
    questions: { tier: { kind: "categorical", instructions: ROUTING_INSTRUCTIONS, options } },
  };
}

function confidenceIsEnough(confidence: number | undefined, floor: number): boolean {
  return (
    confidence !== undefined &&
    Number.isFinite(confidence) &&
    confidence >= floor &&
    confidence <= 1
  );
}

function routeFromComposite(result: JudgmentResult, spec: RoutingSpec): RouteConfig | undefined {
  let weighted = 0;
  let totalWeight = 0;
  for (const key of DIMENSIONS) {
    const answer = result.answers[key];
    if (answer === undefined || answer.kind !== "ordinal") {
      throw new Error(`dsh-decision: routing expected an ordinal answer for "${key}".`);
    }
    if (!confidenceIsEnough(answer.confidence, spec.confidenceFloor)) return undefined;
    const maximum = ROUTING_RUBRICS[key].levels.length - 1;
    if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > maximum) {
      throw new Error(`dsh-decision: invalid routing score for "${key}".`);
    }
    const weight = spec.composite.weights[key];
    weighted += weight * (answer.score / maximum);
    totalWeight += weight;
  }
  const score = Math.min(1, weighted / totalWeight);
  const band = spec.composite.bands.find((candidate) => score <= candidate.upTo);
  return spec.routes.find((route) => route.key === band?.routeKey);
}

/** Merge the selected route onto the host's fallback config. */
export function decideRouting(
  result: JudgmentResult,
  spec: RoutingSpec,
  fallback: LlmCallConfig,
): LlmCallConfig {
  let route: RouteConfig | undefined;
  if (spec.strategy === "composite") {
    route = routeFromComposite(result, spec);
  } else {
    const answer = result.answers.tier;
    if (answer === undefined || answer.kind !== "categorical") {
      throw new Error('dsh-decision: routing expected a categorical answer for "tier".');
    }
    if (!confidenceIsEnough(answer.confidence, spec.confidenceFloor)) return fallback;
    if (answer.choice === INSUFFICIENT_CONTEXT) return fallback;
    route = spec.routes.find((candidate) => candidate.key === answer.choice);
  }
  if (route === undefined) return fallback;
  const merged: LlmCallConfig = { ...fallback };
  if (route.provider !== undefined) merged.provider = route.provider;
  if (route.model !== undefined) merged.model = route.model;
  if (route.reasoningEffort !== undefined)
    merged.reasoningEffort = route.reasoningEffort as LlmCallConfig["reasoningEffort"];
  if (route.maxTokens !== undefined) merged.maxTokens = route.maxTokens;
  return merged;
}
