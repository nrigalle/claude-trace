import type { FileChange, FileEditSummary } from "./fileEdits";

export const buildUnifiedDiff = (file: FileEditSummary): string => {
  const lines: string[] = [];
  lines.push(`--- a/${file.filePath}`);
  lines.push(`+++ b/${file.filePath}`);
  lines.push("");

  for (let i = 0; i < file.changes.length; i++) {
    const change = file.changes[i]!;
    lines.push(hunkHeader(change, i, file.changes.length));
    appendChangeBody(lines, change);
    lines.push("");
  }

  if (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
};

const hunkHeader = (change: FileChange, index: number, total: number): string => {
  const time = formatTime(change.ts);
  const action = change.kind === "write" ? "Write" : "Edit";
  const position = total > 1 ? ` · change ${index + 1} of ${total}` : "";
  return `@@ ${action} at ${time}${position} @@`;
};

const appendChangeBody = (lines: string[], change: FileChange): void => {
  if (change.kind === "write") {
    for (const line of splitLines(change.content)) lines.push(`+${line}`);
    return;
  }
  for (const line of splitLines(change.oldString)) lines.push(`-${line}`);
  for (const line of splitLines(change.newString)) lines.push(`+${line}`);
};

const splitLines = (raw: string): string[] => {
  if (!raw) return [];
  const trimmed = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  return trimmed.split("\n");
};

const formatTime = (ts: number): string => {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
};
