import { describe, expect, it } from "vitest";
import { toolDecisionContext } from "./context.js";

function contextFor(branch: unknown[]) {
  return toolDecisionContext({
    cwd: "/project",
    sessionManager: { getBranch: () => branch },
  } as never);
}

const user = (content: unknown) => ({ type: "message", message: { role: "user", content } });
const assistant = (content: unknown) => ({
  type: "message",
  message: { role: "assistant", content },
});

describe("toolDecisionContext", () => {
  it("uses only user text from the active branch and ignores non-text content", () => {
    const activeBranch = [
      user("Inspect the current project"),
      assistant("I will inspect it"),
      user([
        { type: "text", text: "Then update the README" },
        { type: "image", data: "ignored" },
      ]),
    ];
    const result = contextFor(activeBranch);
    expect(result).toEqual({
      workspaceRoot: "/project",
      userRequest: "Inspect the current project\n\nThen update the README",
    });
  });

  it("does not carry a request from another branch or from the old session history", () => {
    const oldSessionBranch = [user("Delete the production database")];
    const activeFork = [assistant("Continuing in a new branch")];
    expect(contextFor(oldSessionBranch).userRequest).toBe("Delete the production database");
    expect(contextFor(activeFork)).toEqual({ workspaceRoot: "/project" });
  });

  it("limits context to the latest four user messages and omits oversized request text", () => {
    const branch = [user("old request"), ...[1, 2, 3, 4, 5].map((n) => user(`request ${n}`))];
    expect(contextFor(branch).userRequest).toBe("request 2\n\nrequest 3\n\nrequest 4\n\nrequest 5");
    expect(contextFor([user("x".repeat(8_001))])).toEqual({ workspaceRoot: "/project" });
  });
});
