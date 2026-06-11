import * as vscode from "vscode";
import { dayStartMs, nonNegativeNumber, sumCostSince } from "../domain/budgetMath";
import type { SessionSummary } from "../domain/types";

const DEBOUNCE_MS = 5000;

interface BudgetConfig {
  readonly perDay: number;
}

export class BudgetMonitor implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly configListener: vscode.Disposable;

  constructor(private readonly listSessions: () => readonly SessionSummary[]) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 95);
    this.statusBar.name = "Claude Trace cost";
    this.statusBar.command = "claudeTrace.openDashboard";
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeTrace")) this.schedule();
    });
  }

  start(): vscode.Disposable {
    this.evaluate();
    return new vscode.Disposable(() => this.cancel());
  }

  schedule(): void {
    if (this.debounceTimer !== null) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.evaluate();
    }, DEBOUNCE_MS);
  }

  evaluate(): void {
    const cfg = this.readConfig();
    const sessions = this.listSessions();
    const today = sumTodayCost(sessions);

    this.refreshStatusBar(today, cfg);
  }

  dispose(): void {
    this.cancel();
    this.configListener.dispose();
    this.statusBar.dispose();
  }

  private cancel(): void {
    if (this.debounceTimer === null) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private refreshStatusBar(todayCostUsd: number, cfg: BudgetConfig): void {
    const formatted = `$${todayCostUsd.toFixed(2)}`;
    const text =
      cfg.perDay > 0
        ? `$(pulse) Claude ${formatted} / $${cfg.perDay.toFixed(2)}`
        : `$(pulse) Claude ${formatted} today`;
    if (this.statusBar.text !== text) this.statusBar.text = text;
    this.statusBar.tooltip = "Claude Code spend today. Click to open Claude Trace dashboard.";
    this.statusBar.backgroundColor = backgroundFor(todayCostUsd, cfg);
    this.statusBar.show();
  }

  private readConfig(): BudgetConfig {
    const cfg = vscode.workspace.getConfiguration("claudeTrace");
    return {
      perDay: nonNegativeNumber(cfg.get("budgetPerDay")),
    };
  }
}

const backgroundFor = (today: number, cfg: BudgetConfig): vscode.ThemeColor | undefined => {
  if (cfg.perDay <= 0) return undefined;
  if (today >= cfg.perDay) return new vscode.ThemeColor("statusBarItem.errorBackground");
  if (today >= cfg.perDay * 0.8) return new vscode.ThemeColor("statusBarItem.warningBackground");
  return undefined;
};

const sumTodayCost = (sessions: readonly SessionSummary[]): number =>
  sumCostSince(sessions, dayStartMs(new Date()));
