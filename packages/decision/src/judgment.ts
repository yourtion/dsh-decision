import type { DecisionState } from "./types.js";

/** Provider-neutral question vocabulary. */
export interface BinaryQuestion {
  readonly kind: "binary";
  readonly instructions: string;
  readonly criteria?: { readonly true?: string; readonly false?: string };
}

export interface CategoricalQuestion {
  readonly kind: "categorical";
  readonly instructions: string;
  readonly options: Readonly<Record<string, string | null>>;
}

/** Ordered rubric. A score is an expected position, not a selected level. */
export interface OrdinalQuestion {
  readonly kind: "ordinal";
  readonly instructions: string;
  readonly levels: readonly string[];
}

export type JudgmentQuestion = BinaryQuestion | CategoricalQuestion | OrdinalQuestion;

export interface BinaryAnswer {
  readonly kind: "binary";
  readonly probability: number;
}

export interface CategoricalAnswer {
  readonly kind: "categorical";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence?: number;
}

export interface OrdinalAnswer {
  readonly kind: "ordinal";
  /** Expected index in the ordered rubric, within [0, levels.length - 1]. */
  readonly score: number;
  /** Index as string → probability. */
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence?: number;
}

export type JudgmentAnswer = BinaryAnswer | CategoricalAnswer | OrdinalAnswer;

export interface JudgmentRequest {
  readonly state: DecisionState;
  readonly questions: Readonly<Record<string, JudgmentQuestion>>;
}

export interface JudgmentResult {
  readonly answers: Readonly<Record<string, JudgmentAnswer>>;
  readonly provider: string;
  readonly model?: string;
}

export type JudgmentDomain = "tool-risk" | "routing" | "approval" | "output-safety";

/** Exact scope required before a machine approval may grant an action. */
export interface CalibrationProfile {
  readonly model: string;
  readonly domain: JudgmentDomain;
  readonly policyVersion: string;
  readonly trustedForAutoAllow: boolean;
  readonly evaluatedAt?: string;
  readonly metrics?: { readonly ece?: number; readonly brier?: number };
}

export interface JudgmentCapabilities {
  readonly binary: boolean;
  readonly categorical: boolean;
  readonly ordinal: boolean;
  readonly calibration?: readonly CalibrationProfile[];
}

export interface JudgmentProvider {
  readonly id: string;
  readonly model?: string;
  capabilities(): JudgmentCapabilities;
  evaluate(request: JudgmentRequest, signal?: AbortSignal): Promise<JudgmentResult>;
}
