import * as vscode from "vscode";
import type {
  PipelinesHostToWebview,
  PipelinesWebviewToHost,
} from "../protocol";
import type { PipelinesHost } from "../app/PipelinesController";

const PIPELINES_MESSAGE_TYPE_TABLE: Record<PipelinesWebviewToHost["type"], true> = {
  ready: true,
  createPipeline: true,
  loadPipeline: true,
  savePipeline: true,
  deletePipeline: true,
  runPipeline: true,
  killRun: true,
  deleteRun: true,
  revealSession: true,
  loadRun: true,
  resumeRun: true,
  pipelineAssistantAsk: true,
  pipelineAssistantListConversations: true,
  pipelineAssistantLoadHistory: true,
  pipelineAssistantCancel: true,
  pipelineAssistantRenameConversation: true,
  pipelineAssistantDeleteConversation: true,
};
const PIPELINES_MESSAGE_TYPES: ReadonlySet<PipelinesWebviewToHost["type"]> = new Set(
  Object.keys(PIPELINES_MESSAGE_TYPE_TABLE) as PipelinesWebviewToHost["type"][],
);

export class PipelinesHostAdapter implements PipelinesHost {
  constructor(private readonly panel: vscode.WebviewPanel) {}

  postMessage(msg: PipelinesHostToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  onMessage(listener: (msg: PipelinesWebviewToHost) => void): vscode.Disposable {
    return this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      if (!raw || typeof raw !== "object" || !("type" in raw)) return;
      const type = (raw as { type: string }).type;
      if (!PIPELINES_MESSAGE_TYPES.has(type as PipelinesWebviewToHost["type"])) return;
      listener(raw as PipelinesWebviewToHost);
    });
  }

  onDispose(listener: () => void): vscode.Disposable {
    return this.panel.onDidDispose(listener);
  }
}
