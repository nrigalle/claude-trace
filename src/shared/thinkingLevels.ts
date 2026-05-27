import type { EffortLevel } from "../features/pipelines/domain/types";

export interface EffortOption {
  readonly id: EffortLevel;
  readonly label: string;
  readonly oneLine: string;
}

export const EFFORT_OPTIONS: readonly EffortOption[] = [
  {
    id: "low",
    label: "Low",
    oneLine: "File renames, simple greps, build commands. Execute, don't think.",
  },
  {
    id: "medium",
    label: "Medium",
    oneLine: "Default. General coding tasks, small refactors, reviewing a file.",
  },
  {
    id: "high",
    label: "High",
    oneLine: "Complex debugging, multi-file refactors, architecture questions.",
  },
  {
    id: "max",
    label: "Max",
    oneLine: "Designing systems from scratch, deep bugs, complex algorithms. No token cap.",
  },
];
