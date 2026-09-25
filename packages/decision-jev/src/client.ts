/**
 * Jev adapter: thin HTTP client for the TypeSafe System One wire format.
 * Works against jev-ai.pro (same JSON as TypeSafe's native endpoint) and
 * TypeSafe itself — only `baseUrl` differs.
 * @module dsh-decision-jev/client
 */

import {
  DecisionError,
  type ChoiceAnswer,
  type DecisionAdapter,
  type DecisionAnswer,
  type DecisionQuestion,
  type DecisionRequest,
  type NoulAnswer,
  type ScoreAnswer,
} from "dsh-decision";
import type { JevSpec } from "./config.js";

/** Retry once on these statuses with linear backoff, per the API reference. */
const RETRYABLE_STATUS = new Set([429, 529]);
const RETRY_DELAY_MS = 500;

/** Wire question shape: `type` + `instructions` (+ `criteria`). */
type WireQuestion = { type: string; instructions: string; criteria?: unknown };

/** Wire answer union actually consumed; unknown types fail loud. */
interface WireAnswer {
  type: string;
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

/** Map one neutral question onto the wire shape. */
function toWireQuestion(question: DecisionQuestion): WireQuestion {
  switch (question.kind) {
    case "noul":
      return {
        type: "noul",
        instructions: question.instructions,
        ...(question.criteria === undefined ? {} : { criteria: question.criteria }),
      };
    case "choice":
      return { type: "choice", instructions: question.instructions, criteria: question.options };
    case "score":
      return { type: "score", instructions: question.instructions, criteria: question.levels };
  }
}

/** Map one wire answer onto the neutral union. */
function fromWireAnswer(key: string, answer: WireAnswer): DecisionAnswer {
  switch (answer.type) {
    case "noul": {
      if (typeof answer.noul !== "number") break;
      const noul: NoulAnswer = { kind: "noul", probability: answer.noul };
      return noul;
    }
    case "choice": {
      if (
        typeof answer.choice !== "string" ||
        answer.probabilities === undefined ||
        typeof answer.confidence !== "number"
      )
        break;
      const choice: ChoiceAnswer = {
        kind: "choice",
        choice: answer.choice,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
      };
      return choice;
    }
    case "score": {
      if (
        typeof answer.score !== "number" ||
        answer.probabilities === undefined ||
        typeof answer.confidence !== "number"
      )
        break;
      const score: ScoreAnswer = {
        kind: "score",
        score: answer.score,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
      };
      return score;
    }
  }
  throw new DecisionError(
    `jev: malformed answer for question "${key}" (type=${JSON.stringify(answer.type)}).`,
  );
}

/**
 * Build the Jev adapter.
 * @param spec - resolved provider spec (baseUrl, key, model, timeout).
 * @param fetchImpl - fetch implementation (injectable for tests).
 * @returns the adapter registered under id `jev`.
 */
export function createJevAdapter(spec: JevSpec, fetchImpl: typeof fetch = fetch): DecisionAdapter {
  const endpoint = `${spec.baseUrl.replace(/\/+$/, "")}/v1/systemone`;
  return {
    id: "jev",
    calibrated: true,
    async evaluate(request: DecisionRequest): Promise<Readonly<Record<string, DecisionAnswer>>> {
      const body = JSON.stringify({
        state: request.state,
        model: spec.model,
        questions: Object.fromEntries(
          Object.entries(request.questions).map(([key, question]) => [
            key,
            toWireQuestion(question),
          ]),
        ),
      });
      const signal =
        request.signal === undefined
          ? AbortSignal.timeout(spec.timeoutMs)
          : AbortSignal.any([request.signal, AbortSignal.timeout(spec.timeoutMs)]);
      const ask = async (): Promise<Response> =>
        fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${spec.apiKey}`,
            "content-type": "application/json",
          },
          body,
          signal,
        });

      let response = await ask();
      if (RETRYABLE_STATUS.has(response.status)) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        response = await ask();
      }
      if (!response.ok) {
        let detail = "";
        try {
          detail = await response.text();
        } catch {
          // The status line below already identifies the failure; the body is supplementary.
        }
        throw new DecisionError(
          `jev: HTTP ${response.status}${detail === "" ? "" : ` — ${detail.slice(0, 200)}`}.`,
          response.status,
        );
      }
      let payload: { answers?: Record<string, WireAnswer> };
      try {
        payload = (await response.json()) as { answers?: Record<string, WireAnswer> };
      } catch (error) {
        throw new DecisionError(`jev: response is not JSON (${String(error)}).`);
      }
      const answers = payload.answers;
      if (answers === undefined || typeof answers !== "object") {
        throw new DecisionError("jev: response has no answers object.");
      }
      const mapped: Record<string, DecisionAnswer> = {};
      for (const key of Object.keys(request.questions)) {
        const answer = answers[key];
        if (answer === undefined)
          throw new DecisionError(`jev: answer missing for question "${key}".`);
        mapped[key] = fromWireAnswer(key, answer);
      }
      return mapped;
    },
  };
}
