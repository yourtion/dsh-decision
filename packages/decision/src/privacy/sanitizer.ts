/**
 * Outbound sanitizer: masks credential-shaped content before a judgment
 * request leaves the host. Best-effort by design — an unmatched secret still
 * travels, which is why the outbound policy is configurable and the audit
 * trace records the redaction count.
 * @module dsh-decision/privacy/sanitizer
 */

/** `redact` masks detected secrets; `raw` restores the v1 send-as-is stance. */
export type OutboundPrivacy = "redact" | "raw";

export interface RedactionResult<T> {
  readonly value: T;
  readonly count: number;
}

/** Credential shapes with low false-positive structure (known prefixes). */
const SECRET_PATTERNS: readonly { kind: string; re: RegExp }[] = [
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { kind: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,255}\b/g },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "openai-key", re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: "bearer", re: /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  {
    kind: "pem-block",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
];

/** Object keys whose string values are credentials by convention. */
const SENSITIVE_KEY =
  /(?:pass(?:word)?|secret|token|api[_-]?key|apikey|credential|auth|private[_-]?key)/i;

/** Minimum length before a sensitive-keyed value is treated as a secret. */
const SENSITIVE_VALUE_MIN = 8;

/** Mask substituted for detected secrets; the kind stays for auditability. */
function mask(kind: string): string {
  return `[REDACTED:${kind}]`;
}

/** Mask credential-shaped substrings in one string. */
export function redactText(text: string): RedactionResult<string> {
  let count = 0;
  let value = text;
  for (const { kind, re } of SECRET_PATTERNS) {
    value = value.replace(re, () => {
      count += 1;
      return mask(kind);
    });
  }
  return { value, count };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactPrimitive(value: unknown, key: string | undefined): RedactionResult<unknown> {
  if (typeof value !== "string") return { value, count: 0 };
  if (key !== undefined && SENSITIVE_KEY.test(key) && value.length >= SENSITIVE_VALUE_MIN) {
    return { value: mask("key"), count: 1 };
  }
  return redactText(value);
}

/**
 * Deep-copy a lossless-JSON value with detected secrets masked. The input is
 * never mutated (tool arguments arrive deep-frozen); the walk rebuilds every
 * plain object and array it crosses.
 */
export function redactValue<T>(value: T): RedactionResult<T> {
  let count = 0;
  const walk = (input: unknown, key: string | undefined): unknown => {
    if (Array.isArray(input)) return input.map((item) => walk(item, undefined));
    if (isPlainObject(input)) {
      const out: Record<string, unknown> = {};
      for (const [name, item] of Object.entries(input)) out[name] = walk(item, name);
      return out;
    }
    const { value: masked, count: hits } = redactPrimitive(input, key);
    count += hits;
    return masked;
  };
  return { value: walk(value, undefined) as T, count };
}
