import type { SessionDetail } from "./types";

export const buildChatMarkdown = (detail: SessionDetail): string => {
  const lines: string[] = [];
  const title = detail.title?.trim() || `Session ${detail.session_id.slice(0, 8)}`;
  lines.push(`# ${title}`);
  lines.push("");

  for (const ev of detail.events) {
    if (ev.event !== "UserPrompt" && ev.event !== "AssistantText") continue;
    if (ev.is_sidechain) continue;
    const text = typeof ev.tool_result === "string" ? ev.tool_result : "";
    if (text.trim().length === 0) continue;
    lines.push(ev.event === "UserPrompt" ? "## You" : "## Claude");
    lines.push("");
    lines.push(text);
    lines.push("");
  }

  return lines.join("\n").replace(/\n+$/, "\n");
};

export const chatExportFilename = (detail: SessionDetail): string => {
  const title = detail.title?.trim() || `session-${detail.session_id.slice(0, 8)}`;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "claude-session"}.md`;
};
