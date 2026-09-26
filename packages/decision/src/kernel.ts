/** Host-neutral guardrail and judgment contracts. No Cordis or Schemastery imports. */
export { buildGuardrailRequest, decideGuardrail } from "./seams/guardrail.js";
export type { GuardrailVerdict } from "./seams/guardrail.js";
export {
  BUILTIN_RISK_INSTRUCTIONS,
  DEFAULT_GUARDRAIL_RISKS,
  GUARDRAIL_RISKS,
  defaultRiskDefinitions,
  evaluateGuardrailPolicy,
  guardrailPolicyVersion,
  resolveGuardrailRisks,
} from "./policy/risk.js";
export type {
  GuardrailRisk,
  RiskThresholds,
  RiskDefinition,
  RiskEntryInput,
  GuardrailRisksInput,
  ResolvedGuardrailRisks,
} from "./policy/risk.js";
export type { GuardrailSpec, GuardrailFailure, DecisionMode } from "./config.js";
export type {
  JudgmentAnswer,
  JudgmentProvider,
  JudgmentQuestion,
  JudgmentRequest,
  JudgmentResult,
} from "./judgment.js";
export { DecisionError, ProviderValidationError } from "./types.js";
export { validateAnswer } from "./validation.js";
export type {
  ChoiceAnswer,
  DecisionAdapter,
  DecisionAnswer,
  DecisionQuestion,
  DecisionRequest,
  NoulAnswer,
  ScoreAnswer,
} from "./types.js";
export { redactText, redactValue } from "./privacy/sanitizer.js";
export type { OutboundPrivacy, RedactionResult } from "./privacy/sanitizer.js";
export {
  JsonlTraceSink,
  NULL_TRACE_SINK,
  defaultAuditPath,
  traceErrorKind,
} from "./trace/trace.js";
export type { DecisionTraceRecord, TraceErrorKind, TraceSeam, TraceSink } from "./trace/trace.js";
