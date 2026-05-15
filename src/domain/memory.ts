const MEMORY_SEGMENT_RE = /\/\.claude\/projects\/[^/]+\/memory\//;
const INDEX_FILE_NAME = "MEMORY.md";

export const isAutoMemoryFile = (filePath: string): boolean => {
  if (!MEMORY_SEGMENT_RE.test(filePath)) return false;
  if (!filePath.endsWith(".md")) return false;
  return baseName(filePath) !== INDEX_FILE_NAME;
};

const baseName = (filePath: string): string => {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? filePath : filePath.slice(idx + 1);
};
