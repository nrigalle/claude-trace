import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import type {
  AutomationRunner,
  JudgeOptions,
  SpawnHandle,
  SpawnOptions,
  TurnEndKind,
} from "../app/AutomationRunner";
import type {
  OrchestratorDecision,
  RunId,
} from "../domain/types";
import {
  buildOrchestratorPrompt,
  parseOrchestratorDecision,
} from "../domain/orchestratorProtocol";
import { encodeCwdForProjects } from "../../../shared/projectPathEncoding";

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const JSONL_POLL_INTERVAL_MS = 500;

const shellSingleQuote = (value: string): string =>
  `'${value.replace(/'/g, "'\\''")}'`;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const safeListJsonl = async (dir: string): Promise<Set<string>> => {
  try {
    const files = await fs.promises.readdir(dir);
    return new Set(files.filter((f) => f.endsWith(".jsonl")));
  } catch {
    return new Set<string>();
  }
};

const readLastAssistantText = (jsonlPath: string): string => {
  let content: string;
  try {
    content = fs.readFileSync(jsonlPath, "utf8");
  } catch {
    return "";
  }
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const text = extractAssistantText(parsed);
    if (text) return text;
  }
  return "";
};

const extractAssistantText = (event: unknown): string | null => {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  const role = typeof e["role"] === "string" ? e["role"] : undefined;
  const type = typeof e["type"] === "string" ? e["type"] : undefined;
  const isAssistant =
    type === "assistant" || role === "assistant" || e["event"] === "AssistantText";
  if (!isAssistant) return null;
  const message = e["message"];
  const content = e["content"] ?? (message && typeof message === "object" ? (message as Record<string, unknown>)["content"] : undefined);
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (let i = content.length - 1; i >= 0; i--) {
      const block = content[i];
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b["type"] === "text" && typeof b["text"] === "string") return b["text"];
      }
    }
  }
  if (typeof e["text"] === "string") return e["text"];
  return null;
};

const readConversationTail = (jsonlPath: string, n: number): string => {
  let content: string;
  try {
    content = fs.readFileSync(jsonlPath, "utf8");
  } catch {
    return "";
  }
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(-n).join("\n");
};

const TURN_END_STOP_REASONS: ReadonlySet<string> = new Set([
  "end_turn",
  "stop_sequence",
  "max_tokens",
  "refusal",
  "model_context_window_exceeded",
]);

const extractStopReason = (parsed: Record<string, unknown>): string | null => {
  const message = parsed["message"];
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const nested = (message as Record<string, unknown>)["stop_reason"];
    if (typeof nested === "string") return nested;
  }
  const top = parsed["stop_reason"];
  if (typeof top === "string") return top;
  return null;
};

const extractEventTimestamp = (parsed: Record<string, unknown>): number => {
  const ts = parsed["ts"];
  if (typeof ts === "number") return ts;
  const iso = parsed["timestamp"];
  if (typeof iso === "string") return Date.parse(iso);
  return 0;
};

export const findTurnEndAfter = (jsonlPath: string, sinceMs: number): boolean => {
  let content: string;
  try {
    content = fs.readFileSync(jsonlPath, "utf8");
  } catch {
    return false;
  }
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = extractEventTimestamp(parsed);
    if (ts < sinceMs) continue;
    const evt = parsed["event"] ?? parsed["type"];
    if (evt === "Stop") return true;
    const stopReason = extractStopReason(parsed);
    if (stopReason !== null && TURN_END_STOP_REASONS.has(stopReason)) {
      return true;
    }
  }
  return false;
};

interface SpawnState {
  readonly terminal: vscode.Terminal;
  jsonlPath: string;
  closed: boolean;
}

export interface RealAutomationRunnerOptions {
  readonly claudeCommand?: string;
  readonly projectsDir?: string;
}

export class RealAutomationRunner implements AutomationRunner {
  private readonly runTerminals = new Map<string, Set<vscode.Terminal>>();
  private readonly spawnStates = new WeakMap<vscode.Terminal, SpawnState>();
  private readonly terminalCloseSub: vscode.Disposable;
  private readonly claudeCommand: string;
  private readonly claudeProjectsDir: string;
  private disposed = false;

  constructor(options: RealAutomationRunnerOptions = {}) {
    this.claudeCommand = options.claudeCommand ?? "claude";
    this.claudeProjectsDir = options.projectsDir ?? CLAUDE_PROJECTS_DIR;
    this.terminalCloseSub = vscode.window.onDidCloseTerminal((t) => {
      const state = this.spawnStates.get(t);
      if (state) state.closed = true;
    });
  }

