export interface LineDiff {
  readonly added: number;
  readonly removed: number;
}

export const ZERO_DIFF: LineDiff = { added: 0, removed: 0 };

const lineCount = (s: unknown): number =>
  typeof s === "string" && s.length > 0 ? s.split("\n").length : 0;

const sumEdits = (edits: readonly unknown[]): LineDiff => {
  let added = 0;
  let removed = 0;
  for (const e of edits) {
    if (e !== null && typeof e === "object") {
      const rec = e as Record<string, unknown>;
      added += lineCount(rec["new_string"]);
      removed += lineCount(rec["old_string"]);
    }
  }
  return { added, removed };
};

export const lineDiffFromToolInput = (
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): LineDiff => {
  switch (toolName) {
    case "Write":
      return { added: lineCount(input["content"]), removed: 0 };
    case "Edit":
      return {
        added: lineCount(input["new_string"]),
        removed: lineCount(input["old_string"]),
      };
    case "MultiEdit":
      return Array.isArray(input["edits"]) ? sumEdits(input["edits"]) : ZERO_DIFF;
    case "NotebookEdit":
      return {
        added: lineCount(input["new_source"]),
        removed: lineCount(input["old_source"]),
      };
    default:
      return ZERO_DIFF;
  }
};
