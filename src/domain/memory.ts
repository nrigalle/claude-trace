export type MemoryAction = "write" | "edit" | "multiedit";

export interface RawMemoryEdit {
  readonly ts: number;
  readonly filePath: string;
  readonly added: number;
  readonly removed: number;
  readonly action: MemoryAction;
}

export interface MemoryEdit {
  readonly filePath: string;
  readonly fileName: string;
  readonly latestTs: number;
  readonly count: number;
  readonly added: number;
  readonly removed: number;
  readonly dominantAction: MemoryAction;
}

const MEMORY_SEGMENT_RE = /\/\.claude\/projects\/[^/]+\/memory\//;
const INDEX_FILE_NAME = "MEMORY.md";

export const isAutoMemoryFile = (filePath: string): boolean => {
  if (!MEMORY_SEGMENT_RE.test(filePath)) return false;
  if (!filePath.endsWith(".md")) return false;
  return baseName(filePath) !== INDEX_FILE_NAME;
};

export const memoryActionForTool = (toolName: string): MemoryAction | null => {
  if (toolName === "Write") return "write";
  if (toolName === "Edit") return "edit";
  if (toolName === "MultiEdit") return "multiedit";
  return null;
};

export const aggregateMemoryEdits = (raw: readonly RawMemoryEdit[]): MemoryEdit[] => {
  type Acc = {
    filePath: string;
    latestTs: number;
    count: number;
    added: number;
    removed: number;
    hasWrite: boolean;
    hasMultiedit: boolean;
  };

  const grouped = new Map<string, Acc>();
  for (const edit of raw) {
    const existing = grouped.get(edit.filePath);
    if (existing) {
      existing.count += 1;
      existing.added += edit.added;
      existing.removed += edit.removed;
      if (edit.ts > existing.latestTs) existing.latestTs = edit.ts;
      if (edit.action === "write") existing.hasWrite = true;
      if (edit.action === "multiedit") existing.hasMultiedit = true;
    } else {
      grouped.set(edit.filePath, {
        filePath: edit.filePath,
        latestTs: edit.ts,
        count: 1,
        added: edit.added,
        removed: edit.removed,
        hasWrite: edit.action === "write",
        hasMultiedit: edit.action === "multiedit",
      });
    }
  }

  const result: MemoryEdit[] = [];
  for (const acc of grouped.values()) {
    const dominantAction: MemoryAction = acc.hasWrite
      ? "write"
      : acc.hasMultiedit
        ? "multiedit"
        : "edit";
    result.push({
      filePath: acc.filePath,
      fileName: baseName(acc.filePath),
      latestTs: acc.latestTs,
      count: acc.count,
      added: acc.added,
      removed: acc.removed,
      dominantAction,
    });
  }
  result.sort((a, b) => b.latestTs - a.latestTs);
  return result;
};

const baseName = (filePath: string): string => {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? filePath : filePath.slice(idx + 1);
};
