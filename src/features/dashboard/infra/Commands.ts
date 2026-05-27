import * as vscode from "vscode";
import { COMMAND_OPEN_DASHBOARD } from "../../../shared/config";

export const registerOpenDashboardCommand = (
  handler: () => void,
): vscode.Disposable =>
  vscode.commands.registerCommand(COMMAND_OPEN_DASHBOARD, handler);
