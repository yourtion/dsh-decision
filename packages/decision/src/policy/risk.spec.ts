import { describe, expect, it } from "vitest";
import {
  BUILTIN_RISK_INSTRUCTIONS,
  DEFAULT_GUARDRAIL_RISKS,
  GUARDRAIL_RISKS,
  defaultRiskDefinitions,
  evaluateGuardrailPolicy,
  guardrailPolicyVersion,
  resolveGuardrailRisks,
} from "./risk.js";

describe("resolveGuardrailRisks", () => {
  it("defaults to the six built-ins with default thresholds and wording", () => {
    const { risks, policyVersion } = resolveGuardrailRisks({});
    expect(risks.map((risk) => risk.key)).toEqual([...GUARDRAIL_RISKS]);
    expect(risks[0]).toEqual({
      key: "destructive",
      instructions: BUILTIN_RISK_INSTRUCTIONS.destructive,
      ...DEFAULT_GUARDRAIL_RISKS.destructive,
    });
    expect(policyVersion).toBe(guardrailPolicyVersion(risks));
  });

  it("drops disabled built-ins entirely", () => {
    const { risks } = resolveGuardrailRisks({
      risks: { scopeViolation: { enabled: false }, secretExposure: { enabled: false } },
    });
    expect(risks.map((risk) => risk.key)).not.toContain("scopeViolation");
    expect(risks.map((risk) => risk.key)).not.toContain("secretExposure");
  });

  it("overrides wording and thresholds per dimension", () => {
    const { risks } = resolveGuardrailRisks({
      risks: { destructive: { instructions: "custom?", reviewAt: 0.4, denyAt: 0.9 } },
    });
    const destructive = risks.find((risk) => risk.key === "destructive")!;
    expect(destructive.instructions).toBe("custom?");
    expect(destructive.reviewAt).toBe(0.4);
  });

  it("appends custom dimensions after the built-ins", () => {
    const { risks } = resolveGuardrailRisks({
      risks: { scopeViolation: { enabled: false } },
      customRisks: {
        financialExposure: {
          instructions: "Could this call move money?",
          reviewAt: 0.3,
          denyAt: 0.7,
        },
      },
    });
    expect(risks.map((risk) => risk.key)).toEqual([
      "destructive",
      "secretExposure",
      "privacyExposure",
      "externalSideEffect",
      "privilegeEscalation",
      "financialExposure",
    ]);
  });

  it("requires instructions and thresholds for custom dimensions", () => {
    expect(() =>
      resolveGuardrailRisks({ customRisks: { a: { reviewAt: 0.3, denyAt: 0.7 } as never } }),
    ).toThrow(/requires non-empty instructions/);
    expect(() =>
      resolveGuardrailRisks({
        customRisks: { a: { instructions: "x", reviewAt: 0.3 } as never },
      }),
    ).toThrow(/requires explicit reviewAt and denyAt/);
  });

  it("rejects custom keys colliding with built-in dimensions", () => {
    expect(() =>
      resolveGuardrailRisks({
        customRisks: { destructive: { instructions: "x", reviewAt: 0.1, denyAt: 0.2 } },
      }),
    ).toThrow(/collides with a built-in dimension/);
  });

  it("rejects inverted thresholds and empty effective sets", () => {
    expect(() =>
      resolveGuardrailRisks({ risks: { destructive: { reviewAt: 0.7, denyAt: 0.5 } } }),
    ).toThrow(/invalid guardrail thresholds for destructive/);
    expect(() =>
      resolveGuardrailRisks({
        risks: Object.fromEntries(GUARDRAIL_RISKS.map((risk) => [risk, { enabled: false }])),
      }),
    ).toThrow(/no enabled risk dimensions/);
  });

  it("keeps legacy threshold translation but refuses mixing with per-risk config", () => {
    const { risks } = resolveGuardrailRisks({ allowBelow: 0.2, denyAt: 0.9 });
    for (const risk of risks) {
      expect(risk.reviewAt).toBe(0.2);
      expect(risk.denyAt).toBe(0.9);
    }
    expect(() =>
      resolveGuardrailRisks({ allowBelow: 0.2, risks: { destructive: { reviewAt: 0.3 } } }),
    ).toThrow(/cannot be combined/);
    expect(() =>
      resolveGuardrailRisks({
        allowBelow: 0.2,
        customRisks: { a: { instructions: "x", reviewAt: 0.3, denyAt: 0.7 } },
      }),
    ).toThrow(/cannot be combined/);
  });
});

describe("guardrailPolicyVersion", () => {
  it("changes with thresholds and with wording", () => {
    const base = defaultRiskDefinitions();
    const reworded = base.map((risk) =>
      risk.key === "destructive" ? { ...risk, instructions: "different question?" } : risk,
    );
    const rethreshed = base.map((risk) =>
      risk.key === "destructive" ? { ...risk, reviewAt: 0.99 } : risk,
    );
    const version = guardrailPolicyVersion(base);
    expect(guardrailPolicyVersion(reworded)).not.toBe(version);
    expect(guardrailPolicyVersion(rethreshed)).not.toBe(version);
    expect(guardrailPolicyVersion(defaultRiskDefinitions())).toBe(version);
  });

  it("changes when a dimension is added or removed", () => {
    const base = defaultRiskDefinitions();
    const withoutScope = base.filter((risk) => risk.key !== "scopeViolation");
    expect(guardrailPolicyVersion(withoutScope)).not.toBe(guardrailPolicyVersion(base));
    expect(
      guardrailPolicyVersion([
        ...base,
        { key: "financialExposure", instructions: "money?", reviewAt: 0.3, denyAt: 0.7 },
      ]),
    ).not.toBe(guardrailPolicyVersion(base));
  });
});

describe("evaluateGuardrailPolicy with custom dimensions", () => {
  it("lets a custom dimension drive the verdict", () => {
    const { risks } = resolveGuardrailRisks({
      customRisks: { financialExposure: { instructions: "money?", reviewAt: 0.3, denyAt: 0.7 } },
    });
    // Quiet every other dimension so only the custom one can speak.
    const othersMuted = risks.map((risk) =>
      risk.key === "financialExposure" ? risk : { ...risk, reviewAt: 0.99, denyAt: 0.999 },
    );
    const judgments = Object.fromEntries(
      risks.map((risk) => [risk.key, risk.key === "destructive" ? 0.01 : 0]),
    );
    const quiet = evaluateGuardrailPolicy({ ...judgments, financialExposure: 0.1 }, othersMuted);
    expect(quiet.action).toBe("allow");
    const loud = evaluateGuardrailPolicy({ ...judgments, financialExposure: 0.8 }, othersMuted);
    expect(loud.action).toBe("deny");
    expect(loud.driver).toBe("financialExposure");
  });

  it("throws when a judgment is missing for an enabled dimension", () => {
    const { risks } = resolveGuardrailRisks({});
    expect(() => evaluateGuardrailPolicy({ destructive: 0.1 }, risks)).toThrow(
      /missing for "secretExposure"/,
    );
  });
});
