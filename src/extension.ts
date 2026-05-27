import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { DashboardController, type DashboardActions } from "./features/dashboard/app/DashboardController";
import type { DetailLayoutEntry } from "./features/dashboard/protocol";
import {
  PipelinesController,
  newRunIdFromClock,
  type PipelinesActions,
} from "./features/pipelines/app/PipelinesController";
import { CockpitController, type CockpitActions } from "./features/cockpit/app/CockpitController";
import type { CockpitLayout } from "./features/cockpit/protocol";
import { ProfileStore } from "./features/cockpit/infra/ProfileStore";
import { CockpitSessionStore } from "./features/cockpit/infra/CockpitSessionStore";
import { encodeCwdForProjects } from "./shared/projectPathEncoding";
import {
  writeSessionHooks,
  removeSessionHooks,
  watchAttentionSignals,
  saveDroppedImage,
} from "./features/cockpit/infra/cockpitSignals";
import { CockpitHostAdapter } from "./features/cockpit/infra/CockpitHostAdapter";
import { PtyTerminalService } from "./features/cockpit/infra/pty/PtyTerminalService";
import { TmuxTerminalService, findTmux } from "./features/cockpit/infra/pty/TmuxTerminalService";
import { SessionService } from "./features/dashboard/app/SessionService";
import { RealAutomationRunner } from "./features/pipelines/infra/RealAutomationRunner";
import { RealDeterministicRunner } from "./features/pipelines/infra/RealDeterministicRunner";
import { TriggerScheduler, type TimerHandle } from "./features/pipelines/app/TriggerScheduler";
import { RealWebhookServer } from "./features/pipelines/infra/RealWebhookServer";
import { PROJECTS_DIR, COCKPIT_HOOKS_DIR } from "./shared/config";
import { PipelineStore } from "./features/pipelines/infra/PipelineStore";
import { RunStore } from "./features/pipelines/infra/RunStore";
import { PipelinesHostAdapter } from "./features/pipelines/infra/PipelinesHostAdapter";
import { isAutoMemoryFile } from "./features/dashboard/domain/memory";
import { buildChatMarkdown, chatExportFilename } from "./features/dashboard/domain/chatExport";
import { buildClaudeCommand } from "./shared/permissionModes";
import { desktopNotifyCommand } from "./shared/desktopNotification";
import { spawn } from "child_process";
import { computeBeforeContent } from "./features/dashboard/domain/reverseApply";
import { buildUnifiedDiff } from "./features/dashboard/domain/unifiedDiff";
import { ensureProjectsDirExists, SessionFileReader } from "./features/dashboard/infra/SessionFileReader";
import { SessionDirectoryWatcher, type WatcherListener } from "./features/dashboard/infra/SessionDirectoryWatcher";
import { SessionFilePoller } from "./features/dashboard/infra/SessionFilePoller";
import { BudgetMonitor } from "./features/dashboard/infra/BudgetMonitor";
import { ClaudeTerminalRegistry } from "./features/dashboard/infra/ClaudeTerminalRegistry";
import { ClaudeTraceQuickDiff } from "./features/dashboard/infra/ClaudeTraceQuickDiff";
import { registerOpenDashboardCommand } from "./features/dashboard/infra/Commands";
import { registerPanelSerializer, SerializedState } from "./features/dashboard/infra/PanelSerializer";
import { pickPermissionMode } from "./features/dashboard/infra/SessionPickers";
import { SessionNameStore } from "./features/dashboard/infra/SessionNameStore";
import { SessionPinStore } from "./features/dashboard/infra/SessionPinStore";
import { registerStatusBar } from "./features/dashboard/infra/StatusBar";
import { WebviewHost } from "./shared/WebviewHost";
import type { SessionId } from "./features/dashboard/domain/types";
import { fromSessionId, toSessionId } from "./features/dashboard/domain/types";

const CLAUDE_TERMINAL_PREFIX = "Claude · ";

let currentController: DashboardController | null = null;
let currentPipelinesController: PipelinesController | null = null;
let currentCockpitController: CockpitController | null = null;

const findBinary = (candidates: readonly string[]): string | null => {
  for (const bin of candidates) {
    try {
      if (fs.existsSync(bin)) return bin;
    } catch {}
  }
  return null;
};
const findAlerter = (): string | null =>
  findBinary(["/opt/homebrew/bin/alerter", "/usr/local/bin/alerter"]);
const findTerminalNotifier = (): string | null =>
  findBinary(["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"]);

let alerterBin: string | null = null;
let notifierBin: string | null = null;
let notifierIcon: string | null = null;
let notifierHintedThisSession = false;

