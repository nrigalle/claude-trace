import * as vscode from "vscode";
import type {
  CockpitHostToWebview,
  CockpitWebviewToHost,
} from "../protocol";
import type { CockpitHost } from "../app/CockpitController";

const COCKPIT_MESSAGE_TYPE_TABLE: Record<CockpitWebviewToHost["type"], true> = {
  cockpitReady: true,
  cockpitLaunch: true,
  cockpitQuickLaunch: true,
  cockpitSaveProfile: true,
  cockpitDeleteProfile: true,
  cockpitSaveSpace: true,
  cockpitDeleteSpace: true,
  terminalInput: true,
  terminalResize: true,
  terminalClose: true,
  cockpitResumeSession: true,
  cockpitAddTab: true,
  cockpitMoveSession: true,
  cockpitAdoptSession: true,
  cockpitAttention: true,
  cockpitDropImage: true,
  cockpitSaveLayout: true,
};
const COCKPIT_MESSAGE_TYPES: ReadonlySet<CockpitWebviewToHost["type"]> = new Set(
  Object.keys(COCKPIT_MESSAGE_TYPE_TABLE) as CockpitWebviewToHost["type"][],
);

export class CockpitHostAdapter implements CockpitHost {
  constructor(private readonly panel: vscode.WebviewPanel) {}

  postMessage(msg: CockpitHostToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  onMessage(listener: (msg: CockpitWebviewToHost) => void): vscode.Disposable {
    return this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      if (!raw || typeof raw !== "object" || !("type" in raw)) return;
      const type = (raw as { type: string }).type;
      if (!COCKPIT_MESSAGE_TYPES.has(type as CockpitWebviewToHost["type"])) return;
      listener(raw as CockpitWebviewToHost);
    });
  }

  onDispose(listener: () => void): vscode.Disposable {
    return this.panel.onDidDispose(listener);
  }
}
