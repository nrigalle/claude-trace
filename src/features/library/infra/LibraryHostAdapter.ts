import * as vscode from "vscode";
import type { LibraryHostToWebview, LibraryWebviewToHost } from "../protocol";
import type { LibraryHost } from "../app/LibraryController";

const LIBRARY_MESSAGE_TYPE_TABLE: Record<LibraryWebviewToHost["type"], true> = {
  ready: true,
  createSkill: true,
  createAgent: true,
  deleteSkill: true,
  deleteAgent: true,
  deleteSkillsBulk: true,
  deleteAgentsBulk: true,
  renameSkill: true,
  renameAgent: true,
  saveSkill: true,
  saveAgent: true,
  setSkillScope: true,
  setAgentScope: true,
  addProject: true,
  removeProject: true,
  scanForImports: true,
  importCandidates: true,
  syncNow: true,
  openLibraryDir: true,
  assistantAsk: true,
  assistantListConversations: true,
  assistantLoadHistory: true,
  assistantCancel: true,
  assistantRenameConversation: true,
  assistantDeleteConversation: true,
};

const LIBRARY_MESSAGE_TYPES: ReadonlySet<LibraryWebviewToHost["type"]> = new Set(
  Object.keys(LIBRARY_MESSAGE_TYPE_TABLE) as LibraryWebviewToHost["type"][],
);

export class LibraryHostAdapter implements LibraryHost {
  constructor(private readonly panel: vscode.WebviewPanel) {}

  postMessage(msg: LibraryHostToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  onMessage(listener: (msg: LibraryWebviewToHost) => void): vscode.Disposable {
    return this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      if (!raw || typeof raw !== "object" || !("type" in raw)) return;
      const type = (raw as { type: string }).type;
      if (!LIBRARY_MESSAGE_TYPES.has(type as LibraryWebviewToHost["type"])) return;
      listener(raw as LibraryWebviewToHost);
    });
  }
}
