import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";

import type {
  AutomationRunner,
  JudgeOptions,
  JudgeOutcome,
  SpawnHandle,
  SpawnOptions,
  TurnEndKind,
} from "../app/AutomationRunner";
import type { RunId } from "../domain/types";
import {
  buildOrchestratorPrompt,
  parseOrchestratorDecision,
} from "../domain/orchestratorProtocol";
import { encodeCwdForProjects } from "../../../shared/projectPathEncoding";
import { markerCommand, type ClaudeHookSettings } from "../../../shared/claudeHookMarkers";
import { RUN_HOOKS_DIR, RUN_SIGNALS_DIR } from "../../../shared/config";
import { quoteShellArg, type ShellQuote } from "../../../shared/permissionModes";
import { ensureFolderTrusted } from "../../../shared/claudeTrust";
import { logWarn } from "../../../shared/infra/traceLog";

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const POLL_INTERVAL_MS = 500;
const LIVENESS_CHECK_EVERY_TICKS = 4;
const MAX_PROMPT_CHARS = 150_000;
const ignoreBestEffortFailure = (_err: unknown): void => {};

const execFileAsync = promisify(execFile);

const listChildPids = async (pid: number): Promise<number[]> => {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-P", String(pid)]);
    return stdout.split("\n").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
  } catch (err: unknown) {
    ignoreBestEffortFailure(err);
    return [];
  }
};

const killProcessTree = async (pid: number): Promise<void> => {
  if (process.platform === "win32") {
    try { await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]); }
    catch (err: unknown) { ignoreBestEffortFailure(err); }
    return;
  }
  const children = await listChildPids(pid);
  await Promise.all(children.map((child) => killProcessTree(child)));
  try { process.kill(pid, "SIGKILL"); } catch (err: unknown) { ignoreBestEffortFailure(err); }
};

const shellQuoteStyle = (): ShellQuote =>
  process.platform === "win32" ? "powershell" : "posix";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

const DIGEST_MAX_LINES = 120;
const DIGEST_MAX_ENTRY_CHARS = 1200;
const DIGEST_MAX_TOTAL_CHARS = 48_000;

const digestEntry = (raw: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw.slice(0, 200);
  }
  if (!parsed || typeof parsed !== "object") return raw.slice(0, 200);
  const e = parsed as Record<string, unknown>;
  const type = typeof e["type"] === "string" ? e["type"] : "event";
  const message = e["message"];
  const content = message && typeof message === "object" ? (message as Record<string, unknown>)["content"] : undefined;
  if (typeof content === "string") return `${type}: ${content.slice(0, DIGEST_MAX_ENTRY_CHARS)}`;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b["type"] === "text" && typeof b["text"] === "string") parts.push(b["text"].slice(0, DIGEST_MAX_ENTRY_CHARS));
      else if (b["type"] === "tool_use") parts.push(`[tool: ${String(b["name"])} ${JSON.stringify(b["input"] ?? {}).slice(0, 200)}]`);
      else if (b["type"] === "tool_result") parts.push(`[tool result: ${JSON.stringify(b["content"] ?? "").slice(0, 300)}]`);
    }
    return `${type}: ${parts.join(" ").slice(0, DIGEST_MAX_ENTRY_CHARS)}`;
  }
  return type;
};

export const readConversationDigest = (jsonlPath: string): string => {
  let content: string;
  try {
    content = fs.readFileSync(jsonlPath, "utf8");
  } catch {
    return "";
  }
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const entries = lines.slice(-DIGEST_MAX_LINES).map(digestEntry).filter((e) => e.length > 0);
  let digest = entries.join("\n");
  if (digest.length > DIGEST_MAX_TOTAL_CHARS) digest = digest.slice(digest.length - DIGEST_MAX_TOTAL_CHARS);
  return digest;
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

const markerMtimeAfter = (markerPath: string, sinceMs: number): boolean => {
  try {
    return fs.statSync(markerPath).mtimeMs > sinceMs;
  } catch {
    return false;
  }
};

const shellHasChildren = async (shellPid: number): Promise<boolean> =>
  (await listChildPids(shellPid)).length > 0;

export const buildRunnerHookSettings = (sessionId: string, signalsDir: string): ClaudeHookSettings => {
  const marker = (kind: string): string => markerCommand(signalsDir, sessionId, kind);
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: marker("start") }] }],
      Stop: [{ hooks: [{ type: "command", command: marker("stop") }] }],
      Notification: [{ matcher: "permission_prompt", hooks: [{ type: "command", command: marker("notify") }] }],
    },
  };
};

