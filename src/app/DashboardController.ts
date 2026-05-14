import * as vscode from "vscode";
import type { SessionId, SessionSummary } from "../domain/types";
import type { WebviewHost } from "../infra/vscode/WebviewHost";
import type {
  SessionDirectoryWatcher,
  WatcherChange,
} from "../infra/fs/SessionDirectoryWatcher";
import type { SerializedState } from "../infra/vscode/PanelSerializer";
import { assertNever } from "../protocol";
import type { SessionService } from "./SessionService";
import { RefreshScheduler } from "./RefreshScheduler";

export class DashboardController {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly scheduler: RefreshScheduler;
  private readonly lastSent = new Map<SessionId, number>();
  private activeSessionId: SessionId | null = null;
  private dirtySessions = new Set<SessionId>();
  private listDirty = false;
  private disposed = false;

  constructor(
    private readonly host: WebviewHost,
    private readonly service: SessionService,
    private readonly watcher: SessionDirectoryWatcher,
    initialState?: SerializedState,
  ) {
    if (initialState?.selectedId) {
      this.activeSessionId = initialState.selectedId as SessionId;
    }

    this.scheduler = new RefreshScheduler({
      isVisible: () => this.host.visible,
      flush: () => this.flush(),
    });

    this.disposables.push(this.watcher.onChange((c) => this.onWatcherChange(c)));
    this.disposables.push(this.host.onMessage((msg) => this.onMessage(msg)));
    this.disposables.push(this.host.onViewStateChange(() => this.onViewStateChange()));
    this.disposables.push(this.host.onDispose(() => this.dispose()));
    this.sendInitialPayload();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduler.dispose();
    for (const d of this.disposables) {
      try { d.dispose(); } catch { }
    }
    this.disposables.length = 0;
  }

  private onWatcherChange(change: WatcherChange): void {
    if (change.kind === "removed") {
      this.service.invalidate(change.sessionId);
      this.dirtySessions.add(change.sessionId);
      this.listDirty = true;
    } else {
      this.service.invalidate(change.sessionId);
      this.dirtySessions.add(change.sessionId);
      if (change.kind === "added") this.listDirty = true;
    }
    this.scheduler.schedule();
  }

  private onViewStateChange(): void {
    if (this.host.visible) this.scheduler.notifyVisible();
    else this.scheduler.notifyHidden();
  }

  private onMessage(msg: { type: string; sessionId?: SessionId | null }): void {
    switch (msg.type) {
      case "ready":
        this.sendInitialPayload();
        if (this.activeSessionId) this.sendSessionDetail(this.activeSessionId);
        return;
      case "selectSession":
        this.activeSessionId = msg.sessionId ?? null;
        if (this.activeSessionId) this.sendSessionDetail(this.activeSessionId);
        return;
      default:
        return;
    }
  }

  private sendInitialPayload(): void {
    const sessions = this.service.list();
    const stats = this.service.stats(sessions);
    const changedIds = this.diffAndRemember(sessions);
    this.host.postMessage({
      type: "update",
      sessions,
      stats,
      changedIds,
      removedIds: [],
    });
  }

  private sendSessionDetail(id: SessionId): void {
    const detail = this.service.detail(id);
    if (!detail) return;
    this.host.postMessage({ type: "sessionDetail", sessionId: id, detail });
  }

  private flush(): void {
    if (this.disposed) return;
    const sessions = this.service.list();
    const stats = this.service.stats(sessions);
    const changedIds = this.diffAndRemember(sessions);
    const removedIds = this.computeRemoved(sessions);

    this.host.postMessage({
      type: "update",
      sessions,
      stats,
      changedIds,
      removedIds,
    });

    const active = this.activeSessionId;
    if (active && (changedIds.includes(active) || this.dirtySessions.has(active) || this.listDirty)) {
      this.sendSessionDetail(active);
    }

    this.dirtySessions.clear();
    this.listDirty = false;
  }

  private diffAndRemember(sessions: readonly SessionSummary[]): SessionId[] {
    const changed: SessionId[] = [];
    const present = new Set<SessionId>();
    for (const s of sessions) {
      present.add(s.session_id);
      const prev = this.lastSent.get(s.session_id);
      if (prev === undefined || prev !== s.last_modified_ms) {
        changed.push(s.session_id);
        this.lastSent.set(s.session_id, s.last_modified_ms);
      }
    }
    for (const id of [...this.lastSent.keys()]) {
      if (!present.has(id)) this.lastSent.delete(id);
    }
    return changed;
  }

  private computeRemoved(sessions: readonly SessionSummary[]): SessionId[] {
    const present = new Set<SessionId>();
    for (const s of sessions) present.add(s.session_id);
    const removed: SessionId[] = [];
    for (const id of this.dirtySessions) {
      if (!present.has(id)) removed.push(id);
    }
    return removed;
  }
}

export const _exhaustCheck = assertNever;
