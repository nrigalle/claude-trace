import * as fs from "fs";
import * as vscode from "vscode";
import { LIVE_POLL_INTERVAL_MS } from "../../config";
import type { WatcherChange, WatcherListener } from "./SessionDirectoryWatcher";
import { discoverSessionRefs, type SessionRef } from "./paths";

interface FileSnapshot {
  mtimeMs: number;
  size: number;
}

export class SessionFilePoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly snapshot = new Map<string, FileSnapshot>();
  private readonly knownRefs = new Map<string, SessionRef>();
  private readonly listeners = new Set<WatcherListener>();

  start(): vscode.Disposable {
    if (this.timer) return new vscode.Disposable(() => this.stop());
    this.seedSnapshot();
    this.timer = setInterval(() => this.tick(), LIVE_POLL_INTERVAL_MS);
    return new vscode.Disposable(() => this.stop());
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  onChange(listener: WatcherListener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  private seedSnapshot(): void {
    for (const ref of discoverSessionRefs()) {
      const stat = statSafe(ref.filePath);
      if (!stat) continue;
      this.knownRefs.set(ref.filePath, ref);
      this.snapshot.set(ref.filePath, { mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }

  private tick(): void {
    const seen = new Set<string>();
    for (const ref of discoverSessionRefs()) {
      seen.add(ref.filePath);
      const stat = statSafe(ref.filePath);
      if (!stat) continue;
      const prev = this.snapshot.get(ref.filePath);
      if (!prev) {
        this.knownRefs.set(ref.filePath, ref);
        this.snapshot.set(ref.filePath, { mtimeMs: stat.mtimeMs, size: stat.size });
        this.emit("added", ref);
        continue;
      }
      if (prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) continue;
      prev.mtimeMs = stat.mtimeMs;
      prev.size = stat.size;
      this.emit("changed", ref);
    }
    for (const [filePath, ref] of [...this.knownRefs]) {
      if (seen.has(filePath)) continue;
      this.knownRefs.delete(filePath);
      this.snapshot.delete(filePath);
      this.emit("removed", ref);
    }
  }

  private emit(kind: WatcherChange["kind"], ref: SessionRef): void {
    const change: WatcherChange = {
      kind,
      sessionId: ref.sessionId,
      projectDirName: ref.projectDirName,
    };
    for (const l of this.listeners) {
      try { l(change); } catch { /* one listener should not break the rest */ }
    }
  }
}

const statSafe = (filePath: string): fs.Stats | null => {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
};
