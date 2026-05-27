import * as vscode from "vscode";
import { PERMISSION_MODES, type PermissionMode } from "../../../shared/permissionModes";

interface PermissionModeQuickPickItem extends vscode.QuickPickItem {
  readonly mode: PermissionMode;
}

export const pickPermissionMode = async (escapeHint: string): Promise<PermissionMode | undefined> => {
  const items: PermissionModeQuickPickItem[] = PERMISSION_MODES.map((option) => ({
    mode: option.mode,
    label: option.label,
    description: option.mode,
    detail: option.oneLine,
  }));
  const choice = await vscode.window.showQuickPick(items, {
    title: "Permission mode for this Claude session",
    placeHolder: `How much should Claude ask before acting? (Esc = ${escapeHint})`,
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return choice?.mode;
};