  async spawn(opts: SpawnOptions): Promise<SpawnHandle> {
    if (this.disposed) throw new Error("Runner has been disposed");
    if (opts.signal.aborted) throw new Error("Spawn was aborted before it could start.");

    const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const effectiveCwd = workspaceCwd ?? opts.cwd;
    await fs.promises.mkdir(effectiveCwd, { recursive: true });
    const projectsDir = path.join(this.claudeProjectsDir, encodeCwdForProjects(effectiveCwd));
    await fs.promises.mkdir(projectsDir, { recursive: true });
    const existingFiles = await safeListJsonl(projectsDir);
    const likelyFirstRunInCwd = existingFiles.size === 0;

    const args = ["--dangerously-skip-permissions", "--effort", opts.effort];
    if (opts.model !== "default") args.push("--model", opts.model);
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    if (opts.prompt.length > 0) args.push(shellSingleQuote(opts.prompt));

    const terminal = vscode.window.createTerminal({
      name: `Claude Trace · ${opts.blockId}`,
      cwd: effectiveCwd,
    });
    const state: SpawnState = { terminal, jsonlPath: "", closed: false };
    this.spawnStates.set(terminal, state);
    this.trackTerminal(opts.runId, terminal);

    if (likelyFirstRunInCwd) {
      terminal.show(true);
    }

    terminal.sendText(`${this.claudeCommand} ${args.join(" ")}`);

    const sessionId = await this.waitForNewJsonl(
      projectsDir,
      existingFiles,
      opts.resumeSessionId ?? null,
      state,
      opts.signal,
    );

    state.jsonlPath = path.join(projectsDir, `${sessionId}.jsonl`);

    return {
      sessionId,
      jsonlPath: state.jsonlPath,
      waitForTurnEnd: (sinceMs, signal) =>
        this.waitForTurnEnd(state, sinceMs, signal),
      reveal: () => { try { terminal.show(false); } catch {} },
      dispose: () => {
        try { terminal.dispose(); } catch {}
        this.untrackTerminal(opts.runId, terminal);
      },
      readLastAssistantText: () => readLastAssistantText(state.jsonlPath),
    };
  }

  async judge(opts: JudgeOptions): Promise<OrchestratorDecision> {
    const conversationTail = readConversationTail(opts.workerJsonlPath, 100);

    const orchStartMs = Date.now();
    const orchHandle = await this.spawn({
      runId: opts.runId,
      blockId: opts.blockId,
      cwd: opts.cwd,
      prompt: buildOrchestratorPrompt(opts.taskGoal, conversationTail),
      model: "claude-sonnet-4-6",
      effort: "medium",
      resumeSessionId: null,
      signal: opts.signal,
    });

    try {
      const turnEnd = await orchHandle.waitForTurnEnd(orchStartMs, opts.signal);
      if (turnEnd === "aborted") {
        return { kind: "needs-input", reason: "Judging was cancelled by the user." };
      }
      if (turnEnd === "terminal-closed") {
        return {
          kind: "needs-input",
          reason: "Orchestrator terminal was closed before it could respond — manual review needed.",
        };
      }
      const lastText = readLastAssistantText(orchHandle.jsonlPath);
      return parseOrchestratorDecision(lastText);
    } finally {
      orchHandle.dispose();
    }
  }

  killRun(runId: RunId): void {
    const terminals = this.runTerminals.get(runId);
    if (!terminals) return;
    for (const terminal of terminals) {
      try { terminal.dispose(); } catch {}
    }
    this.runTerminals.delete(runId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminalCloseSub.dispose();
    for (const terminals of this.runTerminals.values()) {
      for (const terminal of terminals) {
        try { terminal.dispose(); } catch {}
      }
    }
    this.runTerminals.clear();
  }

  private trackTerminal(runId: RunId, terminal: vscode.Terminal): void {
    let set = this.runTerminals.get(runId);
    if (!set) {
      set = new Set<vscode.Terminal>();
      this.runTerminals.set(runId, set);
    }
    set.add(terminal);
  }

  private untrackTerminal(runId: RunId, terminal: vscode.Terminal): void {
    const set = this.runTerminals.get(runId);
    if (!set) return;
    set.delete(terminal);
    if (set.size === 0) this.runTerminals.delete(runId);
  }

  private async waitForNewJsonl(
    projectsDir: string,
    existingFiles: Set<string>,
    resumeSessionId: string | null,
    state: SpawnState,
    signal: AbortSignal,
  ): Promise<string> {
    while (true) {
      if (this.disposed) throw new Error("Runner disposed while waiting for Claude to start.");
      if (signal.aborted) throw new Error("Spawn aborted while waiting for Claude to start.");
      if (state.closed) {
        throw new Error("The Claude terminal was closed before the session could start. If a folder-trust prompt was shown, answer it and try again.");
      }
      const files = await safeListJsonl(projectsDir);
      if (resumeSessionId && files.has(`${resumeSessionId}.jsonl`)) {
        return resumeSessionId;
      }
      for (const f of files) {
        if (existingFiles.has(f)) continue;
        return f.slice(0, -".jsonl".length);
      }
      await sleep(JSONL_POLL_INTERVAL_MS);
    }
  }

  private waitForTurnEnd(
    state: SpawnState,
    sinceMs: number,
    signal: AbortSignal,
  ): Promise<TurnEndKind> {
    return new Promise<TurnEndKind>((resolve) => {
      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        signal.removeEventListener("abort", onAbort);
      };

      const finish = (kind: TurnEndKind) => {
        cleanup();
        resolve(kind);
      };

      const onAbort = () => finish("aborted");

      if (signal.aborted) { finish("aborted"); return; }
      signal.addEventListener("abort", onAbort);

      const tick = () => {
        if (this.disposed || signal.aborted) { finish("aborted"); return; }
        if (state.closed) { finish("terminal-closed"); return; }
        if (findTurnEndAfter(state.jsonlPath, sinceMs)) { finish("stopped"); return; }
        timer = setTimeout(tick, JSONL_POLL_INTERVAL_MS);
      };
      tick();
    });
  }
}
