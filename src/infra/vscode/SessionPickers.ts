import * as vscode from "vscode";
import { MODEL_OPTIONS, type ModelChoice } from "../../domain/models";
import { PERMISSION_MODES, type PermissionMode } from "../../domain/permissionModes";

interface PermissionModeQuickPickItem extends vscode.QuickPickItem {
  readonly mode: PermissionMode;
}

interface ModelQuickPickItem extends vscode.QuickPickItem {
  readonly id: ModelChoice;
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

export const pickModel = async (escapeHint: string): Promise<ModelChoice | undefined> => {
  const items: ModelQuickPickItem[] = MODEL_OPTIONS.map((option) => ({
    id: option.id,
    label: option.label,
    description: option.id === "default" ? undefined : option.id,
    detail: option.oneLine,
  }));
  const choice = await vscode.window.showQuickPick(items, {
    title: "Model for this Claude session",
    placeHolder: `Which model should this session use? (Esc = ${escapeHint})`,
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return choice?.id;
};
