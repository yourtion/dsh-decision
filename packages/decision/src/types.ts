/**
 * Provider-agnostic typed-judgment primitives. The shapes mirror TypeSafe
 * System One's question types so the Jev adapter is a pure wire mapping, but
 * nothing here knows about Jev: any calibrated decision model can implement
 * {@link DecisionAdapter}.
 * @module dsh-decision/types
 */

/** Lossless-JSON value accepted as decision state. */
export type DecisionState =
  | string
  | number
  | boolean
  | null
  | readonly DecisionState[]
  | { readonly [key: string]: DecisionState };

/** Yes/no question; the answer carries P(true). */
export interface NoulQuestion {
  readonly kind: "noul";
  readonly instructions: string;
  /** Optional descriptions of what "yes" and "no" mean. */
  readonly criteria?: { readonly true?: string; readonly false?: string };
}

/** Single-choice question over named options. */
export interface ChoiceQuestion {
  readonly kind: "choice";
  readonly instructions: string;
  /** Option key → description (null for a bare key). */
  readonly options: Readonly<Record<string, string | null>>;
}

/** Ordered-level scoring question. */
export interface ScoreQuestion {
  readonly kind: "score";
  readonly instructions: string;
  readonly levels: readonly string[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** P(true), calibrated for Jev. */
export interface NoulAnswer {
  readonly kind: "noul";
  readonly probability: number;
}

export interface ChoiceAnswer {
  readonly kind: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export interface ScoreAnswer {
  readonly kind: "score";
  readonly score: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** One evaluation call: shared state plus named questions answered in one round trip. */
export interface DecisionRequest {
  readonly state: DecisionState;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
  /** Cancellation lifetime of the pending gate that asked. */
  readonly signal?: AbortSignal;
}

/**
 * A decision-model adapter. `calibrated: false` marks probability-like answers
 * that are not calibration-fit; such adapters may drive deny/block decisions
 * but never an unattended allow (see the approval seam).
 */
export interface DecisionAdapter {
  readonly id: string;
  readonly calibrated: boolean;
  evaluate(request: DecisionRequest): Promise<Readonly<Record<string, DecisionAnswer>>>;
}

/** Adapter failure (network, timeout, non-2xx, malformed response). */
export class DecisionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DecisionError";
  }
}
