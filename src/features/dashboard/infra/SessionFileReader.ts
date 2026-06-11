import * as fs from "fs";
import { SESSION_CACHE_LRU_LIMIT } from "../../../shared/config";
import type { RawFileEdit } from "../domain/fileEdits";
import { createParseContext, parseNativeLine, type ParseContext } from "../domain/parseEvent";
import type { SessionId, TraceEvent } from "../domain/types";
import type { SessionRef } from "./paths";

const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
const MATERIALIZED_LIMIT = 3;

interface CacheEntry {
  mtime: number;
  size: number;
  events: TraceEvent[] | null;
  partialLine: string;
  parseCtx: ParseContext;
  lastAccess: number;
}

export interface SessionFileStats {
  readonly mtime: number;
  readonly size: number;
}

export interface EventDelta {
  readonly events: readonly TraceEvent[];
  readonly reset: boolean;
}

export class SessionFileReader {
  private readonly cache = new Map<SessionId, CacheEntry>();

  invalidate(id: SessionId): void {
    this.cache.delete(id);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  getCustomTitle(id: SessionId): string | null {
    return this.cache.get(id)?.parseCtx.customTitle ?? null;
  }

  getTitle(id: SessionId): string | null {
    const entry = this.cache.get(id);
    if (!entry) return null;
    return entry.parseCtx.aiTitle ?? entry.parseCtx.firstUserText ?? null;
  }

  getFileEdits(id: SessionId): readonly RawFileEdit[] {
    const entry = this.cache.get(id);
    return entry?.parseCtx.fileEdits ?? [];
  }

  statSafe(ref: SessionRef): SessionFileStats | null {
    try {
      const s = fs.statSync(ref.filePath);
      return { mtime: s.mtimeMs, size: s.size };
    } catch {
      return null;
    }
  }

  read(ref: SessionRef, stats: SessionFileStats): readonly TraceEvent[] {
    const cached = this.cache.get(ref.sessionId);
    if (cached && cached.events !== null && cached.mtime === stats.mtime && cached.size === stats.size) {
      cached.lastAccess = Date.now();
      return cached.events;
    }
    if (cached && cached.events !== null && stats.size >= cached.size) {
      this.appendTail(ref, cached, stats);
      return cached.events;
    }
    const { entry, events } = this.fullParse(ref, stats, true);
    if (!entry) return events;
    entry.events = events as TraceEvent[];
    this.cache.set(ref.sessionId, entry);
    this.enforceLru();
    return events;
  }

  readDelta(ref: SessionRef, stats: SessionFileStats, mustReset = false): EventDelta {
    const cached = this.cache.get(ref.sessionId);
    if (cached && mustReset && cached.events !== null && cached.mtime === stats.mtime && cached.size === stats.size) {
      cached.lastAccess = Date.now();
      return { events: cached.events, reset: true };
    }
    if (cached && !mustReset && stats.size >= cached.size) {
      const fresh = this.appendTail(ref, cached, stats);
      if (fresh !== null) return { events: fresh, reset: false };
    }
    const { entry, events } = this.fullParse(ref, stats, false);
    if (entry) {
      this.cache.set(ref.sessionId, entry);
      this.enforceLru();
    }
    return { events, reset: true };
  }

  private appendTail(ref: SessionRef, cached: CacheEntry, stats: SessionFileStats): TraceEvent[] | null {
    const bytesToRead = stats.size - cached.size;
    if (bytesToRead === 0) {
      cached.mtime = stats.mtime;
      cached.lastAccess = Date.now();
      return [];
    }
    let fd = -1;
    try {
      fd = fs.openSync(ref.filePath, "r");
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, cached.size);
      const chunk = cached.partialLine + buf.toString("utf-8");
      const lines = chunk.split("\n");
      const partial = chunk.endsWith("\n") ? "" : (lines.pop() ?? "");
      const fresh: TraceEvent[] = [];
      for (const line of lines) {
        for (const ev of parseNativeLine(line, cached.parseCtx)) {
          fresh.push(ev);
        }
      }
      if (cached.events !== null) cached.events.push(...fresh);
      cached.mtime = stats.mtime;
      cached.size = stats.size;
      cached.partialLine = partial;
      cached.lastAccess = Date.now();
      return fresh;
    } catch {
      return null;
    } finally {
      if (fd !== -1) {
        try { fs.closeSync(fd); } catch { }
      }
    }
  }

  private fullParse(
    ref: SessionRef,
    stats: SessionFileStats,
    collectFileEdits: boolean,
  ): { entry: CacheEntry | null; events: readonly TraceEvent[] } {
    let raw: string;
    const truncated = stats.size > MAX_TRANSCRIPT_BYTES;
    try {
      raw = truncated ? readPrefix(ref.filePath, MAX_TRANSCRIPT_BYTES) : fs.readFileSync(ref.filePath, "utf-8");
    } catch {
      this.cache.delete(ref.sessionId);
      return { entry: null, events: [] };
    }
    const lines = raw.split("\n");
    let partial: string;
    if (truncated) {
      lines.pop();
      partial = "";
    } else {
      partial = raw.endsWith("\n") ? "" : (lines.pop() ?? "");
    }
    const parseCtx = createParseContext(ref.sessionId, collectFileEdits);
    const events: TraceEvent[] = [];
    for (const line of lines) {
      for (const ev of parseNativeLine(line, parseCtx)) {
        events.push(ev);
      }
    }
    return {
      entry: {
        mtime: stats.mtime,
        size: stats.size,
        events: null,
        partialLine: partial,
        parseCtx,
        lastAccess: Date.now(),
      },
      events,
    };
  }

  private enforceLru(): void {
    const materialized = [...this.cache.values()].filter((e) => e.events !== null);
    if (materialized.length > MATERIALIZED_LIMIT) {
      materialized.sort((a, b) => a.lastAccess - b.lastAccess);
      for (const entry of materialized.slice(0, materialized.length - MATERIALIZED_LIMIT)) {
        entry.events = null;
        entry.parseCtx.fileEdits = [];
      }
    }
    if (this.cache.size <= SESSION_CACHE_LRU_LIMIT) return;
    const entries = [...this.cache.entries()];
    entries.sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    for (const [id] of entries.slice(0, this.cache.size - SESSION_CACHE_LRU_LIMIT)) {
      this.cache.delete(id);
    }
  }
}

const readPrefix = (filePath: string, maxBytes: number): string => {
  let fd = -1;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString("utf-8", 0, read);
  } finally {
    if (fd !== -1) {
      try { fs.closeSync(fd); } catch { }
    }
  }
};

export const ensureProjectsDirExists = (dir: string): void => {
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { }
  }
};
