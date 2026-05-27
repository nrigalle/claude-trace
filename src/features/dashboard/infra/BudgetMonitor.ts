import * as vscode from "vscode";
import { dayKey, dayStartMs, nonNegativeNumber, sumCostSince } from "../domain/budgetMath";
import type { SessionId, SessionSummary } from "../domain/types";

const DEBOUNCE_MS = 250;

interface BudgetConfig {
  readonly perSession: number;
  readonly perDay: number;
}

export class BudgetMonitor implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  private readonly warnedSessions = new Set<SessionId>();
  private warnedDayKey: string | null = null;
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

    if (cfg.perSession > 0) {
      for (const s of sessions) {
        const cost = s.cost?.total_cost_usd ?? 0;
        if (cost <= cfg.perSession) continue;
        if (this.warnedSessions.has(s.session_id)) continue;
        this.warnedSessions.add(s.session_id);
        const label = s.title?.trim() || `Session ${s.session_id.slice(0, 8)}`;
        void vscode.window.showWarningMessage(
          `Claude Trace: "${label}" passed the $${cfg.perSession.toFixed(2)} per-session budget (now $${cost.toFixed(2)}).`,
        );
      }
    }

    const dayKey = currentDayKey();
    if (cfg.perDay > 0 && today > cfg.perDay && this.warnedDayKey !== dayKey) {
      this.warnedDayKey = dayKey;
      void vscode.window.showWarningMessage(
        `Claude Trace: today's Claude Code spend ($${today.toFixed(2)}) passed the $${cfg.perDay.toFixed(2)} daily budget.`,
      );
    }
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
      perSession: nonNegative(cfg.get("budgetPerSession")),
      perDay: nonNegative(cfg.get("budgetPerDay")),
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

const currentDayKey = (): string => dayKey(new Date());

const nonNegative = (v: unknown): number => nonNegativeNumber(v);
