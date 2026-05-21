export type ModelChoice =
  | "default"
  | "claude-opus-4-7"
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5";

export interface ModelOption {
  readonly id: ModelChoice;
  readonly label: string;
  readonly oneLine: string;
}

export const MODEL_OPTIONS: readonly ModelOption[] = [
  {
    id: "default",
    label: "Use Claude Code default",
    oneLine: "Whatever the CLI is configured to use (no --model flag).",
  },
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    oneLine: "Most capable. Best for complex reasoning and agentic coding. $5/$25 per MTok.",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    oneLine: "Balanced speed and intelligence. Recommended default. $3/$15 per MTok.",
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    oneLine: "Fastest, lowest cost. Near-frontier intelligence. $1/$5 per MTok.",
  },
];
