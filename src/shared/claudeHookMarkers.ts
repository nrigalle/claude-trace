export const shQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

export const markerCommand = (signalsDir: string, sessionId: string, kind: string): string => {
  const dir = signalsDir.replace(/\\/g, "/");
  return `mkdir -p ${shQuote(dir)} && : > ${shQuote(`${dir}/${sessionId}.${kind}`)}`;
};

export interface HookEntry {
  readonly matcher?: string;
  readonly hooks: ReadonlyArray<{ readonly type: "command"; readonly command: string }>;
}

export interface ClaudeHookSettings {
  readonly hooks: Record<string, readonly HookEntry[]>;
}