interface SpawnState {
  readonly terminal: vscode.Terminal;
  readonly sessionId: string;
  readonly hooksPath: string | null;
  jsonlPath: string;
  closed: boolean;
  shellPid?: number;
}

export interface RealAutomationRunnerOptions {
  readonly claudeCommand?: string;
  readonly projectsDir?: string;
  readonly hooksDir?: string;
  readonly signalsDir?: string;
  readonly initDeadlineMs?: number;
  readonly claudeConfigPath?: string;
}

export class RealAutomationRunner implements AutomationRunner {
  private readonly runTerminals = new Map<string, Set<vscode.Terminal>>();
  private readonly spawnStates = new WeakMap<vscode.Terminal, SpawnState>();
  private readonly liveSessionIds = new Set<string>();
  private readonly terminalCloseSub: vscode.Disposable;
  private readonly claudeCommand: string;
  private readonly claudeProjectsDir: string;
  private readonly hooksDir: string;
  private readonly signalsDir: string;
  private readonly initDeadlineMs: number;
  private readonly claudeConfigPath: string | undefined;
  private disposed = false;

  constructor(options: RealAutomationRunnerOptions = {}) {
    this.claudeCommand = options.claudeCommand ?? "claude";
    this.claudeProjectsDir = options.projectsDir ?? CLAUDE_PROJECTS_DIR;
    this.hooksDir = options.hooksDir ?? RUN_HOOKS_DIR;
    this.signalsDir = options.signalsDir ?? RUN_SIGNALS_DIR;
    this.initDeadlineMs = options.initDeadlineMs ?? 90_000;
    this.claudeConfigPath = options.claudeConfigPath;
    this.terminalCloseSub = vscode.window.onDidCloseTerminal((t) => {
      const state = this.spawnStates.get(t);
      if (state) state.closed = true;
    });
    this.sweepOrphanSessions();
  }

  private writeRunnerHooks(sessionId: string): string | null {
    try {
      fs.mkdirSync(this.hooksDir, { recursive: true });
      fs.mkdirSync(this.signalsDir, { recursive: true });
      const file = path.join(this.hooksDir, `${sessionId}.json`);
      fs.writeFileSync(file, JSON.stringify(buildRunnerHookSettings(sessionId, this.signalsDir)), "utf8");
      return file;
    } catch (err: unknown) {
      logWarn("pipelines", `Could not write hook settings for workflow session ${sessionId}; falling back to transcript-based turn detection`, err);
      return null;
    }
  }

  private removeRunnerSessionFiles(sessionId: string): void {
    for (const f of [
      path.join(this.hooksDir, `${sessionId}.json`),
      path.join(this.signalsDir, `${sessionId}.start`),
      path.join(this.signalsDir, `${sessionId}.stop`),
      path.join(this.signalsDir, `${sessionId}.notify`),
    ]) {
      try { fs.rmSync(f, { force: true }); } catch (err: unknown) { ignoreBestEffortFailure(err); }
    }
  }

