import type { Agent } from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-llm";

export interface StepDecisionContext {
  readonly turn: number;
  readonly step: number;
  readonly messages: readonly UserMessage[];
}

/** A pre-step result is authoritative only when the step was admitted. */
export class StepContextStore {
  readonly #byAgent = new WeakMap<Agent, Map<string, StepDecisionContext>>();

  record(
    agent: Agent,
    turn: number,
    step: number,
    decision:
      | { readonly kind: "reject" }
      | { readonly kind: "enter"; readonly messages: UserMessage[] },
  ): void {
    // An earlier proposed step can be rejected or cancelled before agent/request.
    // Keep only this agent's current admitted step, so stale messages cannot route it.
    if (decision.kind !== "enter") {
      this.#byAgent.delete(agent);
      return;
    }
    this.#byAgent.set(
      agent,
      new Map([[`${turn}:${step}`, { turn, step, messages: [...decision.messages] }]]),
    );
  }

  take(agent: Agent, turn: number, step: number): StepDecisionContext | undefined {
    const steps = this.#byAgent.get(agent);
    const key = `${turn}:${step}`;
    const context = steps?.get(key);
    steps?.delete(key);
    if (steps?.size === 0) this.#byAgent.delete(agent);
    return context;
  }

  clear(agent: Agent): void {
    this.#byAgent.delete(agent);
  }
}

/** Use only accepted text from this step; prior session events may not be committed yet. */
export function taskHint(messages: readonly UserMessage[], limit = 2_000): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const parts = messages[i]!.content.flatMap((block) =>
      block.type === "text" ? [block.text] : [],
    );
    const joined = parts.join("\n");
    if (joined !== "") return joined.length > limit ? `${joined.slice(0, limit)}…` : joined;
  }
  return undefined;
}
