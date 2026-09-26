/** Pi extension entry point. The Pi import is type-only and erased at runtime. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createJevProvider } from "@techs/dsh-decision-jev/provider";
import { createToolCallHandler } from "./handler.js";
import { resolvePiGuardrailSpec, resolvePiJevSpec } from "./spec.js";

const log = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

export default function piDecision(pi: ExtensionAPI): void {
  const jev = resolvePiJevSpec(process.env);
  const spec = resolvePiGuardrailSpec(process.env);
  const handler = createToolCallHandler(createJevProvider(jev), spec, { info: log, warn: log });
  pi.on("tool_call", async (event, ctx) =>
    handler({ toolName: event.toolName, input: event.input }, ctx.signal),
  );
}
