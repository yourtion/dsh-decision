import type { JudgmentProvider } from "@techs/dsh-decision/kernel";
import { createJevProvider } from "@techs/dsh-decision-jev/provider";
import { createOpenAIProvider } from "@techs/dsh-decision-openai/provider";
import { createOpenRouterProvider } from "@techs/dsh-decision-openrouter/provider";
import {
  resolvePiJevSpec,
  resolvePiOpenAISpec,
  resolvePiOpenRouterSpec,
  resolvePiProviderId,
} from "./spec.js";

export function createPiProvider(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): JudgmentProvider {
  switch (resolvePiProviderId(env)) {
    case "openai":
      return createOpenAIProvider(resolvePiOpenAISpec(env), fetchImpl);
    case "openrouter":
      return createOpenRouterProvider(resolvePiOpenRouterSpec(env), fetchImpl);
    case "jev":
      return createJevProvider(resolvePiJevSpec(env), fetchImpl);
  }
}
