import * as vscode from "vscode";
import { DashboardController } from "./app/DashboardController";
import { SessionService } from "./app/SessionService";
import { PROJECTS_DIR } from "./config";
import { ensureProjectsDirExists, SessionFileReader } from "./infra/fs/SessionFileReader";
import { SessionDirectoryWatcher } from "./infra/fs/SessionDirectoryWatcher";
import { registerOpenDashboardCommand } from "./infra/vscode/Commands";
import { registerPanelSerializer, SerializedState } from "./infra/vscode/PanelSerializer";
import { registerStatusBar } from "./infra/vscode/StatusBar";
import { WebviewHost } from "./infra/vscode/WebviewHost";

let currentController: DashboardController | null = null;

export function activate(context: vscode.ExtensionContext): void {
  ensureProjectsDirExists(PROJECTS_DIR);

  const reader = new SessionFileReader();
  const service = new SessionService(reader);
  const watcher = new SessionDirectoryWatcher();
  context.subscriptions.push(watcher.start());

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
    currentController = new DashboardController(host, service, watcher, state);
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
