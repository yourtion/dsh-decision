/** Host-neutral Jev settings. No Cordis or Schemastery imports. */
import type { JevConfig } from "./config.js";

export interface JevSpec {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
}

export function resolveJevConfig(config: JevConfig): JevSpec {
  let apiKey = config.apiKey;
  if (apiKey === undefined || apiKey === "") {
    const envName = config.apiKeyEnv;
    apiKey = envName === undefined ? undefined : process.env[envName];
  }
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      `dsh-decision-jev: needs a key — set "apiKey", or "apiKeyEnv" naming a non-empty environment variable (got apiKeyEnv=${JSON.stringify(config.apiKeyEnv)}).`,
    );
  }
  return {
    baseUrl: config.baseUrl ?? "https://jev-ai.pro/api",
    apiKey,
    model: config.model ?? "jev-latest",
    timeoutMs: config.timeoutMs ?? 8_000,
  };
}
