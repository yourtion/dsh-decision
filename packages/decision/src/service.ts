/**
 * Adapter registry and resolution: the provider seam other plugins extend.
 * @module dsh-decision/service
 */

import type { DecisionAdapter } from "./types.js";
import type { ResolvedConfig } from "./config.js";

/**
 * Holds the registered adapters and resolves the configured active one.
 * Exposed as `ctx.decision`; `registerAdapter()` is the extension point for
 * future decision models.
 */
export class DecisionRuntime {
  readonly #adapters = new Map<string, DecisionAdapter>();
  readonly #config: ResolvedConfig;

  constructor(config: ResolvedConfig) {
    this.#config = config;
  }

  /**
   * Register one adapter under its id.
   * @param adapter - the adapter to register.
   * @returns a disposer removing the registration.
   * @throws on a duplicate id.
   */
  registerAdapter(adapter: DecisionAdapter): () => void {
    if (this.#adapters.has(adapter.id)) {
      throw new Error(`dsh-decision: duplicate adapter id "${adapter.id}".`);
    }
    this.#adapters.set(adapter.id, adapter);
    return () => {
      this.#adapters.delete(adapter.id);
    };
  }

  /**
   * Resolve the configured active adapter.
   * @returns the adapter named by `provider`.
   * @throws when it was never registered — a missing decision provider fails
   *   loud at first use rather than silently allowing.
   */
  active(): DecisionAdapter {
    const adapter = this.#adapters.get(this.#config.provider);
    if (adapter === undefined) {
      throw new Error(
        `dsh-decision: provider "${this.#config.provider}" is not a registered adapter.`,
      );
    }
    return adapter;
  }
}
