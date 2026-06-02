import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { LIVE_POLL_INTERVAL_MS, PROJECTS_DIR } from "../../../shared/config";
import type { WatcherChange, WatcherListener } from "./SessionDirectoryWatcher";
import { discoverSessionRefs, filenameToSessionId, isHiddenAssistantProject, type SessionRef } from "./paths";

interface FileSnapshot {
  mtimeMs: number;
  size: number;
}

interface DirSnapshot {
  mtimeMs: number;
  entryCount: number;
}

const LIVE_FILE_WINDOW_MS = 60_000;
const DEEP_TICK_EVERY_MS = 30_000;

export class SessionFilePoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private seeded = false;
  private readonly snapshot = new Map<string, FileSnapshot>();
  private readonly knownRefs = new Map<string, SessionRef>();
  private readonly listeners = new Set<WatcherListener>();
  private readonly projectDirSnapshots = new Map<string, DirSnapshot>();
  private rootSnapshot: DirSnapshot | null = null;
  private lastDeepTickMs = 0;

  start(): vscode.Disposable {
    return new vscode.Disposable(() => this.setActive(false));
  }

  setActive(active: boolean): void {
    if (!active) {
      if (this.timer === null) return;
      clearInterval(this.timer);
      this.timer = null;
      return;
    }
    if (this.timer) return;
    if (this.seeded) {
      this.tick();
    } else {
      this.seedSnapshot();
      this.seeded = true;
      this.lastDeepTickMs = Date.now();
    }
    this.timer = setInterval(() => this.tick(), LIVE_POLL_INTERVAL_MS);
  }

  onChange(listener: WatcherListener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  private seedSnapshot(): void {
    this.rootSnapshot = statDir(PROJECTS_DIR);
    for (const ref of discoverSessionRefs()) {
      const stat = statSafe(ref.filePath);
      if (!stat) continue;
      this.knownRefs.set(ref.filePath, ref);
      this.snapshot.set(ref.filePath, { mtimeMs: stat.mtimeMs, size: stat.size });
    }
    for (const projectName of uniqueProjectNames(this.knownRefs.values())) {
      const projectPath = path.join(PROJECTS_DIR, projectName);
      const dirSnap = statDir(projectPath);
      if (dirSnap) this.projectDirSnapshots.set(projectName, dirSnap);
    }
  }

  private tick(): void {
    const now = Date.now();
    if (now - this.lastDeepTickMs >= DEEP_TICK_EVERY_MS) {
      this.lastDeepTickMs = now;
      this.rootSnapshot = statDir(PROJECTS_DIR);
      this.tickColdPath();
      return;
    }
    const rootSnap = statDir(PROJECTS_DIR);
    if (rootSnap && this.rootSnapshot && sameDir(rootSnap, this.rootSnapshot)) {
      this.tickHotPath();
      return;
    }
    this.rootSnapshot = rootSnap;
    this.tickColdPath();
  }

  private tickHotPath(): void {
    let projectNames: string[];
    try {
      projectNames = fs.readdirSync(PROJECTS_DIR);
    } catch {
      return;
    }
    for (const projectName of projectNames) {
      if (isHiddenAssistantProject(projectName)) continue;
      const projectPath = path.join(PROJECTS_DIR, projectName);
      const prev = this.projectDirSnapshots.get(projectName);
      const current = statDir(projectPath);
      if (!current) continue;
      if (!prev || !sameDir(prev, current)) {
        this.projectDirSnapshots.set(projectName, current);
        this.refreshProject(projectName);
      }
    }
    this.refreshLiveFiles();
  }

  private refreshLiveFiles(): void {
    const now = Date.now();
    for (const [filePath, ref] of this.knownRefs) {
      const prev = this.snapshot.get(filePath);
      if (!prev) continue;
      if (now - prev.mtimeMs > LIVE_FILE_WINDOW_MS) continue;
      const stat = statSafe(filePath);
      if (!stat) continue;
      if (prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) continue;
      prev.mtimeMs = stat.mtimeMs;
      prev.size = stat.size;
      this.emit("changed", ref);
    }
  }

  private tickColdPath(): void {
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
    for (const projectName of uniqueProjectNames(this.knownRefs.values())) {
      const dirSnap = statDir(path.join(PROJECTS_DIR, projectName));
      if (dirSnap) this.projectDirSnapshots.set(projectName, dirSnap);
    }
  }

  private refreshProject(projectName: string): void {
    if (isHiddenAssistantProject(projectName)) return;
    const projectPath = path.join(PROJECTS_DIR, projectName);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      this.evictProject(projectName);
      return;
    }
    const seenInProject = new Set<string>();
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const sessionId = filenameToSessionId(e.name);
      if (!sessionId) continue;
      const filePath = path.join(projectPath, e.name);
      seenInProject.add(filePath);
      const stat = statSafe(filePath);
      if (!stat) continue;
      const ref: SessionRef = { sessionId, projectDirName: projectName, filePath };
      const prev = this.snapshot.get(filePath);
      if (!prev) {
        this.knownRefs.set(filePath, ref);
        this.snapshot.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size });
        this.emit("added", ref);
        continue;
      }
      if (prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) continue;
      prev.mtimeMs = stat.mtimeMs;
      prev.size = stat.size;
      this.emit("changed", ref);
    }
    for (const [filePath, ref] of [...this.knownRefs]) {
      if (ref.projectDirName !== projectName) continue;
      if (seenInProject.has(filePath)) continue;
      this.knownRefs.delete(filePath);
      this.snapshot.delete(filePath);
      this.emit("removed", ref);
    }
  }

  private evictProject(projectName: string): void {
    this.projectDirSnapshots.delete(projectName);
    for (const [filePath, ref] of [...this.knownRefs]) {
      if (ref.projectDirName !== projectName) continue;
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
      try { l(change); } catch {}
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

const statDir = (dirPath: string): DirSnapshot | null => {
  const stat = statSafe(dirPath);
  if (!stat) return null;
  let entryCount: number;
  try {
    entryCount = fs.readdirSync(dirPath).length;
  } catch {
    return null;
  }
  return { mtimeMs: stat.mtimeMs, entryCount };
};

const sameDir = (a: DirSnapshot, b: DirSnapshot): boolean =>
  a.mtimeMs === b.mtimeMs && a.entryCount === b.entryCount;

const uniqueProjectNames = (refs: Iterable<SessionRef>): string[] => {
  const set = new Set<string>();
  for (const ref of refs) set.add(ref.projectDirName);
  return [...set];
};
