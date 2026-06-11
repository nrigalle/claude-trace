import { PROJECTS_DIR } from "../../../shared/config";
import { aggregateByFile } from "../domain/fileEdits";
import { isAutoMemoryFile } from "../domain/memory";
import { computeStats } from "../domain/stats";
import {
  createSummaryAccumulator,
  finalizeSummary,
  foldSummaryEvent,
  summarize,
  type SummaryAccumulator,
} from "../domain/summarize";
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
  type SessionFileStats,
} from "../infra/SessionFileReader";
import { discoverSessionRefs, type SessionRef } from "../infra/paths";

export interface SessionTitleOverrides {
  get(id: SessionId): string | null;
}

export interface SessionPinSet {
  has(id: SessionId): boolean;
}

interface CachedSummary {
  readonly mtime: number;
  readonly title: string | null;
  readonly pinned: boolean;
  readonly summary: SessionSummary;
}

interface FoldState {
  acc: SummaryAccumulator;
}

export class SessionService {
  private refs: Map<SessionId, SessionRef> = new Map();
  private readonly summaryCache = new Map<SessionId, CachedSummary>();
  private readonly foldStates = new Map<SessionId, FoldState>();

  constructor(
    private readonly reader: SessionFileReader,
    private readonly overrides?: SessionTitleOverrides,
    private readonly pins?: SessionPinSet,
  ) {}

  invalidate(id: SessionId): void {
    this.reader.invalidate(id);
    this.summaryCache.delete(id);
    this.foldStates.delete(id);
  }

  invalidateAll(): void {
    this.reader.invalidateAll();
    this.refs.clear();
    this.summaryCache.clear();
    this.foldStates.clear();
  }

  projectDirFor(id: SessionId): string | null {
    return this.refs.get(id)?.projectDirName ?? null;
  }

  filePathFor(id: SessionId): string | null {
    return this.refs.get(id)?.filePath ?? null;
  }

  list(changedHint?: ReadonlySet<SessionId>): SessionSummary[] {
    if (changedHint && this.canFastList(changedHint)) return this.fastList(changedHint);
    ensureProjectsDirExists(PROJECTS_DIR);
    const chosen = new Map<SessionId, { ref: SessionRef; stats: SessionFileStats }>();
    for (const ref of discoverSessionRefs()) {
      const stats = this.reader.statSafe(ref);
      if (!stats) continue;
      const existing = chosen.get(ref.sessionId);
      if (!existing || stats.mtime > existing.stats.mtime) chosen.set(ref.sessionId, { ref, stats });
    }
    this.refs = new Map([...chosen].map(([id, c]) => [id, c.ref]));
    const presentIds = new Set<SessionId>();

    const summaries: SessionSummary[] = [];
    for (const { ref, stats } of chosen.values()) {
      presentIds.add(ref.sessionId);
      summaries.push(this.summarizeRef(ref, stats));
    }

    for (const id of [...this.summaryCache.keys()]) {
      if (!presentIds.has(id)) {
        this.summaryCache.delete(id);
        this.foldStates.delete(id);
      }
    }

    summaries.sort((a, b) => sortKey(b) - sortKey(a));
    return summaries;
  }

  private canFastList(changed: ReadonlySet<SessionId>): boolean {
    if (this.refs.size === 0) return false;
    for (const id of changed) {
      if (!this.refs.has(id)) return false;
    }
    return true;
  }

  private fastList(changed: ReadonlySet<SessionId>): SessionSummary[] {
    const summaries: SessionSummary[] = [];
    for (const [id, ref] of this.refs) {
      const cached = this.summaryCache.get(id);
      if (!changed.has(id) && cached) {
        summaries.push(cached.summary);
        continue;
      }
      const stats = this.reader.statSafe(ref);
      if (!stats) continue;
      summaries.push(this.summarizeRef(ref, stats));
    }
    summaries.sort((a, b) => sortKey(b) - sortKey(a));
    return summaries;
  }

  listActiveSince(sinceMs: number): SessionSummary[] {
    ensureProjectsDirExists(PROJECTS_DIR);
    const summaries: SessionSummary[] = [];
    for (const ref of discoverSessionRefs()) {
      const stats = this.reader.statSafe(ref);
      if (!stats || stats.mtime < sinceMs) continue;
      summaries.push(this.summarizeRef(ref, stats));
    }
    return summaries;
  }

  private summarizeRef(ref: SessionRef, stats: SessionFileStats): SessionSummary {
    const id = ref.sessionId;
    const title = this.titleFor(id);
    const pinned = this.pins?.has(id) ?? false;
    const cached = this.summaryCache.get(id);
    if (cached && cached.mtime === stats.mtime && cached.title === title && cached.pinned === pinned) {
      return cached.summary;
    }
    const existing = this.foldStates.get(id);
    const delta = this.reader.readDelta(ref, stats, existing === undefined);
    let fold = existing;
    if (!fold || delta.reset) {
      fold = { acc: createSummaryAccumulator() };
      this.foldStates.set(id, fold);
    }
    for (const e of delta.events) foldSummaryEvent(fold.acc, e);
    const freshTitle = this.titleFor(id);
    const summary = finalizeSummary(id, fold.acc, stats.mtime, { title: freshTitle, pinned });
    this.summaryCache.set(id, { mtime: stats.mtime, title: freshTitle, pinned, summary });
    return summary;
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
    return this.reader.getCustomTitle(id) ?? this.overrides?.get(id) ?? this.reader.getTitle(id);
  }
}

const sortKey = (s: SessionSummary): number => s.ended_at ?? s.last_modified_ms;
