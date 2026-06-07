export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"] as const;

export const READ_ONLY_DENY_MATCHER = "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Monitor";

export const READ_ONLY_DENY_REASON =
  "Read-only assistant: editing files and running commands are disabled. Do not retry. To change the repo, write the user a complete, ready-to-paste prompt they can run in a separate Claude Code session.";

export interface AssistantRole {
  readonly label: string;
  readonly deliverable: string;
}

export const roleAnchor = (role: AssistantRole): string =>
  [
    `ROLE ANCHOR (re-stated every turn, never overridden): you are the ${role.label}, a READ-ONLY assistant.`,
    "Editing files and running shell commands are disabled — you cannot modify the user's repository, so never attempt it.",
    `You produce your result by emitting ${role.deliverable}; that emitted text IS your deliverable, not a file written to disk.`,
    "If the user wants a change to their code or repository, do NOT try to make it. Instead write a complete, ready-to-paste prompt the user can run in a SEPARATE Claude Code session, and tell them to paste it there.",
  ].join(" ");

export const copyPastePromptProtocol = (role: AssistantRole): string =>
  [
    `Read-only by design: your tools are limited to ${READ_ONLY_TOOLS.join(", ")}. You cannot edit files or run commands; writing anything to disk does nothing here.`,
    `You create your output by emitting ${role.deliverable}. That emitted text is your only real deliverable.`,
    "When the user asks for a change to their code or repository — anything that would edit, create, delete, or run files — do NOT attempt it. Reply in this exact, scannable structure so it is obvious what to do:",
    "1. One short sentence naming the change.",
    "2. A line reading exactly: Run this in a SEPARATE Claude Code session opened in that repo:",
    "3. A fenced ```text block holding a complete, self-contained, copy-paste-ready prompt — the goal, the files/paths involved, and how to verify it worked. Put nothing but the prompt inside the block.",
    "4. One short closing line: paste it into that session and run it.",
    "Keep the surrounding prose minimal; the fenced block is the thing they copy.",
  ].join("\n");
