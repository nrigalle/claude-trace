import * as fs from "fs";
import { SESSION_CACHE_LRU_LIMIT } from "../../../shared/config";
import type { RawFileEdit } from "../domain/fileEdits";
import { createParseContext, parseNativeLine, type ParseContext } from "../domain/parseEvent";
import type { SessionId, TraceEvent } from "../domain/types";
import type { SessionRef } from "./paths";

const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
const ignoreBestEffortFailure = (_err: unknown): void => {};

interface CacheEntry {
  mtime: number;
  size: number;
  events: TraceEvent[];
  partialLine: string;
  parseCtx: ParseContext;
  lastAccess: number;
}

export interface SessionFileStats {
  readonly mtime: number;
  readonly size: number;
}

export class SessionFileReader {
  private readonly cache = new Map<SessionId, CacheEntry>();

  invalidate(id: SessionId): void {
    this.cache.delete(id);
  }

  invalidateAll(): void {
    this.cache.clear();
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
    if (cached && cached.mtime === stats.mtime && cached.size === stats.size) {
      cached.lastAccess = Date.now();
      return cached.events;
    }

    if (cached && stats.size >= cached.size) {
      return this.tailRead(ref, cached, stats);
    }

    return this.fullRead(ref, stats);
  }

  private tailRead(
    ref: SessionRef,
    cached: CacheEntry,
    stats: SessionFileStats,
  ): readonly TraceEvent[] {
    const bytesToRead = stats.size - cached.size;
    if (bytesToRead === 0) {
      cached.mtime = stats.mtime;
      cached.lastAccess = Date.now();
      return cached.events;
    }

    let fd = -1;
    try {
      fd = fs.openSync(ref.filePath, "r");
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, cached.size);
      const chunk = cached.partialLine + buf.toString("utf-8");
      const lines = chunk.split("\n");
      const partial = chunk.endsWith("\n") ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        for (const ev of parseNativeLine(line, cached.parseCtx)) {
          cached.events.push(ev);
        }
      }
      cached.mtime = stats.mtime;
      cached.size = stats.size;
      cached.partialLine = partial;
      cached.lastAccess = Date.now();
      this.enforceLru();
      return cached.events;
    } catch {
      return this.fullRead(ref, stats);
    } finally {
      if (fd !== -1) {
        try { fs.closeSync(fd); } catch { }
      }
    }
  }

  private fullRead(ref: SessionRef, stats: SessionFileStats): readonly TraceEvent[] {
    let raw: string;
    const truncated = stats.size > MAX_TRANSCRIPT_BYTES;
    try {
      raw = truncated ? readPrefix(ref.filePath, MAX_TRANSCRIPT_BYTES) : fs.readFileSync(ref.filePath, "utf-8");
    } catch {
      this.cache.delete(ref.sessionId);
      return [];
    }
    const lines = raw.split("\n");
    let partial: string;
    if (truncated) {
      lines.pop();
      partial = "";
    } else {
      partial = raw.endsWith("\n") ? "" : (lines.pop() ?? "");
    }
    const parseCtx = createParseContext(ref.sessionId);
    const events: TraceEvent[] = [];
    for (const line of lines) {
      for (const ev of parseNativeLine(line, parseCtx)) {
        events.push(ev);
      }
    }
    this.cache.set(ref.sessionId, {
      mtime: stats.mtime,
      size: stats.size,
      events,
      partialLine: partial,
      parseCtx,
      lastAccess: Date.now(),
    });
    this.enforceLru();
    return events;
  }

  private enforceLru(): void {
    if (this.cache.size <= SESSION_CACHE_LRU_LIMIT) return;
    const entries = [...this.cache.entries()];
    entries.sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    const toEvict = entries.slice(0, this.cache.size - SESSION_CACHE_LRU_LIMIT);
    for (const [id] of toEvict) this.cache.delete(id);
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
      try { fs.closeSync(fd); } catch (err: unknown) { ignoreBestEffortFailure(err); }
    }
  }
};

export const ensureProjectsDirExists = (dir: string): void => {
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { }
  }
};
