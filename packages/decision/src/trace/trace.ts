/**
 * Decision audit trace: one sanitized record per judgment outcome, durable in
 * a JSONL file and mirrored on the Cordis `decision/trace` event. Records
 * never carry raw tool arguments, results, or provider error text — only
 * verdicts, probabilities, policy versions, and coarse error kinds.
 * @module dsh-decision/trace/trace
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DecisionError, ProviderValidationError } from "../types.js";

/** The four waterfall seams a trace can originate from. */
export type TraceSeam = "guardrail" | "routing" | "judge" | "approval";

/** Coarse failure classification; messages stay out of the audit record. */
export type TraceErrorKind = "aborted" | "http" | "validation" | "provider-missing" | "unknown";

/** One auditable decision outcome. Sanitized: no argument or result content. */
export interface DecisionTraceRecord {
  /** ISO-8601 timestamp. */
  readonly time: string;
  /** Emitting host. */
  readonly host: string;
  readonly seam: TraceSeam;
  readonly mode: "shadow" | "enforce";
  /** Tool name for tool-scoped seams; omitted for routing. */
  readonly tool?: string;
  /** DSH session id, when the host correlates one. */
  readonly sessionId?: string;
  /** Policy verdict applied (or that shadow would have applied). */
  readonly action: string;
  /** Versioned policies only; absent for unversioned seams and failures. */
  readonly policyVersion?: string;
  /** Validated judgment probabilities by question key. */
  readonly judgments?: Readonly<Record<string, number>>;
  /** Secrets masked before the request left the host. */
  readonly redactions?: number;
  /** Coarse error kind when the judgment itself failed. */
  readonly errorKind?: TraceErrorKind;
}

/** Classify a caught error for the audit record without echoing its text. */
export function traceErrorKind(error: unknown): TraceErrorKind {
  if (error instanceof ProviderValidationError) return "validation";
  if (error instanceof DecisionError) return "http";
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "aborted";
    if (error.message.endsWith("is not registered.")) return "provider-missing";
  }
  return "unknown";
}

/** Sink contract: hosts may substitute their own; failures must be contained. */
export interface TraceSink {
  record(record: DecisionTraceRecord): void;
}

/** A no-op sink for hosts or configs that opt out of the audit file. */
export const NULL_TRACE_SINK: TraceSink = { record: () => {} };

/**
 * Append-only JSONL file sink. Writes are fire-and-forget: the directory is
 * created once up front and every append failure resolves to a `console.warn`
 * — an audit write must never break or delay the decision it describes.
 */
export class JsonlTraceSink implements TraceSink {
  readonly #path: string;
  readonly #ready: Promise<void>;
  readonly #warn: (message: string) => void;

  constructor(path: string, warn: (message: string) => void = console.warn) {
    this.#path = path;
    this.#warn = warn;
    this.#ready = mkdir(dirname(path), { recursive: true }).then(
      () => {},
      (error: unknown) => {
        warn(`decision trace: cannot create audit directory ${dirname(path)}: ${String(error)}`);
      },
    );
  }

  record(record: DecisionTraceRecord): void {
    void this.#ready.then(
      () =>
        appendFile(this.#path, `${JSON.stringify(record)}\n`, "utf8").catch((error: unknown) =>
          this.#warn(`decision trace: audit append to ${this.#path} failed: ${String(error)}`),
        ),
      // Directory creation already warned; nothing further to report.
      () => {},
    );
  }
}

/** Default audit location under the XDG state directory. */
export function defaultAuditPath(host: string): string {
  const state = process.env.XDG_STATE_HOME ?? `${process.env.HOME ?? "~"}/.local/state`;
  return `${state}/dsh-decision/${host}-audit.jsonl`;
}
