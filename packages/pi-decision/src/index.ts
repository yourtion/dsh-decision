/** Pi extension entry point. The Pi import is type-only and erased at runtime. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { JsonlTraceSink, NULL_TRACE_SINK } from "@techs/dsh-decision/kernel";
import { createPiProvider } from "./provider.js";
import { createToolCallHandler } from "./handler.js";
import { toolDecisionContext } from "./context.js";
import { resolvePiGuardrailSpec } from "./spec.js";

const log = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

export default function piDecision(pi: ExtensionAPI): void {
  const provider = createPiProvider(process.env);
  const spec = resolvePiGuardrailSpec(process.env);
  if (spec.mode === "enforce") {
    log(
      "pi-decision: enforce is experimental — current prompts and context have not been calibrated; evaluate them on your workload before trusting verdicts.",
    );
  }
  const trace = spec.audit.enabled ? new JsonlTraceSink(spec.audit.path, log) : NULL_TRACE_SINK;
  const handler = createToolCallHandler(provider, spec, { info: log, warn: log }, trace);
  pi.on("tool_call", async (event, ctx) =>
    handler(
      { toolName: event.toolName, input: event.input, context: toolDecisionContext(ctx) },
      ctx.signal,
    ),
  );
}
