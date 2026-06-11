import { markerCommand, type ClaudeHookSettings } from "../../../shared/claudeHookMarkers";

export const buildCockpitHookSettings = (
  sessionId: string,
  signalsDir: string,
): ClaudeHookSettings => {
  const marker = (kind: string): string => markerCommand(signalsDir, sessionId, kind);
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: marker("start") }] }],
      Stop: [{ hooks: [{ type: "command", command: marker("stop") }] }],
      Notification: [{ matcher: "permission_prompt|idle_prompt|elicitation_dialog", hooks: [{ type: "command", command: marker("notify") }] }],
      Elicitation: [{ hooks: [{ type: "command", command: marker("notify") }] }],
      ElicitationResult: [{ hooks: [{ type: "command", command: marker("active") }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: marker("active") }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: marker("active") }] }],
    },
  };
};
