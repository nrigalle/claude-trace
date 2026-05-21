import * as vscode from "vscode";

export class ClaudeTerminalRegistry implements vscode.Disposable {
  private readonly terminals: vscode.Terminal[] = [];
  private readonly subscription: vscode.Disposable;

  constructor() {
    this.subscription = vscode.window.onDidCloseTerminal((closed) => this.remove(closed));
  }

  async create(name: string, cwd: string | undefined): Promise<vscode.Terminal> {
    const parent = this.newestLive();
    if (parent) {
      parent.show(false);
      await vscode.commands.executeCommand("workbench.action.splitEditorRight");
    }
    const terminal = vscode.window.createTerminal({
      name,
      cwd,
      iconPath: new vscode.ThemeIcon("pulse"),
      location: vscode.TerminalLocation.Editor,
    });
    this.terminals.push(terminal);
    return terminal;
  }

  private newestLive(): vscode.Terminal | null {
    for (let i = this.terminals.length - 1; i >= 0; i--) {
      const t = this.terminals[i]!;
      if (t.exitStatus === undefined) return t;
    }
    return null;
  }

  private remove(terminal: vscode.Terminal): void {
    const idx = this.terminals.indexOf(terminal);
    if (idx >= 0) this.terminals.splice(idx, 1);
  }

  dispose(): void {
    this.subscription.dispose();
  }
}
