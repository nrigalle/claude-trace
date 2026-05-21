import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { DashboardController, type DashboardActions } from "./app/DashboardController";
import { PendingNameStore } from "./app/PendingNameStore";
import { SessionService } from "./app/SessionService";
import { PROJECTS_DIR } from "./config";
import { isAutoMemoryFile } from "./domain/memory";
import { buildChatMarkdown, chatExportFilename } from "./domain/chatExport";
import { buildClaudeCommand } from "./domain/permissionModes";
import { computeBeforeContent } from "./domain/reverseApply";
import { buildUnifiedDiff } from "./domain/unifiedDiff";
import { ensureProjectsDirExists, SessionFileReader } from "./infra/fs/SessionFileReader";
import { SessionDirectoryWatcher, type WatcherListener } from "./infra/fs/SessionDirectoryWatcher";
import { SessionFilePoller } from "./infra/fs/SessionFilePoller";
import { BudgetMonitor } from "./infra/vscode/BudgetMonitor";
import { ClaudeTerminalRegistry } from "./infra/vscode/ClaudeTerminalRegistry";
import { ClaudeTraceQuickDiff } from "./infra/vscode/ClaudeTraceQuickDiff";
import { registerOpenDashboardCommand } from "./infra/vscode/Commands";
import { registerPanelSerializer, SerializedState } from "./infra/vscode/PanelSerializer";
import { pickModel, pickPermissionMode } from "./infra/vscode/SessionPickers";
import { SessionNameStore } from "./infra/vscode/SessionNameStore";
import { SessionPinStore } from "./infra/vscode/SessionPinStore";
import { registerStatusBar } from "./infra/vscode/StatusBar";
import { WebviewHost } from "./infra/vscode/WebviewHost";
import type { SessionId } from "./domain/types";
import { fromSessionId } from "./domain/types";

const PENDING_CLAIM_TTL_MS = 5 * 60_000;
const CLAUDE_TERMINAL_PREFIX = "Claude · ";

let currentController: DashboardController | null = null;

export function activate(context: vscode.ExtensionContext): void {
  ensureProjectsDirExists(PROJECTS_DIR);

  const nameStore = new SessionNameStore(context.globalState);
  const pinStore = new SessionPinStore(context.globalState);
  const pendingNames = new PendingNameStore();
  const reader = new SessionFileReader();
  const service = new SessionService(reader, nameStore, pinStore);
  const watcher = new SessionDirectoryWatcher();
  const poller = new SessionFilePoller();
  context.subscriptions.push(watcher.start());
  context.subscriptions.push(poller.start());

  const watcherSource = {
    onChange(listener: WatcherListener): vscode.Disposable {
      const a = watcher.onChange(listener);
      const b = poller.onChange(listener);
      return new vscode.Disposable(() => { a.dispose(); b.dispose(); });
    },
  };

  const quickDiff = new ClaudeTraceQuickDiff(service);
  context.subscriptions.push(quickDiff);

  const terminalRegistry = new ClaudeTerminalRegistry();
  context.subscriptions.push(terminalRegistry);

  const budgetMonitor = new BudgetMonitor(() => service.list());
  context.subscriptions.push(budgetMonitor.start());
  context.subscriptions.push(budgetMonitor);
  context.subscriptions.push(
    watcherSource.onChange(() => budgetMonitor.schedule()),
  );

  context.subscriptions.push(
    watcherSource.onChange((change) => {
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
    async resumeSession(id: SessionId, cwd: string | null): Promise<void> {
      const mode = (await pickPermissionMode("Ask before edits")) ?? "default";
      const shortId = fromSessionId(id).slice(0, 8);
      const terminal = await terminalRegistry.create(
        `${CLAUDE_TERMINAL_PREFIX}${shortId}`,
        cwd ?? undefined,
      );
      terminal.show();
      terminal.sendText(buildClaudeCommand({ mode, resumeId: fromSessionId(id) }));
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
    async viewFileDiff(id: SessionId, filePath: string): Promise<void> {
      const detail = service.detail(id);
      if (!detail) return;
      const summary =
        detail.files_touched.find((f) => f.filePath === filePath) ??
        detail.memory_edits.find((f) => f.filePath === filePath);
      if (!summary || summary.changes.length === 0) return;

      const fileUri = vscode.Uri.file(filePath);
      let currentContent = "";
      try {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        currentContent = new TextDecoder("utf-8").decode(bytes);
      } catch {
        currentContent = "";
      }

      const reverse = computeBeforeContent(currentContent, summary.changes);
      if (!reverse.ok) {
        void vscode.window.showWarningMessage(
          "Claude Trace: this file has been modified since the session ended, so the side-by-side diff can't be reconstructed. Showing a summary of what the session changed instead.",
        );
        const header = [
          "# Claude Trace — summary diff",
          "#",
          "# This file has been modified on disk since Claude's session ended,",
          "# so the side-by-side diff editor cannot faithfully reconstruct what changed.",
          "# The hunks below are what the session itself wrote, in chronological order.",
          "#",
          "",
        ].join("\n");
        const document = await vscode.workspace.openTextDocument({
          content: header + buildUnifiedDiff(summary),
          language: "diff",
        });
        await vscode.window.showTextDocument(document, { preview: true });
        return;
      }

      quickDiff.setActiveSession(id);
      const beforeUri = quickDiff.contentProvider.originalUri(filePath);
      const title = `${path.basename(filePath)} — Claude session vs current`;
      await vscode.commands.executeCommand("vscode.diff", beforeUri, fileUri, title, { preview: true });
    },
    async togglePin(id: SessionId): Promise<void> {
      try {
        await pinStore.toggle(id);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Claude Trace: failed to save pin state. ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    async exportChatMarkdown(id: SessionId): Promise<void> {
      const detail = service.detail(id);
      if (!detail) return;
      const markdown = buildChatMarkdown(detail);
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const defaultUri = vscode.Uri.file(
        path.join(cwd ?? os.homedir(), chatExportFilename(detail)),
      );
      const target = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { Markdown: ["md"] },
        saveLabel: "Export chat",
        title: "Export Claude session chat as Markdown",
      });
      if (!target) return;
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(markdown));
      void vscode.window.showInformationMessage(`Claude Trace: chat exported to ${target.fsPath}`);
    },
    setActiveSession(id: SessionId | null): void {
      quickDiff.setActiveSession(id);
    },
    invalidateSession(id: SessionId): void {
      quickDiff.invalidate(id);
    },
    async startNewSession(): Promise<void> {
      const name = await vscode.window.showInputBox({
        title: "Start a new Claude Code session",
        prompt: "Give this session a name. It becomes the title in the dashboard. Press Esc to cancel.",
        placeHolder: "e.g., Refactor auth middleware",
        ignoreFocusOut: true,
      });
      if (name === undefined) return;
      const trimmed = name.trim();
      if (!trimmed) return;

      const model = await pickModel("cancel");
      if (model === undefined) return;

      const mode = await pickPermissionMode("cancel");
      if (mode === undefined) return;

      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      pendingNames.set(trimmed, PENDING_CLAIM_TTL_MS);

      const terminal = await terminalRegistry.create(
        `${CLAUDE_TERMINAL_PREFIX}${trimmed.slice(0, 24)}`,
        cwd,
      );
      terminal.show();
      terminal.sendText(buildClaudeCommand({ mode, model }));
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
    currentController = new DashboardController(host, service, watcherSource, actions, state);
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
