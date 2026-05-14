import * as vscode from "vscode";
import { PROJECTS_DIR } from "../../config";
import type { SessionId } from "../../domain/types";
import { parseUriPath } from "./paths";

export type WatcherChange = {
  readonly kind: "added" | "changed" | "removed";
  readonly sessionId: SessionId;
  readonly projectDirName: string;
};

export type WatcherListener = (change: WatcherChange) => void;

export class SessionDirectoryWatcher {
  private watcher: vscode.FileSystemWatcher | null = null;
  private readonly listeners = new Set<WatcherListener>();
  private readonly disposables: vscode.Disposable[] = [];

  start(): vscode.Disposable {
    if (this.watcher) return this.asDisposable();

    const pattern = new vscode.RelativePattern(vscode.Uri.file(PROJECTS_DIR), "**/*.jsonl");
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
    this.disposables.push(this.watcher);

    this.disposables.push(this.watcher.onDidCreate((uri) => this.emit("added", uri)));
    this.disposables.push(this.watcher.onDidChange((uri) => this.emit("changed", uri)));
    this.disposables.push(this.watcher.onDidDelete((uri) => this.emit("removed", uri)));

    return this.asDisposable();
  }

  onChange(listener: WatcherListener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  dispose(): void {
    this.listeners.clear();
    for (const d of this.disposables) {
      try { d.dispose(); } catch { }
    }
    this.disposables.length = 0;
    this.watcher = null;
  }

  private emit(kind: WatcherChange["kind"], uri: vscode.Uri): void {
    const parsed = parseUriPath(uri.fsPath);
    if (!parsed) return;
    for (const l of this.listeners) {
      try { l({ kind, sessionId: parsed.sessionId, projectDirName: parsed.projectDirName }); } catch { }
    }
  }

  private asDisposable(): vscode.Disposable {
    return new vscode.Disposable(() => this.dispose());
  }
}
