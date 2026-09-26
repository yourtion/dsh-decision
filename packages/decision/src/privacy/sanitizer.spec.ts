import { describe, expect, it } from "vitest";
import { redactText, redactValue } from "./sanitizer.js";

describe("redactText", () => {
  it("masks a GitHub token", () => {
    const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
    const { value, count } = redactText(`run with ${token} please`);
    expect(value).toBe("run with [REDACTED:github-token] please");
    expect(count).toBe(1);
  });

  it("masks JWTs, bearer headers, AWS keys, and PEM blocks", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N65I";
    const aws = "AKIAIOSFODNN7EXAMPLE";
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----";
    const { value, count } = redactText(
      `jwt=${jwt} aws=${aws}\nbearer Bearer abcdef1234567890abcdef\n${pem}`,
    );
    expect(value).not.toContain(jwt);
    expect(value).not.toContain(aws);
    expect(value).not.toContain("MIIEow");
    expect(value).toContain("[REDACTED:jwt]");
    expect(value).toContain("[REDACTED:aws-access-key]");
    expect(value).toContain("[REDACTED:bearer]");
    expect(value).toContain("[REDACTED:pem-block]");
    expect(count).toBe(4);
  });

  it("leaves ordinary text untouched", () => {
    const text = "list files in ./src and count lines with grep -c TODO";
    expect(redactText(text)).toEqual({ value: text, count: 0 });
  });
});

describe("redactValue", () => {
  it("masks sensitive-keyed string values in nested objects", () => {
    const input = {
      path: "README.md",
      headers: { Authorization: "Bearer secret-secret-secret", X_Custom: "no" },
      nested: [{ api_key: "abcdefgh12345678", note: "plain" }],
    };
    const { value, count } = redactValue(input);
    expect(value.nested[0]!.api_key).toBe("[REDACTED:key]");
    expect(value.headers.Authorization).toBe("[REDACTED:key]");
    expect(value.path).toBe("README.md");
    expect(value.nested[0]!.note).toBe("plain");
    expect(count).toBe(2);
  });

  it("never mutates the (possibly frozen) input", () => {
    const input = Object.freeze({ token: "very-secret-token-1" });
    redactValue(input);
    expect(input.token).toBe("very-secret-token-1");
  });

  it("redacts secrets embedded anywhere in string values", () => {
    const { value, count } = redactValue({
      command: "curl -H x-gh: ghp_0123456789abcdefghijklmnopqrstuvwxyzAB",
    });
    expect(value.command).toContain("[REDACTED:github-token]");
    expect(count).toBe(1);
  });

  it("passes primitives and empty structures through", () => {
    expect(redactValue(42)).toEqual({ value: 42, count: 0 });
    expect(redactValue(null)).toEqual({ value: null, count: 0 });
    expect(redactValue([]).value).toEqual([]);
  });
});
