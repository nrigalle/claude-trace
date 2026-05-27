export type FileEditAction = "write" | "edit" | "multiedit";

export type FileChange =
  | { readonly kind: "write"; readonly ts: number; readonly content: string }
  | { readonly kind: "edit"; readonly ts: number; readonly oldString: string; readonly newString: string };

export interface RawFileEdit {
  readonly ts: number;
  readonly filePath: string;
  readonly added: number;
  readonly removed: number;
  readonly action: FileEditAction;
  readonly changes: readonly FileChange[];
}

export interface FileEditSummary {
  readonly filePath: string;
  readonly fileName: string;
  readonly latestTs: number;
  readonly count: number;
  readonly added: number;
  readonly removed: number;
  readonly dominantAction: FileEditAction;
  readonly changes: readonly FileChange[];
}

export type FilePathFilter = (filePath: string) => boolean;

export const fileEditActionForTool = (toolName: string): FileEditAction | null => {
  if (toolName === "Write") return "write";
  if (toolName === "Edit") return "edit";
  if (toolName === "MultiEdit") return "multiedit";
  return null;
};

export const aggregateByFile = (
  raw: readonly RawFileEdit[],
  predicate: FilePathFilter = () => true,
): FileEditSummary[] => {
  type Acc = {
    filePath: string;
    latestTs: number;
    count: number;
    added: number;
    removed: number;
    hasWrite: boolean;
    hasMultiedit: boolean;
    changes: FileChange[];
  };

  const grouped = new Map<string, Acc>();
  for (const edit of raw) {
    if (!predicate(edit.filePath)) continue;
    const existing = grouped.get(edit.filePath);
    if (existing) {
      existing.count += 1;
      existing.added += edit.added;
      existing.removed += edit.removed;
      if (edit.ts > existing.latestTs) existing.latestTs = edit.ts;
      if (edit.action === "write") existing.hasWrite = true;
      if (edit.action === "multiedit") existing.hasMultiedit = true;
      for (const change of edit.changes) existing.changes.push(change);
    } else {
      grouped.set(edit.filePath, {
        filePath: edit.filePath,
        latestTs: edit.ts,
        count: 1,
        added: edit.added,
        removed: edit.removed,
        hasWrite: edit.action === "write",
        hasMultiedit: edit.action === "multiedit",
        changes: [...edit.changes],
      });
    }
  }

  const result: FileEditSummary[] = [];
  for (const acc of grouped.values()) {
    const dominantAction: FileEditAction = acc.hasWrite
      ? "write"
      : acc.hasMultiedit
        ? "multiedit"
        : "edit";
    acc.changes.sort((a, b) => a.ts - b.ts);
    result.push({
      filePath: acc.filePath,
      fileName: baseName(acc.filePath),
      latestTs: acc.latestTs,
      count: acc.count,
      added: acc.added,
      removed: acc.removed,
      dominantAction,
      changes: acc.changes,
    });
  }
  result.sort((a, b) => b.latestTs - a.latestTs);
  return result;
};

const baseName = (filePath: string): string => {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? filePath : filePath.slice(idx + 1);
};