const fireDesktopNotification = (title: string, message: string): void => {
  const enabled = vscode.workspace.getConfiguration("claudeTrace").get<boolean>("desktopNotifications", true);
  if (!enabled) return;
  const cmd = desktopNotifyCommand(process.platform, title, message, {
    alerterBin,
    terminalNotifierBin: notifierBin,
    iconPath: notifierIcon,
  });
  if (!cmd) return;
  try {
    const child = spawn(cmd.command, [...cmd.args], { stdio: "ignore", detached: true });
    child.unref();
    child.on("error", () => {});
  } catch {}
  if (process.platform === "darwin" && !alerterBin && !notifierHintedThisSession) {
    notifierHintedThisSession = true;
    void vscode.window
      .showInformationMessage(
        "macOS silently blocks notifications from unsigned tools. Install alerter (signed + notarized) for Claude Trace notifications with the app icon that stay on screen until dismissed.",
        "Install alerter",
        "Don't ask again",
      )
      .then((choice) => {
        if (choice === "Install alerter") {
          void vscode.commands.executeCommand("claudeTrace.setupDesktopNotifications");
        } else if (choice === "Don't ask again") {
          void vscode.workspace
            .getConfiguration("claudeTrace")
            .update("desktopNotifications", false, vscode.ConfigurationTarget.Global);
        }
      });
  }
};

