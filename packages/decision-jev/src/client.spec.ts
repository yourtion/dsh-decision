import { describe, expect, it } from "vitest";
import { createJevAdapter } from "./client.js";
import { DecisionError } from "@techs/dsh-decision";
import type { JevSpec } from "./config.js";

const spec: JevSpec = {
  baseUrl: "https://jev-ai.pro/api/",
  apiKey: "test-key",
  model: "jev-latest",
  timeoutMs: 5_000,
};

type FetchCall = { url: string; init: RequestInit };

/** Capture requests and reply with scripted responses (optionally per attempt). */
function scripted(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: FetchCall[] = [];
  let attempt = 0;
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const response = responses[Math.min(attempt, responses.length - 1)];
    attempt += 1;
    return new Response(response.body === undefined ? "" : JSON.stringify(response.body), {
      status: response.status ?? 200,
    });
  }) as typeof fetch;
  return { impl, calls };
}

const request = {
  state: { tool: "bash", arguments: { command: "rm -rf /" } },
  questions: {
    harmful: { kind: "noul" as const, instructions: "Harmful?" },
    tier: {
      kind: "choice" as const,
      instructions: "Tier?",
      options: { cheap: null, flagship: "big tasks" },
    },
  },
};

describe("jev adapter wire mapping", () => {
  it("posts the systemone body under the provider key and maps answers back", async () => {
    const { impl, calls } = scripted([
      {
        body: {
          model: "jev-latest",
          answers: {
            harmful: { type: "noul", noul: 0.93 },
            tier: {
              type: "choice",
              choice: "flagship",
              probabilities: { cheap: 0.1, flagship: 0.9 },
              confidence: 0.9,
            },
          },
        },
      },
    ]);
    const answers = await createJevAdapter(spec, impl).evaluate(request);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://jev-ai.pro/api/v1/systemone");
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer test-key",
    );
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("jev-latest");
    expect(body.questions.harmful).toEqual({ type: "noul", instructions: "Harmful?" });
    expect(body.questions.tier).toEqual({
      type: "choice",
      instructions: "Tier?",
      criteria: { cheap: null, flagship: "big tasks" },
    });
    expect(answers.harmful).toEqual({ kind: "noul", probability: 0.93 });
    expect(answers.tier).toEqual({
      kind: "choice",
      choice: "flagship",
      probabilities: { cheap: 0.1, flagship: 0.9 },
      confidence: 0.9,
    });
  });

  it("maps noul criteria and score levels onto the wire criteria field", async () => {
    const { impl, calls } = scripted([{ body: { answers: { n: { type: "noul", noul: 0.1 } } } }]);
    await createJevAdapter(spec, impl).evaluate({
      state: "x",
      questions: {
        n: { kind: "noul", instructions: "Q", criteria: { true: "yes means danger" } },
      },
    });
    expect(JSON.parse(calls[0]!.init.body as string).questions.n).toEqual({
      type: "noul",
      instructions: "Q",
      criteria: { true: "yes means danger" },
    });
  });

  it("retries once on 429 then succeeds", async () => {
    const { impl, calls } = scripted([
      { status: 429, body: { error: "rate limited" } },
      { body: { answers: { harmful: { type: "noul", noul: 0 } } } },
    ]);
    const answers = await createJevAdapter(spec, impl).evaluate({
      state: "x",
      questions: { harmful: { kind: "noul", instructions: "Harmful?" } },
    });
    expect(calls.length).toBe(2);
    expect(answers.harmful).toEqual({ kind: "noul", probability: 0 });
  });

  it("fails with a DecisionError carrying the status on a persistent non-2xx", async () => {
    const { impl } = scripted([{ status: 401, body: { error: "bad key" } }]);
    await expect(
      createJevAdapter(spec, impl).evaluate({
        state: "x",
        questions: { n: { kind: "noul", instructions: "Q" } },
      }),
    ).rejects.toMatchObject({ name: "DecisionError", status: 401 });
  });

  it("fails loud on a malformed or missing answer", async () => {
    const { impl } = scripted([{ body: { answers: { harmful: { type: "noul" } } } }]);
    await expect(
      createJevAdapter(spec, impl).evaluate({
        state: "x",
        questions: { harmful: { kind: "noul", instructions: "Q" } },
      }),
    ).rejects.toBeInstanceOf(DecisionError);
  });
});