  async spawn(opts: SpawnOptions): Promise<SpawnHandle> {
    if (this.disposed) throw new Error("Runner has been disposed");
    if (opts.signal.aborted) throw new Error("Spawn was aborted before it could start.");
    if (opts.prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(
        `Prompt is ${opts.prompt.length} characters — too large to launch on a command line (limit ${MAX_PROMPT_CHARS}). Pass big data through files in the workspace instead of inlining it in the prompt.`,
      );
    }

    const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const effectiveCwd = workspaceCwd ?? opts.cwd;
    await fs.promises.mkdir(effectiveCwd, { recursive: true });
    await ensureFolderTrusted(effectiveCwd, this.claudeConfigPath);
    const projectsDir = path.join(this.claudeProjectsDir, encodeCwdForProjects(effectiveCwd));
    await fs.promises.mkdir(projectsDir, { recursive: true });

    const sessionId = opts.resumeSessionId ?? crypto.randomUUID();
    const hooksPath = this.writeRunnerHooks(sessionId);
    const quote = (value: string): string => quoteShellArg(value, shellQuoteStyle());

    const args = ["--dangerously-skip-permissions", "--effort", opts.effort];
    if (opts.model !== "default") args.push("--model", quote(opts.model));
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    else args.push("--session-id", sessionId);
    if (hooksPath) args.push("--settings", quote(hooksPath));
    if (opts.prompt.length > 0) args.push(quote(opts.prompt));

    const terminal = vscode.window.createTerminal({
      name: `Claude Trace · ${opts.blockId}`,
      cwd: effectiveCwd,
      hideFromUser: true,
    });
    const state: SpawnState = { terminal, sessionId, hooksPath, jsonlPath: path.join(projectsDir, `${sessionId}.jsonl`), closed: false };
    this.spawnStates.set(terminal, state);
    this.liveSessionIds.add(sessionId);
    void terminal.processId?.then((p) => { if (p) state.shellPid = p; }, () => undefined);
    this.trackTerminal(opts.runId, terminal);

    const spawnMs = Date.now();
    terminal.sendText(`${this.claudeCommand} ${args.join(" ")}`);

    await this.waitForSessionStart(state, spawnMs, opts.signal, effectiveCwd);

    return {
      sessionId,
      jsonlPath: state.jsonlPath,
      waitForTurnEnd: (sinceMs, signal) =>
        this.waitForTurnEnd(state, sinceMs, signal),
      reveal: () => { try { terminal.show(false); } catch (err: unknown) { ignoreBestEffortFailure(err); } },
      dispose: () => {
        this.disposeTerminal(terminal);
        this.untrackTerminal(opts.runId, terminal);
      },
      readLastAssistantText: () => readLastAssistantText(state.jsonlPath),
    };
  }

