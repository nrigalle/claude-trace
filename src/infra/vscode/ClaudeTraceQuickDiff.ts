import * as vscode from "vscode";
import type { SessionService } from "../../app/SessionService";
import type { FileChange } from "../../domain/fileEdits";
import { computeBeforeContent } from "../../domain/reverseApply";
import type { SessionId } from "../../domain/types";
import { CLAUDE_TRACE_SCHEME, ClaudeTraceContentProvider } from "./ClaudeTraceContentProvider";

const MAX_DIFFABLE_BYTES = 2_000_000;

export class ClaudeTraceQuickDiff implements vscode.Disposable {
  readonly contentProvider: ClaudeTraceContentProvider;
  private readonly sourceControl: vscode.SourceControl;
  private readonly providerRegistration: vscode.Disposable;
  private activeSessionId: SessionId | null = null;
  private activePaths: Set<string> = new Set();

  constructor(private readonly service: SessionService) {
    const rootUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    this.sourceControl = vscode.scm.createSourceControl("claudetrace", "Claude Trace", rootUri);
    this.sourceControl.quickDiffProvider = {
      provideOriginalResource: (uri) => this.provideOriginalResource(uri),
    };
    this.contentProvider = new ClaudeTraceContentProvider((path, token) => this.resolve(path, token));
    this.providerRegistration = vscode.workspace.registerTextDocumentContentProvider(
      CLAUDE_TRACE_SCHEME,
      this.contentProvider,
    );
  }

  setActiveSession(id: SessionId | null): void {
    if (id === this.activeSessionId) return;
    const previousPaths = this.activePaths;
    const nextPaths = new Set(this.pathsFor(id));
    this.activeSessionId = id;
    this.activePaths = nextPaths;
    const union = new Set<string>([...previousPaths, ...nextPaths]);
    for (const path of union) this.contentProvider.notifyChanged(path);
  }

  invalidate(id: SessionId): void {
    if (id !== this.activeSessionId) return;
    const refreshedPaths = new Set(this.pathsFor(id));
    const union = new Set<string>([...this.activePaths, ...refreshedPaths]);
    this.activePaths = refreshedPaths;
    for (const path of union) this.contentProvider.notifyChanged(path);
  }

  findChanges(filePath: string): readonly FileChange[] | null {
    if (this.activeSessionId === null) return null;
    if (!this.activePaths.has(filePath)) return null;
    const detail = this.service.detail(this.activeSessionId);
    if (!detail) return null;
    const summary =
      detail.files_touched.find((f) => f.filePath === filePath) ??
      detail.memory_edits.find((f) => f.filePath === filePath);
    return summary?.changes ?? null;
  }

  dispose(): void {
    this.providerRegistration.dispose();
    this.contentProvider.dispose();
    this.sourceControl.dispose();
  }

  private provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme !== "file") return undefined;
    if (!this.activePaths.has(uri.fsPath)) return undefined;
    return this.contentProvider.originalUri(uri.fsPath);
  }

  private async resolve(filePath: string, token: vscode.CancellationToken): Promise<string> {
    const current = await readFileSafe(filePath, token);
    if (token.isCancellationRequested) return current;
    const changes = this.findChanges(filePath);
    if (!changes) return current;
    const result = computeBeforeContent(current, changes);
    if (!result.ok) return current;
    return result.before;
  }

  private pathsFor(id: SessionId | null): readonly string[] {
    if (id === null) return [];
    const detail = this.service.detail(id);
    if (!detail) return [];
    const out: string[] = [];
    for (const f of detail.files_touched) out.push(f.filePath);
    for (const f of detail.memory_edits) out.push(f.filePath);
    return out;
  }
}

const readFileSafe = async (
  filePath: string,
  token: vscode.CancellationToken,
): Promise<string> => {
  try {
    const uri = vscode.Uri.file(filePath);
    const stat = await vscode.workspace.fs.stat(uri);
    if (token.isCancellationRequested) return "";
    if (stat.size > MAX_DIFFABLE_BYTES) return "";
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
};
