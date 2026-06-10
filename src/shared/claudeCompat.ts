export const TESTED_CLAUDE_MAJOR = 2;

export const parseClaudeVersion = (output: string): string | null => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return m ? m[0]! : null;
};

export type ClaudeCompatVerdict =
  | { readonly kind: "tested"; readonly version: string }
  | { readonly kind: "untested"; readonly version: string }
  | { readonly kind: "missing" };

export const claudeCompatVerdict = (probeOutput: string | null): ClaudeCompatVerdict => {
  if (probeOutput === null) return { kind: "missing" };
  const version = parseClaudeVersion(probeOutput);
  if (version === null) return { kind: "missing" };
  const major = Number(version.split(".")[0]);
  return major === TESTED_CLAUDE_MAJOR ? { kind: "tested", version } : { kind: "untested", version };
};
