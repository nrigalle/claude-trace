import * as vscode from "vscode";
import { COMMAND_OPEN_DASHBOARD } from "../../config";

export const registerOpenDashboardCommand = (
  handler: () => void,
): vscode.Disposable =>
  vscode.commands.registerCommand(COMMAND_OPEN_DASHBOARD, handler);
