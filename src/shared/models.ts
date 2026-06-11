export type ModelChoice =
  | "default"
  | "claude-fable-5"
  | "claude-fable-5[1m]"
  | "claude-opus-4-8"
  | "claude-opus-4-8[1m]"
  | "claude-opus-4-7"
  | "claude-opus-4-7[1m]"
  | "claude-sonnet-4-6"
  | "claude-sonnet-4-6[1m]"
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
  "claude-fable-5",
  "claude-fable-5[1m]",
  "claude-opus-4-8",
  "claude-opus-4-8[1m]",
  "claude-opus-4-7",
  "claude-opus-4-7[1m]",
  "claude-sonnet-4-6",
  "claude-sonnet-4-6[1m]",
  "claude-haiku-4-5",
];

const BASE_EFFORT_LEVELS: readonly EffortChoice[] = ["default", "low", "medium", "high", "max"];
const OPUS_EFFORT_LEVELS: readonly EffortChoice[] = ["default", "low", "medium", "high", "xhigh", "max"];

const baseModelId = (model: ModelChoice): ModelChoice =>
  model.endsWith("[1m]") ? (model.slice(0, -"[1m]".length) as ModelChoice) : model;

export const MODEL_OPTIONS: readonly ModelOption[] = [
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    oneLine: "Default. 200k context, adaptive thinking, best for hard coding and agents. $5/$25 per MTok.",
    effortLevels: OPUS_EFFORT_LEVELS,
  },
  {
    id: "claude-opus-4-8[1m]",
    label: "Opus 4.8 (1m)",
    oneLine: "Opus 4.8 with the 1M token context window for very long sessions.",
    effortLevels: OPUS_EFFORT_LEVELS,
  },
  {
    id: "claude-fable-5",
    label: "Fable 5",
    oneLine: "Frontier preview. 200k context. Deepest reasoning available today.",
    effortLevels: OPUS_EFFORT_LEVELS,
  },
  {
    id: "claude-fable-5[1m]",
    label: "Fable 5 (1m)",
    oneLine: "Fable 5 with the 1M token context window for very long sessions.",
    effortLevels: OPUS_EFFORT_LEVELS,
  },
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    oneLine: "200k context. Previous Opus with strong reasoning and agentic coding. $5/$25 per MTok.",
    effortLevels: OPUS_EFFORT_LEVELS,
  },
  {
    id: "claude-opus-4-7[1m]",
    label: "Opus 4.7 (1m)",
    oneLine: "Opus 4.7 with the 1M token context window for very long sessions.",
    effortLevels: OPUS_EFFORT_LEVELS,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    oneLine: "200k context. Balanced speed and intelligence. $3/$15 per MTok.",
    effortLevels: BASE_EFFORT_LEVELS,
  },
  {
    id: "claude-sonnet-4-6[1m]",
    label: "Sonnet 4.6 (1m)",
    oneLine: "Sonnet 4.6 with the 1M token context window for very long sessions.",
    effortLevels: BASE_EFFORT_LEVELS,
  },
];

export function normalizeModelChoice(model: ModelChoice): ModelChoice {
  if (model === "default" || model === "claude-haiku-4-5") return DEFAULT_MODEL_CHOICE;
  return model;
}

export function modelChoiceFromId(raw: string | null | undefined): ModelChoice {
  if (!raw) return DEFAULT_MODEL_CHOICE;
  const wants1m = raw.includes("[1m]") || /(^|[^a-z])1m([^a-z]|$)/i.test(raw);
  const cleaned = raw.replace("[1m]", "");
  const bases = [...new Set(MODEL_CHOICES.filter((c) => c !== "default").map(baseModelId))];
  const match = bases
    .filter((b) => cleaned === b || cleaned.startsWith(b))
    .sort((a, b) => b.length - a.length)[0];
  if (!match) return DEFAULT_MODEL_CHOICE;
  const oneM = `${match}[1m]` as ModelChoice;
  return wants1m && MODEL_CHOICES.includes(oneM) ? oneM : (match as ModelChoice);
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
  if (baseModelId(model) === "claude-opus-4-7") return "xhigh";
  return "default";
}
