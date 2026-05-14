import * as vscode from "vscode";
import { COMMAND_OPEN_DASHBOARD } from "../../config";

export const registerStatusBar = (): vscode.Disposable => {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  item.command = COMMAND_OPEN_DASHBOARD;
  item.text = "$(pulse) Claude Trace";
  item.tooltip = "Open Claude Trace Dashboard";
  item.name = "Claude Trace";
  item.accessibilityInformation = { label: "Open Claude Trace Dashboard" };
  item.show();
  return item;
};
