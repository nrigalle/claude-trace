import * as vscode from "vscode";

let channel: vscode.OutputChannel | null = null;

export const traceLog = (): vscode.OutputChannel => {
  if (!channel) channel = vscode.window.createOutputChannel("Claude Trace");
  return channel;
};

export const logInfo = (scope: string, message: string): void => {
  traceLog().appendLine(`[${new Date().toISOString()}] [${scope}] ${message}`);
};

export const logWarn = (scope: string, message: string, err?: unknown): void => {
  const detail = err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${String(err)}` : "";
  traceLog().appendLine(`[${new Date().toISOString()}] [${scope}] WARN ${message}${detail}`);
};

export const disposeTraceLog = (): void => {
  channel?.dispose();
  channel = null;
};
