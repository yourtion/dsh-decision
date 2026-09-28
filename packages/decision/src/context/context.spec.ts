import { describe, expect, it } from "vitest";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import { StepContextStore, taskHint } from "./step-context.js";
import { isDecisionEscalation, markDecisionEscalation } from "./provenance.js";

function message(text: string): UserMessage {
  return { content: [{ type: "text", text }] } as UserMessage;
}

describe("routing step context", () => {
  it("uses the final accepted batch and isolates agents and step keys", () => {
    const store = new StepContextStore();
    const first = {} as Agent;
    const second = {} as Agent;
    store.record(first, 1, 1, { kind: "enter", messages: [message("original")] });
    store.record(second, 1, 1, { kind: "enter", messages: [message("other agent")] });
    store.record(first, 1, 2, { kind: "enter", messages: [message("accepted steering")] });
    expect(store.take(first, 1, 1)).toBeUndefined();
    expect(taskHint(store.take(first, 1, 2)!.messages)).toBe("accepted steering");
    expect(taskHint(store.take(second, 1, 1)!.messages)).toBe("other agent");
    expect(store.take(first, 1, 2)).toBeUndefined();
  });

  it("drops rejected steps and ignores non-text content", () => {
    const store = new StepContextStore();
    const agent = {} as Agent;
    store.record(agent, 1, 1, { kind: "enter", messages: [message("stale")] });
    store.record(agent, 1, 2, { kind: "reject" });
    expect(store.take(agent, 1, 1)).toBeUndefined();
    expect(taskHint([message("first"), message("second")])).toBe("second");
    expect(taskHint([message("abcdef")], 3)).toBe("abc…");
  });

  it("retains accepted task and steering after routing consumes the step", () => {
    const store = new StepContextStore();
    const agent = {} as Agent;
    store.record(agent, 1, 1, { kind: "enter", messages: [message("implement feature")] });
    store.take(agent, 1, 1);
    store.record(agent, 1, 2, { kind: "enter", messages: [message("keep the old API")] });
    expect(store.current(agent)?.messages).toEqual([
      message("implement feature"),
      message("keep the old API"),
    ]);
    store.record(agent, 2, 1, { kind: "enter", messages: [message("different task")] });
    expect(store.current(agent)?.messages).toEqual([message("different task")]);
    store.clear(agent);
    expect(store.current(agent)).toBeUndefined();
  });
});

describe("approval provenance", () => {
  it("marks decision escalations so machine approval delegates", () => {
    expect(isDecisionEscalation(markDecisionEscalation("review"))).toBe(true);
    expect(isDecisionEscalation("native approval: review")).toBe(false);
  });
});
