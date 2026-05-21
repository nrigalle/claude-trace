import type { TraceEvent } from "../../../../src/domain/types";
import type { TimelineFilter } from "../../state/Store.js";

export const isVisibleEvent = (e: TraceEvent): boolean =>
  e.event === "PostToolUse" ||
  e.event === "UserPrompt" ||
  e.event === "AssistantText" ||
  (e.event === "Metrics" && e.error !== null);

export const visibleCount = (events: readonly TraceEvent[]): number =>
  events.reduce((n, e) => (isVisibleEvent(e) ? n + 1 : n), 0);

export const filterEvents = (
  events: readonly TraceEvent[],
  filter: TimelineFilter,
  toolFilter: string | null,
): readonly TraceEvent[] => {
  const visible = events.filter(isVisibleEvent);
  let stage = visible;
  if (filter === "tools") stage = stage.filter((e) => e.event === "PostToolUse");
  else if (filter === "errors") stage = stage.filter((e) => e.error !== null);
  else if (filter === "conversation") {
    stage = stage.filter((e) => e.event === "UserPrompt" || e.event === "AssistantText");
  }
  if (toolFilter !== null) stage = stage.filter((e) => e.tool_name === toolFilter);
  return stage;
};

export const uniqueToolNames = (events: readonly TraceEvent[]): readonly string[] => {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.event !== "PostToolUse") continue;
    if (!e.tool_name) continue;
    counts.set(e.tool_name, (counts.get(e.tool_name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
};
