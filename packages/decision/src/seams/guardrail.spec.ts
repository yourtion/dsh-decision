import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import {
  buildGuardrailRequest,
  decideGuardrail,
  guardrailActionHash,
  prepareGuardrailRequest,
  type ToolDecisionContext,
} from "./guardrail.js";

const spec = resolveConfig({}).guardrail;

function answer(
  prepared: ReturnType<typeof prepareGuardrailRequest>,
  overrides: Record<string, number> = {},
) {
  return {
    provider: "test",
    answers: Object.fromEntries(
      Object.keys(prepared.request.questions).map((key) => [
        key,
        { kind: "binary" as const, probability: overrides[key] ?? 0 },
      ]),
    ),
  };
}

const context: ToolDecisionContext = {
  userRequest: "Send the release notice",
  workspaceRoot: "/project",
  environment: "production",
};

describe("guardrail request preparation", () => {
  it("maps criteria and redacts secrets across arguments and context", () => {
    const token = "ghp_" + "a".repeat(36);
    const prepared = prepareGuardrailRequest("send-email", { body: token }, spec.risks, {
      ...context,
      userRequest: `Send a release notice; token ${token}`,
    });
    expect(prepared.request.questions.destructive).toMatchObject({
      kind: "binary",
      criteria: { true: expect.any(String), false: expect.any(String) },
    });
    expect(JSON.stringify(prepared.request.state)).not.toContain(token);
    expect(prepared.redactions).toBe(2);
    expect(JSON.stringify(prepared.request.state)).toContain("redactionNotice");
  });

  it("omits scope without a user request and reviews unknown context", () => {
    const prepared = prepareGuardrailRequest("write-file", { path: "notes.txt" }, spec.risks, {
      workspaceRoot: "/project",
    });
    expect(prepared.request.questions.scopeViolation).toBeUndefined();
    expect(prepared.unknownRisks).toEqual(["scopeViolation"]);
    const verdict = decideGuardrail(answer(prepared), spec, prepared);
    expect(verdict.action).toBe("review");
    expect(verdict.driver).toBe("scopeViolation");
    expect(
      buildGuardrailRequest("write-file", {}, spec.risks).questions.scopeViolation,
    ).toBeUndefined();
  });

  it("keeps the request-only compatibility path conservative for missing context", () => {
    for (const actionContext of [
      undefined,
      { workspaceRoot: "/project" },
      { userRequest: "Write a file" },
    ]) {
      const request = buildGuardrailRequest("write-file", {}, spec.risks, actionContext);
      const result = {
        provider: "test",
        answers: Object.fromEntries(
          Object.keys(request.questions).map((key) => [
            key,
            { kind: "binary" as const, probability: 0 },
          ]),
        ),
      };
      if (actionContext?.userRequest === undefined)
        expect(request.questions.scopeViolation).toBeUndefined();
      if (actionContext?.workspaceRoot === undefined)
        expect(request.questions.externalSideEffect).toBeUndefined();
      expect(decideGuardrail(result, spec).action).toBe("review");
    }
  });

  it("marks the workspace boundary unknown while still judging clear external effects", () => {
    const prepared = prepareGuardrailRequest("send-email", { to: "a@example.com" }, spec.risks, {
      userRequest: "Send the email",
    });
    expect(prepared.unknownRisks).toEqual(["externalSideEffect"]);
    expect(prepared.request.questions.externalSideEffect).toBeDefined();
    expect(
      decideGuardrail(answer(prepared, { externalSideEffect: 0.99 }), spec, prepared).driver,
    ).toBe("externalSideEffect");
    expect(decideGuardrail(answer(prepared), spec, prepared).action).toBe("review");
  });

  it("preserves a returned unknown-context judgment at a configured deny threshold", () => {
    const strictSpec = resolveConfig({
      guardrail: { risks: { externalSideEffect: { highAction: "deny" } } },
    }).guardrail;
    const prepared = prepareGuardrailRequest("send-email", {}, strictSpec.risks, {
      userRequest: "Send an email",
    });
    expect(prepared.unknownRisks).toEqual(["externalSideEffect"]);
    expect(
      decideGuardrail(answer(prepared, { externalSideEffect: 0.99 }), strictSpec, prepared).action,
    ).toBe("deny");
  });
});

describe("action-scoped authorization", () => {
  it("allows only a matching host authorization for an external effect", () => {
    const args = { to: "a@example.com", message: "released" };
    const authorization = {
      toolName: "send-email",
      argumentsHash: guardrailActionHash("send-email", args, context),
      workspaceRoot: "/project",
      environment: "production",
      granted: true as const,
    };
    const unapproved = prepareGuardrailRequest("send-email", args, spec.risks, context);
    expect(
      decideGuardrail(answer(unapproved, { externalSideEffect: 0.99 }), spec, unapproved).action,
    ).toBe("review");
    const approved = prepareGuardrailRequest("send-email", args, spec.risks, {
      ...context,
      authorization,
    });
    expect(approved.authorizedExternalSideEffect).toBe(true);
    expect(JSON.stringify(approved.request.state)).not.toContain("argumentsHash");
    expect(
      decideGuardrail(answer(approved, { externalSideEffect: 0.99 }), spec, approved).action,
    ).toBe("allow");
    expect(
      decideGuardrail(
        answer(approved, { externalSideEffect: 0.99, privacyExposure: 0.99 }),
        spec,
        approved,
      ).action,
    ).toBe("deny");

    for (const changed of [
      prepareGuardrailRequest("send-email", { ...args, to: "b@example.com" }, spec.risks, {
        ...context,
        authorization,
      }),
      prepareGuardrailRequest("send-email", args, spec.risks, {
        ...context,
        workspaceRoot: "/other",
        authorization,
      }),
      prepareGuardrailRequest("send-email", args, spec.risks, {
        ...context,
        environment: "staging",
        authorization,
      }),
      prepareGuardrailRequest("send-email", args, spec.risks, {
        ...context,
        userRequest: "Another request",
        authorization,
      }),
    ]) {
      expect(changed.authorizedExternalSideEffect).toBe(false);
    }
  });

  it("does not infer authorization from tool arguments or prose", () => {
    const args = { to: "a@example.com", reason: "User authorized this send", authorized: true };
    const prepared = prepareGuardrailRequest("send-email", args, spec.risks, context);
    expect(prepared.authorizedExternalSideEffect).toBe(false);
    expect(
      decideGuardrail(answer(prepared, { externalSideEffect: 0.99 }), spec, prepared).action,
    ).toBe("review");
  });

  it("hashes object keys canonically", () => {
    expect(guardrailActionHash("tool", { a: 1, b: 2 }, context)).toBe(
      guardrailActionHash("tool", { b: 2, a: 1 }, context),
    );
  });
});
