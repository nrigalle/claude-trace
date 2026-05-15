import * as path from "path";
import * as vscode from "vscode";
import { DashboardController, type DashboardActions } from "./app/DashboardController";
import { PendingNameStore } from "./app/PendingNameStore";
import { SessionService } from "./app/SessionService";
import { PROJECTS_DIR } from "./config";
import { isAutoMemoryFile } from "./domain/memory";
import { ensureProjectsDirExists, SessionFileReader } from "./infra/fs/SessionFileReader";
import { SessionDirectoryWatcher } from "./infra/fs/SessionDirectoryWatcher";
import { registerOpenDashboardCommand } from "./infra/vscode/Commands";
import { registerPanelSerializer, SerializedState } from "./infra/vscode/PanelSerializer";
import { SessionNameStore } from "./infra/vscode/SessionNameStore";
import { registerStatusBar } from "./infra/vscode/StatusBar";
import { WebviewHost } from "./infra/vscode/WebviewHost";
import type { SessionId } from "./domain/types";
import { fromSessionId } from "./domain/types";

const PENDING_CLAIM_TTL_MS = 5 * 60_000;

let currentController: DashboardController | null = null;

export function activate(context: vscode.ExtensionContext): void {
  ensureProjectsDirExists(PROJECTS_DIR);

  const nameStore = new SessionNameStore(context.globalState);
  const pendingNames = new PendingNameStore();
  const reader = new SessionFileReader();
  const service = new SessionService(reader, nameStore);
  const watcher = new SessionDirectoryWatcher();
  context.subscriptions.push(watcher.start());

  context.subscriptions.push(
    watcher.onChange((change) => {
      if (change.kind !== "added") return;
      const claimed = pendingNames.take();
      if (claimed === null) return;
      void nameStore.set(change.sessionId, claimed);
    }),
  );

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
    openMemoryFile(filePath: string): void {
      if (!isAutoMemoryFile(filePath)) return;
      void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(filePath));
    },
    openMemoryFolder(id: SessionId): void {
      const projectDir = service.projectDirFor(id);
      if (!projectDir) return;
      const memoryDir = path.join(PROJECTS_DIR, projectDir, "memory");
      void vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(memoryDir));
    },
    openFile(filePath: string): void {
      if (!filePath) return;
      void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(filePath));
    },
    async startNewSession(): Promise<void> {
      const name = await vscode.window.showInputBox({
        title: "Start a new Claude Code session",
        prompt: "Give this session a name. It becomes the title in the dashboard.",
        placeHolder: "e.g., Refactor auth middleware",
        ignoreFocusOut: true,
      });
      const trimmed = name?.trim() ?? "";
      if (!trimmed) return;

      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      pendingNames.set(trimmed, PENDING_CLAIM_TTL_MS);

      const terminal = vscode.window.createTerminal({
        name: `Claude · ${trimmed.slice(0, 24)}`,
        cwd,
        iconPath: new vscode.ThemeIcon("pulse"),
      });
      terminal.show();
      terminal.sendText("claude");
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