  async judge(opts: JudgeOptions): Promise<JudgeOutcome> {
    try {
      return await this.judgeUnsafe(opts);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        decision: { kind: "needs-input", reason: `Orchestrator could not run: ${reason}` },
        orchestratorSessionId: opts.resumeSessionId,
      };
    }
  }

  private async judgeUnsafe(opts: JudgeOptions): Promise<JudgeOutcome> {
    const conversationTail = readConversationDigest(opts.workerJsonlPath);

    const orchStartMs = Date.now();
    const orchHandle = await this.spawn({
      runId: opts.runId,
      blockId: opts.blockId,
      cwd: opts.cwd,
      prompt: buildOrchestratorPrompt(opts.taskGoal, conversationTail),
      model: "claude-sonnet-4-6",
      effort: "medium",
      resumeSessionId: opts.resumeSessionId,
      signal: opts.signal,
    });

    try {
      const turnEnd = await orchHandle.waitForTurnEnd(orchStartMs, opts.signal);
      if (turnEnd === "aborted") {
        return {
          decision: { kind: "needs-input", reason: "Judging was cancelled by the user." },
          orchestratorSessionId: orchHandle.sessionId,
        };
      }
      if (turnEnd === "terminal-closed" || turnEnd === "notified") {
        return {
          decision: {
            kind: "needs-input",
            reason: "Orchestrator could not respond. Manual review needed.",
          },
          orchestratorSessionId: orchHandle.sessionId,
        };
      }
      const lastText = readLastAssistantText(orchHandle.jsonlPath);
      return {
        decision: parseOrchestratorDecision(lastText),
        orchestratorSessionId: orchHandle.sessionId,
      };
    } finally {
      orchHandle.dispose();
    }
  }

  private disposeTerminal(terminal: vscode.Terminal): void {
    const state = this.spawnStates.get(terminal);
    if (state?.shellPid) void killProcessTree(state.shellPid);
    if (state) {
      this.liveSessionIds.delete(state.sessionId);
      this.removeRunnerSessionFiles(state.sessionId);
    }
    try { terminal.dispose(); } catch (err: unknown) { ignoreBestEffortFailure(err); }
  }

  killRun(runId: RunId): void {
    const terminals = this.runTerminals.get(runId);
    if (terminals) {
      for (const terminal of terminals) {
        this.disposeTerminal(terminal);
      }
      this.runTerminals.delete(runId);
    }
    this.sweepOrphanSessions();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminalCloseSub.dispose();
    for (const terminals of this.runTerminals.values()) {
      for (const terminal of terminals) {
        this.disposeTerminal(terminal);
      }
    }
    this.runTerminals.clear();
    this.sweepOrphanSessions();
  }

  private sweepOrphanSessions(): void {
    if (process.platform === "win32") return;
    void execFileAsync("pgrep", ["-fl", this.hooksDir]).then(
      ({ stdout }) => {
        for (const line of stdout.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          const pid = parseInt(trimmed, 10);
          if (!Number.isInteger(pid) || pid <= 0) continue;
          const match = /([0-9a-f-]{36})\.json/.exec(trimmed);
          const sessionId = match?.[1];
          if (sessionId && this.liveSessionIds.has(sessionId)) continue;
          void killProcessTree(pid);
          if (sessionId) this.removeRunnerSessionFiles(sessionId);
        }
      },
      (err: unknown) => ignoreBestEffortFailure(err),
    );
  }

  private async waitForSessionStart(
    state: SpawnState,
    spawnMs: number,
    signal: AbortSignal,
    cwd: string,
  ): Promise<void> {
    const startMarker = path.join(this.signalsDir, `${state.sessionId}.start`);
    while (true) {
      if (this.disposed) throw new Error("Runner disposed while waiting for Claude to start.");
      if (signal.aborted) throw new Error("Spawn aborted while waiting for Claude to start.");
      if (state.closed) {
        throw new Error("The Claude terminal was closed before the session could start. If a folder-trust prompt was shown, answer it and try again.");
      }
      if (state.hooksPath === null) {
        if (fs.existsSync(state.jsonlPath)) return;
      } else if (markerMtimeAfter(startMarker, spawnMs)) {
        return;
      }
      if (Date.now() - spawnMs > this.initDeadlineMs) {
        throw new Error(
          `Claude did not start a session within ${Math.round(this.initDeadlineMs / 1000)}s in ${cwd}. This is a startup failure (folder-trust dialog, login prompt, or a broken claude install), not a slow task.`,
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  private waitForTurnEnd(
    state: SpawnState,
    sinceMs: number,
    signal: AbortSignal,
  ): Promise<TurnEndKind> {
    const stopMarker = path.join(this.signalsDir, `${state.sessionId}.stop`);
    const notifyMarker = path.join(this.signalsDir, `${state.sessionId}.notify`);
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

      let ticks = 0;
      let emptyChildChecks = 0;
      let livenessInFlight = false;
      const tick = () => {
        if (this.disposed || signal.aborted) { finish("aborted"); return; }
        if (state.closed) { finish("terminal-closed"); return; }
        if (markerMtimeAfter(stopMarker, sinceMs)) { finish("stopped"); return; }
        if (markerMtimeAfter(notifyMarker, sinceMs)) { finish("notified"); return; }
        if (findTurnEndAfter(state.jsonlPath, sinceMs)) { finish("stopped"); return; }
        if (emptyChildChecks >= 2) { finish("process-exited"); return; }
        ticks += 1;
        if (
          process.platform !== "win32" &&
          state.hooksPath !== null &&
          state.shellPid !== undefined &&
          !livenessInFlight &&
          ticks % LIVENESS_CHECK_EVERY_TICKS === 0
        ) {
          livenessInFlight = true;
          void shellHasChildren(state.shellPid).then(
            (alive) => {
              livenessInFlight = false;
              emptyChildChecks = alive ? 0 : emptyChildChecks + 1;
            },
            () => { livenessInFlight = false; },
          );
        }
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      };
      tick();
    });
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
}
