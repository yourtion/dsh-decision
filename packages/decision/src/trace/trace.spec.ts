import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionError, ProviderValidationError } from "../types.js";
import { JsonlTraceSink, NULL_TRACE_SINK, traceErrorKind } from "./trace.js";

const dirs: string[] = [];

async function tempPath(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "decision-trace-"));
  dirs.push(dir);
  return join(dir, name);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("JsonlTraceSink", () => {
  it("appends sanitized records as JSONL", async () => {
    const path = await tempPath("nested/audit.jsonl");
    const sink = new JsonlTraceSink(path);
    sink.record({
      time: "2026-09-26T00:00:00.000Z",
      host: "dsh",
      seam: "guardrail",
      mode: "enforce",
      tool: "bash",
      sessionId: "session-1",
      action: "deny",
      policyVersion: "guardrail-v2.0.0:abcd",
      judgments: { destructive: 0.91 },
      redactions: 2,
    });
    sink.record({
      time: "2026-09-26T00:00:01.000Z",
      host: "dsh",
      seam: "routing",
      mode: "shadow",
      action: "fallback",
    });
    await vi.waitFor(() => readFile(path, "utf8"), { timeout: 5_000 });
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ tool: "bash", action: "deny" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ seam: "routing", action: "fallback" });
  });

  it("swallows write failures via the warn callback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decision-trace-"));
    dirs.push(dir);
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "");
    const warnings: string[] = [];
    const sink = new JsonlTraceSink(join(blocker, "audit.jsonl"), (m) => warnings.push(m));
    sink.record({ time: "x", host: "dsh", seam: "judge", mode: "shadow", action: "accept" });
    await vi.waitFor(() => expect(warnings.length).toBeGreaterThan(0), { timeout: 5_000 });
  });

  it("null sink is a silent no-op", () => {
    expect(() =>
      NULL_TRACE_SINK.record({
        time: "x",
        host: "dsh",
        seam: "judge",
        mode: "shadow",
        action: "accept",
      }),
    ).not.toThrow();
  });
});

describe("traceErrorKind", () => {
  it("classifies provider failures without echoing messages", () => {
    expect(traceErrorKind(new ProviderValidationError("secret-ish detail"))).toBe("validation");
    expect(traceErrorKind(new DecisionError("jev: HTTP 500 — echoed body", 500))).toBe("http");
    expect(traceErrorKind(Object.assign(new Error("aborted"), { name: "TimeoutError" }))).toBe(
      "aborted",
    );
    expect(traceErrorKind(new Error('provider "jev" is not registered.'))).toBe("provider-missing");
    expect(traceErrorKind(new Error("anything else"))).toBe("unknown");
  });
});
