import * as vscode from "vscode";
import { VIEW_TYPE } from "../../config";

export interface SerializedState {
  readonly selectedId?: string | null;
}

export const registerPanelSerializer = (
  revive: (panel: vscode.WebviewPanel, state: SerializedState | undefined) => void,
): vscode.Disposable =>
  vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
      revive(panel, state as SerializedState | undefined);
    },
  });
