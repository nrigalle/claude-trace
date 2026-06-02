export type ModelChoice =
  | "default"
  | "claude-opus-4-8"
  | "claude-opus-4-7"
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5";

export type EffortChoice = "default" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelOption {
  readonly id: ModelChoice;
  readonly label: string;
  readonly oneLine: string;
  readonly effortLevels: readonly EffortChoice[];
}

export const DEFAULT_MODEL_CHOICE: ModelChoice = "claude-opus-4-8";

export const MODEL_CHOICES: readonly ModelChoice[] = [
  "default",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

const BASE_EFFORT_LEVELS: readonly EffortChoice[] = ["default", "low", "medium", "high", "max"];
const OPUS_EFFORT_LEVELS: readonly EffortChoice[] = ["default", "low", "medium", "high", "xhigh", "max"];

export const MODEL_OPTIONS: readonly ModelOption[] = [
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    oneLine: "Default. 1M context, adaptive thinking, best for hard coding and agents. $5/$25 per MTok.",
    effortLevels: OPUS_EFFORT_LEVELS,
  },
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    oneLine: "1M context. Previous Opus with strong reasoning and agentic coding. $5/$25 per MTok.",
    effortLevels: OPUS_EFFORT_LEVELS,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    oneLine: "1M context. Balanced speed and intelligence. $3/$15 per MTok.",
    effortLevels: BASE_EFFORT_LEVELS,
  },
];

export function normalizeModelChoice(model: ModelChoice): ModelChoice {
  if (model === "default" || model === "claude-haiku-4-5") return DEFAULT_MODEL_CHOICE;
  return model;
}

export interface EffortOption {
  readonly id: EffortChoice;
  readonly label: string;
  readonly oneLine: string;
}

export const EFFORT_OPTIONS: readonly EffortOption[] = [
  {
    id: "default",
    label: "Default",
    oneLine: "Use the model's default effort (high on 4.8 and Sonnet 4.6, xhigh on 4.7).",
  },
  {
    id: "low",
    label: "Low",
    oneLine: "Fast and cheap. Minimal thinking. For quick scoped tweaks.",
  },
  {
    id: "medium",
    label: "Medium",
    oneLine: "Balanced thinking budget for cost-sensitive work.",
  },
  {
    id: "high",
    label: "High",
    oneLine: "Default on Opus 4.8 and Sonnet 4.6. Balances tokens and intelligence.",
  },
  {
    id: "xhigh",
    label: "Extra high",
    oneLine: "Opus only. Deeper reasoning at higher token spend. Default on Opus 4.7.",
  },
  {
    id: "max",
    label: "Max",
    oneLine: "Deepest reasoning, session-only. Can over-think. Test before adopting.",
  },
];

export function modelEffortLevels(model: ModelChoice): readonly EffortChoice[] {
  return MODEL_OPTIONS.find((o) => o.id === model)?.effortLevels ?? [];
}

export function modelSupportsEffort(model: ModelChoice): boolean {
  return modelEffortLevels(model).length > 0;
}

export function modelDefaultEffort(model: ModelChoice): EffortChoice {
  if (model === "claude-opus-4-7") return "xhigh";
  return "default";
}
