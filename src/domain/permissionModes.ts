export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "auto"
  | "dontAsk"
  | "bypassPermissions";

export interface PermissionModeOption {
  readonly mode: PermissionMode;
  readonly label: string;
  readonly oneLine: string;
}

export const PERMISSION_MODES: readonly PermissionModeOption[] = [
  {
    mode: "default",
    label: "Ask before edits",
    oneLine: "Reads auto-approved; prompt before every edit and command. Safest.",
  },
  {
    mode: "acceptEdits",
    label: "Accept edits automatically",
    oneLine: "Auto-approve file edits and common filesystem commands (mkdir, mv, cp…).",
  },
  {
    mode: "plan",
    label: "Plan mode",
    oneLine: "Claude researches and proposes a plan but does not edit source.",
  },
  {
    mode: "auto",
    label: "Auto mode",
    oneLine: "Run without prompts; a classifier vets each action. Requires Max/Team/Enterprise/API on a supported model.",
  },
  {
    mode: "dontAsk",
    label: "Don't ask (pre-approved tools only)",
    oneLine: "Only tools in your allow-list run; everything else is denied. For CI and locked-down scripts.",
  },
  {
    mode: "bypassPermissions",
    label: "Bypass permissions — dangerous",
    oneLine: "Skip ALL permission checks. Use only in isolated containers or VMs.",
  },
];

export const buildClaudeCommand = (mode: PermissionMode): string => {
  if (mode === "default") return "claude";
  return `claude --permission-mode ${mode}`;
};
