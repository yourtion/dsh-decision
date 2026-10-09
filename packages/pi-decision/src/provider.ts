import type { JudgmentProvider } from "@techs/dsh-decision/kernel";
import { createJevProvider } from "@techs/dsh-decision-jev/provider";
import { createOpenAIProvider } from "@techs/dsh-decision-openai/provider";
import { resolvePiJevSpec, resolvePiOpenAISpec, resolvePiProviderId } from "./spec.js";

export function createPiProvider(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): JudgmentProvider {
  return resolvePiProviderId(env) === "openai"
    ? createOpenAIProvider(resolvePiOpenAISpec(env), fetchImpl)
    : createJevProvider(resolvePiJevSpec(env), fetchImpl);
}
