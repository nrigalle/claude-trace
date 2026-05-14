import * as vscode from "vscode";
import { DashboardController, type DashboardActions } from "./app/DashboardController";
import { SessionService } from "./app/SessionService";
import { PROJECTS_DIR } from "./config";
import { ensureProjectsDirExists, SessionFileReader } from "./infra/fs/SessionFileReader";
import { SessionDirectoryWatcher } from "./infra/fs/SessionDirectoryWatcher";
import { registerOpenDashboardCommand } from "./infra/vscode/Commands";
import { registerPanelSerializer, SerializedState } from "./infra/vscode/PanelSerializer";
import { SessionNameStore } from "./infra/vscode/SessionNameStore";
import { registerStatusBar } from "./infra/vscode/StatusBar";
import { WebviewHost } from "./infra/vscode/WebviewHost";
import type { SessionId } from "./domain/types";
import { fromSessionId } from "./domain/types";

let currentController: DashboardController | null = null;

export function activate(context: vscode.ExtensionContext): void {
  ensureProjectsDirExists(PROJECTS_DIR);

  const nameStore = new SessionNameStore(context.globalState);
  const reader = new SessionFileReader();
  const service = new SessionService(reader, nameStore);
  const watcher = new SessionDirectoryWatcher();
  context.subscriptions.push(watcher.start());

  const actions: DashboardActions = {
    async renameSession(id: SessionId): Promise<void> {
      const current = nameStore.get(id) ?? service.detail(id)?.title ?? "";
      const next = await vscode.window.showInputBox({
        title: "Rename Claude Trace session",
        prompt: "Enter a new name (leave empty to restore the AI generated title)",
        value: current,
        ignoreFocusOut: true,
      });
      if (next === undefined) return;
      await nameStore.set(id, next.trim() || null);
    },
    resumeSession(id: SessionId, cwd: string | null): void {
      const shortId = fromSessionId(id).slice(0, 8);
      const terminal = vscode.window.createTerminal({
        name: `Claude · ${shortId}`,
        cwd: cwd ?? undefined,
        iconPath: new vscode.ThemeIcon("pulse"),
      });
      terminal.show();
      terminal.sendText(`claude --resume ${fromSessionId(id)}`);
    },
  };

  const openDashboard = (existingPanel?: vscode.WebviewPanel, state?: SerializedState) => {
    if (currentController && !existingPanel) {
      currentController = null;
    }
    const column = vscode.window.activeTextEditor?.viewColumn;
    const host = new WebviewHost({
      extensionUri: context.extensionUri,
      column,
      existingPanel,
    });
    currentController = new DashboardController(host, service, watcher, actions, state);
    host.onDispose(() => {
      if (currentController) currentController.dispose();
      currentController = null;
    });
    if (!existingPanel) host.reveal(column);
  };

  context.subscriptions.push(registerOpenDashboardCommand(() => openDashboard()));
  context.subscriptions.push(registerStatusBar());
  context.subscriptions.push(
    registerPanelSerializer((panel, state) => openDashboard(panel, state)),
  );
}

export function deactivate(): void {
  if (currentController) currentController.dispose();
  currentController = null;
}
