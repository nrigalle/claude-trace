import type { ToolStat, TraceEvent } from "./types";
import { isPostToolUse } from "./types";

export const computeToolStats = (events: readonly TraceEvent[]): ToolStat[] => {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (isPostToolUse(e)) counts.set(e.tool_name, (counts.get(e.tool_name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
};
