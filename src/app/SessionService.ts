import { PROJECTS_DIR } from "../config";
import { computeStats } from "../domain/stats";
import { summarize } from "../domain/summarize";
import { extractContextTimeline, extractCostTimeline } from "../domain/timelines";
import { computeToolStats } from "../domain/toolStats";
import type {
  GlobalStats,
  SessionDetail,
  SessionId,
  SessionSummary,
} from "../domain/types";
import {
  ensureProjectsDirExists,
  SessionFileReader,
} from "../infra/fs/SessionFileReader";
import { discoverSessionRefs, type SessionRef } from "../infra/fs/paths";

export class SessionService {
  private refs: Map<SessionId, SessionRef> = new Map();

  constructor(private readonly reader: SessionFileReader) {}

  invalidate(id: SessionId): void {
    this.reader.invalidate(id);
  }

  invalidateAll(): void {
    this.reader.invalidateAll();
    this.refs.clear();
  }

  list(): SessionSummary[] {
    ensureProjectsDirExists(PROJECTS_DIR);
    const refs = discoverSessionRefs();
    this.refs = new Map(refs.map((r) => [r.sessionId, r]));

    const summaries: SessionSummary[] = [];
    for (const ref of refs) {
      const stats = this.reader.statSafe(ref);
      if (!stats) continue;
      const events = this.reader.read(ref, stats);
      const title = this.reader.getTitle(ref.sessionId);
      summaries.push(summarize(ref.sessionId, events, stats.mtime, { title }));
    }

    summaries.sort((a, b) => sortKey(b) - sortKey(a));
    return summaries;
  }

  detail(id: SessionId): SessionDetail | null {
    const ref = this.refs.get(id);
    if (!ref) return null;
    const stats = this.reader.statSafe(ref);
    if (!stats) return null;
    const events = this.reader.read(ref, stats);
    const title = this.reader.getTitle(id);
    const summary = summarize(id, events, stats.mtime, { title });
    return {
      ...summary,
      events,
      tool_stats: computeToolStats(events),
      context_timeline: extractContextTimeline(events),
      cost_timeline: extractCostTimeline(events),
    };
  }

  stats(sessions: readonly SessionSummary[]): GlobalStats {
    return computeStats(sessions);
  }
}

const sortKey = (s: SessionSummary): number => s.ended_at ?? s.last_modified_ms;