export function activate(context: vscode.ExtensionContext): void {
  ensureProjectsDirExists(PROJECTS_DIR);

  const installNotifier = (): void => {
    const term = vscode.window.createTerminal("Claude Trace · notifications");
    term.show();
    term.sendText(
      "brew install vjeantet/tap/alerter && echo '\\n✅ Installed. The first notification will ask permission — click Allow. Then reload VS Code (Cmd+Shift+P → Developer: Reload Window).'",
    );
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeTrace.setupDesktopNotifications", installNotifier),
  );

  if (process.platform === "darwin") {
    alerterBin = findAlerter();
    notifierBin = findTerminalNotifier();
    notifierIcon = path.join(context.extensionPath, "media", "icon.png");
  }

  const nameStore = new SessionNameStore(context.globalState);
  const pinStore = new SessionPinStore(context.globalState);
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
    copyConversation(id: SessionId): void {
      void copyConversationToClipboard(id);
    },
    setActiveSession(id: SessionId | null): void {
      quickDiff.setActiveSession(id);
    },
    invalidateSession(id: SessionId): void {
      quickDiff.invalidate(id);
    },
    loadDetailLayout(): readonly DetailLayoutEntry[] {
      const saved = context.globalState.get<readonly DetailLayoutEntry[]>("ct.detailLayout");
      return Array.isArray(saved) ? saved : [];
    },
    saveDetailLayout(layout: readonly DetailLayoutEntry[]): void {
      void context.globalState.update("ct.detailLayout", layout);
    },
  };

  const pipelineStore = new PipelineStore();
  const runStore = new RunStore();
  const profileStore = new ProfileStore();
  const cockpitSessionStore = new CockpitSessionStore();

  const copyConversationToClipboard = async (sessionId: string): Promise<void> => {
    const detail = service.detail(toSessionId(sessionId));
    if (!detail) {
      void vscode.window.showWarningMessage(
        "Claude Trace: no conversation captured yet for this session.",
      );
      return;
    }
    await vscode.env.clipboard.writeText(buildChatMarkdown(detail));
    void vscode.window.setStatusBarMessage("Claude Trace: conversation copied to clipboard", 2000);
  };

  const openDashboard = (existingPanel?: vscode.WebviewPanel, state?: SerializedState) => {
    if (currentController && !existingPanel) {
      currentController.dispose();
      currentController = null;
    }
    if (currentPipelinesController && !existingPanel) {
      currentPipelinesController.dispose();
      currentPipelinesController = null;
    }
    if (currentCockpitController && !existingPanel) {
      currentCockpitController.dispose();
      currentCockpitController = null;
    }
    const column = vscode.window.activeTextEditor?.viewColumn;
    const host = new WebviewHost({
      extensionUri: context.extensionUri,
      column,
      existingPanel,
    });
    currentController = new DashboardController(host, service, watcherSource, actions, state);
    poller.setActive(host.visible);
    const pollerGate = host.onViewStateChange(() => poller.setActive(host.visible));
    const pipelinesHost = new PipelinesHostAdapter(host.panel);
    const runner = new RealAutomationRunner();
    const deterministic = new RealDeterministicRunner();
    const pipelinesActions: PipelinesActions = {
      async askPipelineName(initial: string): Promise<string | null> {
        const value = await vscode.window.showInputBox({
          title: "New Claude Trace pipeline",
          prompt: "Give this pipeline a name. It becomes the title in the sidebar.",
          placeHolder: "e.g., Daily release prep",
          value: initial,
          ignoreFocusOut: true,
          validateInput: (v) => (v.trim().length === 0 ? "Name is required" : null),
        });
        if (value === undefined) return null;
        return value.trim();
      },
      async confirmDeletePipeline(name: string): Promise<boolean> {
        const choice = await vscode.window.showWarningMessage(
          `Delete pipeline "${name}"? Past runs of this pipeline are preserved.`,
          { modal: true },
          "Delete",
        );
        return choice === "Delete";
      },
      async confirmDeleteRun(): Promise<boolean> {
        const choice = await vscode.window.showWarningMessage(
          "Delete this run? The transcript and all logs for this run will be removed permanently.",
          { modal: true },
          "Delete",
        );
        return choice === "Delete";
      },
      openSessionInTerminal(sessionId: string): void {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const terminal = vscode.window.createTerminal({
          name: `Claude · ${sessionId.slice(0, 8)}`,
          cwd,
        });
        terminal.sendText(`claude --resume ${sessionId}`);
        terminal.show(false);
      },
    };
    const triggerScheduler = new TriggerScheduler({
      listPipelines: () => pipelineStore.list(),
      runPipeline: (id) => currentPipelinesController?.triggerRun(id),
      setInterval: (fn, ms) => setInterval(fn, ms) as unknown as TimerHandle,
      clearInterval: (handle) => clearInterval(handle as unknown as ReturnType<typeof setInterval>),
    });
    const webhookServer = new RealWebhookServer(
      () => pipelineStore.list(),
      (id) => currentPipelinesController?.triggerRun(id),
    );
    currentPipelinesController = new PipelinesController({
      host: pipelinesHost,
      pipelineStore,
      runStore,
      runner,
      deterministic,
      actions: pipelinesActions,
      clock: () => Date.now(),
      newRunId: () => newRunIdFromClock(Date.now()),
      onPipelinesChanged: () => triggerScheduler.reconcile(),
    });
    triggerScheduler.reconcile();
    webhookServer.start();

    const cockpitActions: CockpitActions = {
      setName: (id, name) => void nameStore.set(toSessionId(id), name),
      defaultCwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
      newSessionId: () => crypto.randomUUID(),
      transcriptExists: (cwd, sessionId) =>
        fs.existsSync(
          path.join(PROJECTS_DIR, encodeCwdForProjects(cwd ?? os.homedir()), `${sessionId}.jsonl`),
        ),
      notifyAttention: (name) => {
        fireDesktopNotification("Claude Trace", `${name} is ready for you`);
      },
      prepareHooks: (sessionId) => writeSessionHooks(sessionId),
      cleanupHooks: (sessionId) => removeSessionHooks(sessionId),
      watchAttention: (listener) => watchAttentionSignals(listener),
      saveDroppedImage: (fileName, dataBase64) => saveDroppedImage(fileName, dataBase64),
      loadCockpitLayout: () => {
        const saved = context.globalState.get<CockpitLayout>("ct.cockpitLayout");
        return saved && typeof saved === "object"
          ? { columns: saved.columns ?? {}, spans: saved.spans ?? {}, order: saved.order ?? [] }
          : { columns: {}, spans: {}, order: [] };
      },
      saveCockpitLayout: (layout) => void context.globalState.update("ct.cockpitLayout", layout),
      now: () => Date.now(),
    };
    const tmuxBin = findTmux();
    const terminalBackend = tmuxBin
      ? new TmuxTerminalService(tmuxBin, path.join(COCKPIT_HOOKS_DIR, "..", "tmux.conf"))
      : new PtyTerminalService();
    currentCockpitController = new CockpitController({
      host: new CockpitHostAdapter(host.panel),
      profileStore,
      sessionStore: cockpitSessionStore,
      terminals: terminalBackend,
      actions: cockpitActions,
    });

    host.onDispose(() => {
      poller.setActive(false);
      pollerGate.dispose();
      if (currentController) currentController.dispose();
      currentController = null;
      triggerScheduler.dispose();
      webhookServer.dispose();
      if (currentPipelinesController) currentPipelinesController.dispose();
      currentPipelinesController = null;
      if (currentCockpitController) currentCockpitController.dispose();
      currentCockpitController = null;
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
  if (currentPipelinesController) currentPipelinesController.dispose();
  currentPipelinesController = null;
  if (currentCockpitController) currentCockpitController.dispose();
  currentCockpitController = null;
}
