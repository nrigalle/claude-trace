import { PROJECTS_DIR } from "../config";
import { aggregateByFile } from "../domain/fileEdits";
import { isAutoMemoryFile } from "../domain/memory";
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

export interface SessionTitleOverrides {
  get(id: SessionId): string | null;
}

export class SessionService {
  private refs: Map<SessionId, SessionRef> = new Map();

  constructor(
    private readonly reader: SessionFileReader,
    private readonly overrides?: SessionTitleOverrides,
  ) {}

  invalidate(id: SessionId): void {
    this.reader.invalidate(id);
  }

  invalidateAll(): void {
    this.reader.invalidateAll();
    this.refs.clear();
  }

  cwdFor(id: SessionId): string | null {
    return this.refs.get(id)?.filePath ? this.detail(id)?.cwd ?? null : null;
  }

  projectDirFor(id: SessionId): string | null {
    return this.refs.get(id)?.projectDirName ?? null;
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
      summaries.push(summarize(ref.sessionId, events, stats.mtime, { title: this.titleFor(ref.sessionId) }));
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
    const summary = summarize(id, events, stats.mtime, { title: this.titleFor(id) });
    const rawEdits = this.reader.getFileEdits(id);
    return {
      ...summary,
      events,
      tool_stats: computeToolStats(events),
      context_timeline: extractContextTimeline(events),
      cost_timeline: extractCostTimeline(events),
      memory_edits: aggregateByFile(rawEdits, isAutoMemoryFile),
      files_touched: aggregateByFile(rawEdits, (p) => !isAutoMemoryFile(p)),
    };
  }

  stats(sessions: readonly SessionSummary[]): GlobalStats {
    return computeStats(sessions);
  }

  private titleFor(id: SessionId): string | null {
    return this.overrides?.get(id) ?? this.reader.getTitle(id);
  }
}

const sortKey = (s: SessionSummary): number => s.ended_at ?? s.last_modified_ms;
