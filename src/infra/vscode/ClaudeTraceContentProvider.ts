import * as vscode from "vscode";

export const CLAUDE_TRACE_SCHEME = "claudetrace";

export type ContentResolver = (filePath: string, token: vscode.CancellationToken) => Promise<string>;

export class ClaudeTraceContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly resolver: ContentResolver) {}

  originalUri(filePath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: CLAUDE_TRACE_SCHEME, path: filePath });
  }

  provideTextDocumentContent(
    uri: vscode.Uri,
    token: vscode.CancellationToken,
  ): Promise<string> {
    return this.resolver(uri.path, token);
  }

  notifyChanged(filePath: string): void {
    this.emitter.fire(this.originalUri(filePath));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
