import type { EffortChoice, ModelChoice } from "./models";

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
    label: "Bypass permissions (dangerous)",
    oneLine: "Skip ALL permission checks. Use only in isolated containers or VMs.",
  },
];

export interface ClaudeCommandOptions {
  readonly mode: PermissionMode;
  readonly resumeId?: string;
  readonly sessionId?: string;
  readonly model?: ModelChoice;
  readonly effort?: EffortChoice;
  readonly name?: string | null;
  readonly initialPrompt?: string | null;
  readonly settingsPath?: string | null;
}

export type ShellQuote = "posix" | "powershell";

const quotePosix = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const quotePowerShell = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const quoterFor = (shell: ShellQuote): ((value: string) => string) =>
  shell === "powershell" ? quotePowerShell : quotePosix;
export const quoteShellArg = (value: string, shell: ShellQuote = "posix"): string =>
  quoterFor(shell)(value);

export const buildClaudeCommand = (
  opts: ClaudeCommandOptions,
  shell: ShellQuote = "posix",
): string => {
  const quote = (value: string): string => quoteShellArg(value, shell);
  const parts = ["claude"];
  if (opts.resumeId) parts.push("--resume", opts.resumeId);
  if (opts.sessionId) parts.push("--session-id", opts.sessionId);
  if (opts.model && opts.model !== "default") parts.push("--model", quote(opts.model));
  if (opts.effort && opts.effort !== "default") {
    parts.push("--effort", opts.effort);
  }
  if (opts.mode !== "default") parts.push("--permission-mode", opts.mode);
  const settingsPath = opts.settingsPath?.trim();
  if (settingsPath) parts.push("--settings", quote(settingsPath));
  const name = opts.name?.trim();
  if (name) parts.push("--name", quote(name));
  const prompt = opts.initialPrompt?.trim();
  if (prompt) parts.push(quote(prompt));
  return parts.join(" ");
};
