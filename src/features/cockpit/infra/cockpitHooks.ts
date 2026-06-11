import { markerCommand, shQuote, type ClaudeHookSettings, type HookEntry } from "../../../shared/claudeHookMarkers";

export { shQuote };
export type { HookEntry };

export type CockpitHookSettings = ClaudeHookSettings;

export const buildCockpitHookSettings = (
  sessionId: string,
  signalsDir: string,
): CockpitHookSettings => {
  const marker = (kind: string): string => markerCommand(signalsDir, sessionId, kind);
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: marker("start") }] }],
      Stop: [{ hooks: [{ type: "command", command: marker("stop") }] }],
      Notification: [{ matcher: "permission_prompt", hooks: [{ type: "command", command: marker("notify") }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: marker("active") }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: marker("active") }] }],
    },
  };
};
