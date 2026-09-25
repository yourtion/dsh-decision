/**
 * Adapter registry and resolution: the provider seam other plugins extend.
 * @module dsh-decision/service
 */

import type { DecisionAdapter } from "./types.js";
import type { ResolvedConfig } from "./config.js";
import type { JudgmentProvider, JudgmentRequest, JudgmentResult } from "./judgment.js";
import { ProviderValidationError } from "./types.js";
import { legacyAdapterProvider } from "./legacy-provider.js";
import { validateJudgmentResult } from "./judgment-validation.js";

/**
 * Holds registered providers and v1 adapters. `DecisionLayer` exposes its
 * registration methods through `ctx.decision`.
 */
export class DecisionRuntime {
  readonly #adapters = new Map<string, DecisionAdapter>();
  readonly #providers = new Map<string, JudgmentProvider>();
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
    // Old adapters remain usable while seams migrate to the neutral API.
    const bridge = this.#providers.has(adapter.id) ? undefined : legacyAdapterProvider(adapter);
    if (bridge) this.#providers.set(adapter.id, bridge);
    return () => {
      this.#adapters.delete(adapter.id);
      if (bridge && this.#providers.get(adapter.id) === bridge) this.#providers.delete(adapter.id);
    };
  }

  registerProvider(provider: JudgmentProvider): () => void {
    if (this.#providers.has(provider.id)) {
      throw new Error(`dsh-decision: duplicate provider id "${provider.id}".`);
    }
    this.#providers.set(provider.id, provider);
    return () => this.#providers.delete(provider.id);
  }

  provider(): JudgmentProvider {
    const provider = this.#providers.get(this.#config.provider);
    if (!provider)
      throw new Error(`dsh-decision: provider "${this.#config.provider}" is not registered.`);
    return provider;
  }

  async evaluate(request: JudgmentRequest, signal?: AbortSignal): Promise<JudgmentResult> {
    const provider = this.provider();
    const capabilities = provider.capabilities();
    for (const question of Object.values(request.questions)) {
      if (!capabilities[question.kind]) {
        throw new ProviderValidationError(
          `Provider "${provider.id}" cannot answer ${question.kind} questions.`,
        );
      }
    }
    const timeout = AbortSignal.timeout(this.#config.timeoutMs);
    const gate = signal ? AbortSignal.any([signal, timeout]) : timeout;
    gate.throwIfAborted();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(gate.reason ?? new Error("dsh-decision: evaluation aborted."));
      if (gate.aborted) onAbort();
      else gate.addEventListener("abort", onAbort, { once: true });
    });
    let result: JudgmentResult;
    try {
      result = await Promise.race([provider.evaluate(request, gate), aborted]);
    } finally {
      if (onAbort) gate.removeEventListener("abort", onAbort);
    }
    validateJudgmentResult(request, result);
    if (result.provider !== provider.id) {
      throw new ProviderValidationError(`Provider identity mismatch: expected "${provider.id}".`);
    }
    if (provider.model !== undefined && result.model !== provider.model) {
      throw new ProviderValidationError(`Provider model mismatch: expected "${provider.model}".`);
    }
    return result;
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
