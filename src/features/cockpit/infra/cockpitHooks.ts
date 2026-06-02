const shQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

const markerCommand = (signalsDir: string, sessionId: string, kind: string): string => {
  const dir = signalsDir.replace(/\\/g, "/");
  return `mkdir -p ${shQuote(dir)} && : > ${shQuote(`${dir}/${sessionId}.${kind}`)}`;
};

export interface HookEntry {
  readonly matcher?: string;
  readonly hooks: ReadonlyArray<{ readonly type: "command"; readonly command: string }>;
}

export interface CockpitHookSettings {
  readonly hooks: Record<string, readonly HookEntry[]>;
}

export const buildCockpitHookSettings = (
  sessionId: string,
  signalsDir: string,
): CockpitHookSettings => {
  const marker = (kind: string): string => markerCommand(signalsDir, sessionId, kind);
  return {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: marker("stop") }] }],
      Notification: [{ matcher: "permission_prompt", hooks: [{ type: "command", command: marker("notify") }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: marker("active") }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: marker("active") }] }],
    },
  };
};
