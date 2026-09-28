import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ToolDecisionContext } from "@techs/dsh-decision/kernel";

/** Use the active branch; session switches and forks cannot retain another task. */
export function toolDecisionContext(
  ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
): ToolDecisionContext {
  const messages = ctx.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message" && entry.message.role === "user")
    .slice(-4);
  const text = messages
    .flatMap((entry) => {
      if (entry.type !== "message" || entry.message.role !== "user") return [];
      const content = entry.message.content;
      return typeof content === "string"
        ? [content]
        : content.flatMap((block) => (block.type === "text" ? [block.text] : []));
    })
    .join("\n\n");
  return {
    workspaceRoot: ctx.cwd,
    ...(text.trim() !== "" && text.length <= 8_000 ? { userRequest: text } : {}),
  };
}
