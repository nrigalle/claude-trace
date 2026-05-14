import * as crypto from "crypto";
import * as vscode from "vscode";
import { VIEW_TITLE, VIEW_TYPE } from "../../config";
import type { HostToWebview, WebviewToHost } from "../../protocol";

export interface PanelOptions {
  readonly extensionUri: vscode.Uri;
  readonly column?: vscode.ViewColumn;
  readonly existingPanel?: vscode.WebviewPanel;
}

export class WebviewHost {
  readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;

  constructor(opts: PanelOptions) {
    this.extensionUri = opts.extensionUri;
    this.panel =
      opts.existingPanel ??
      vscode.window.createWebviewPanel(
        VIEW_TYPE,
        VIEW_TITLE,
        opts.column ?? vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: false,
          localResourceRoots: [vscode.Uri.joinPath(opts.extensionUri, "media")],
        },
      );
    this.configurePanel();
  }

  postMessage(msg: HostToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  onMessage(listener: (msg: WebviewToHost) => void): vscode.Disposable {
    return this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      if (raw && typeof raw === "object" && "type" in raw) {
        listener(raw as WebviewToHost);
      }
    });
  }

  onViewStateChange(listener: () => void): vscode.Disposable {
    return this.panel.onDidChangeViewState(listener);
  }

  onDispose(listener: () => void): vscode.Disposable {
    return this.panel.onDidDispose(listener);
  }

  reveal(column?: vscode.ViewColumn): void {
    this.panel.reveal(column, true);
  }

  get visible(): boolean {
    return this.panel.visible;
  }

  private configurePanel(): void {
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "icon.png");
    this.panel.webview.html = this.buildHtml();
  }

  private buildHtml(): string {
    const webview = this.panel.webview;
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "dashboard.css"),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "dashboard.js"),
    );
    const nonce = crypto.randomBytes(16).toString("hex");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${cssUri}">
  <title>${VIEW_TITLE}</title>
</head>
<body>
  <div id="app" aria-label="Claude Trace dashboard"></div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}
