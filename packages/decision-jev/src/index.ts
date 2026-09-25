/**
 * dsh-decision-jev plugin: registers the Jev (TypeSafe System One) adapter on
 * the decision-layer service as soon as both are loaded.
 * @module dsh-decision-jev
 */

import type { Context } from "@deepseek-ai/cordis";
import { Config, resolveJevConfig } from "./config.js";
import type { JevConfig } from "./config.js";
import { createJevAdapter } from "./client.js";
import { createJevProvider } from "./provider.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "decision-jev";

/** The adapter registers only after the decision service exists. */
export const inject = ["decision"];

export { Config };
export type { JevConfig };
export { createJevAdapter } from "./client.js";
export { createJevProvider } from "./provider.js";
export { resolveJevConfig } from "./config.js";

/**
 * Register the Jev adapter for the lifetime of `ctx`.
 * @param ctx - plugin context; the registration is disposed with it.
 * @param config - provider settings (baseUrl, key, model, timeout).
 * @throws when no API key resolves — misconfiguration fails loud at load.
 */
export function apply(ctx: Context, config: JevConfig): void {
  const spec = resolveJevConfig(config);
  ctx.effect(() => {
    const unregisterProvider = ctx.decision.registerProvider(createJevProvider(spec));
    let unregisterAdapter: () => void;
    try {
      unregisterAdapter = ctx.decision.registerAdapter(createJevAdapter(spec));
    } catch (error) {
      unregisterProvider();
      throw error;
    }
    return () => {
      unregisterAdapter();
      unregisterProvider();
    };
  });
}
