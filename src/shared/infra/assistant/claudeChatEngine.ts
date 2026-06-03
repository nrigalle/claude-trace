import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as pty from "node-pty";
import { buildCockpitHookSettings } from "../../../features/cockpit/infra/cockpitHooks";
import {
  concatTextEvents,
  extractConversationTurns,
  extractTimelineEvents,
} from "../../assistant/conversationTurns";
import { PROJECTS_DIR } from "../../config";
import { encodeCwdForProjects } from "../../projectPathEncoding";
import { modelEffortLevels, type EffortChoice, type ModelChoice } from "../../models";
import type { ReplayTurn, TimelineEvent } from "../../assistant/timeline";


export {
  concatTextEvents,
  extractConversationTurns,
  extractTimelineEvents,
  INTERNAL_MESSAGE_MARKER,
  SESSION_CONTEXT_CLOSE,
  SESSION_CONTEXT_OPEN,
  wrapSessionContext,
} from "../../assistant/conversationTurns";
export type { ReplayTurn, TimelineEvent };

export interface ChatPty {
  readonly onData: (listener: (data: string) => void) => unknown;
  readonly onExit: (listener: () => void) => unknown;
  readonly write: (data: string) => void;
  readonly kill: () => void;
}

export interface ChatPtyOptions {
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string;
  readonly env: { readonly [key: string]: string };
}

export interface ChatPtySpawner {
  readonly spawn: (file: string, args: readonly string[], options: ChatPtyOptions) => ChatPty;
}

export interface ChatHooks {
  readonly installHooks: (sessionId: string) => string | null;
  readonly removeHooks: (sessionId: string) => void;
  readonly subscribeStop: (sessionId: string, listener: () => void) => { dispose(): void };
}

export interface ClaudeChatConfig {
  readonly claudeBin?: string;
  readonly claudeArgsPrefix?: readonly string[];
  readonly ptySpawner?: ChatPtySpawner;
  readonly cwdRoot: string;
  readonly transcriptRoot?: string;
  readonly signalsDir: string;
  readonly hooksDir: string;
  readonly hooks?: Partial<ChatHooks>;
}

export interface ChatTurnOptions {
  readonly model?: ModelChoice;
  readonly effort?: EffortChoice;
  readonly onProgress?: (events: readonly TimelineEvent[]) => void;
}

export interface ChatTurnResult {
  readonly events: readonly TimelineEvent[];
  readonly text: string;
}

export interface SessionState {
  sessionId: string;
  sessionCwd: string;
  transcriptPath: string;
  transcriptOffset: number;
  hooksFile: string;
  systemPrompt: string;
  hasFirstTurn: boolean;
  currentPty: ChatPty | null;
  busy: boolean;
  cancelled: boolean;
}

const STREAM_POLL_MS = 500;
const READY_BEFORE_SUBMIT_MS = 1800;
const SUBMIT_QUIET_MS = 350;
const COLS = 120;
const ROWS = 40;
const FINAL_POLL_MS = 100;
const FINAL_STABLE_MS = 300;
const FINAL_NO_CONTENT_MAX_MS = 6000;
const FINAL_MAX_WAIT_MS = 30000;

export type StopReason = "stop" | "exit" | "cancel";

export const encodeForClaudeProjects = encodeCwdForProjects;

const encodeForFs = (key: string): string => key.replace(/[^A-Za-z0-9-]/g, "_");

export class ClaudeChatEngine {
  private readonly sessions = new Map<string, SessionState>();
  private readonly hooks: ChatHooks;
  private readonly claudeBin: string;
  private readonly claudeArgsPrefix: readonly string[];
  private readonly ptySpawner: ChatPtySpawner;
  private readonly cwdRoot: string;
  private readonly transcriptRoot: string;

  constructor(private readonly config: ClaudeChatConfig) {
    this.claudeBin = config.claudeBin ?? "claude";
    this.claudeArgsPrefix = config.claudeArgsPrefix ?? [];
    this.ptySpawner = config.ptySpawner ?? NODE_PTY_SPAWNER;
    this.cwdRoot = config.cwdRoot;
    this.transcriptRoot = config.transcriptRoot ?? PROJECTS_DIR;
    const defaults = makeFileSignalHooks(config.signalsDir, config.hooksDir);
    this.hooks = {
      installHooks: config.hooks?.installHooks ?? defaults.installHooks,
      removeHooks: config.hooks?.removeHooks ?? defaults.removeHooks,
      subscribeStop: config.hooks?.subscribeStop ?? defaults.subscribeStop,
    };
  }

  has(key: string): boolean {
    return this.sessions.has(key);
  }

  sessionMap(): Map<string, SessionState> {
    return this.sessions;
  }

  adopt(key: string, sessionId: string, sessionCwd: string): void {
    if (this.sessions.has(key)) return;
    const hooksFile = this.hooks.installHooks(sessionId);
    if (!hooksFile) return;
    const transcriptPath = path.join(
      this.transcriptRoot,
      encodeForClaudeProjects(sessionCwd),
      `${sessionId}.jsonl`,
    );
    this.sessions.set(key, {
      sessionId,
      sessionCwd,
      transcriptPath,
      transcriptOffset: currentFileSize(transcriptPath),
      hooksFile,
      systemPrompt: "",
      hasFirstTurn: true,
      currentPty: null,
      busy: false,
      cancelled: false,
    });
  }

  historyTurns(key: string): readonly ReplayTurn[] {
    const state = this.sessions.get(key);
    if (!state) return [];
    return extractConversationTurns(readTranscript(state.transcriptPath));
  }

  dispose(): void {
    for (const key of [...this.sessions.keys()]) this.kill(key);
  }

  reset(key: string): void {
    this.kill(key);
  }

  cancel(key: string): void {
    const state = this.sessions.get(key);
    if (!state) return;
    state.cancelled = true;
    if (state.currentPty) tryKillPty(state.currentPty);
  }

  async ask(
    key: string,
    message: string,
    systemPrompt: string,
    cwd: string | null,
    options: ChatTurnOptions = {},
  ): Promise<ChatTurnResult> {
    const state = this.ensure(key, systemPrompt, cwd);
    if (state.busy) throw new Error("Assistant is still finishing the previous turn.");
    state.busy = true;
    state.cancelled = false;
    let poller: ReturnType<typeof setInterval> | null = null;
    let submitTimer: ReturnType<typeof setTimeout> | null = null;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let lastEmittedJson = "";
    const startOffset = state.transcriptOffset;
    let child: ChatPty | null = null;
    try {
      const args = this.buildArgs(state, message, options.model, options.effort);
      child = this.ptySpawner.spawn(this.claudeBin, args, {
        name: "xterm-256color",
        cols: COLS,
        rows: ROWS,
        cwd: state.sessionCwd,
        env: process.env as { [key: string]: string },
      });
      state.currentPty = child;
      let submitted = false;
      const submit = (): void => {
        if (submitted || !child) return;
        submitted = true;
        tryWritePty(child, "\r");
      };
      child.onData(() => {
        if (submitted) return;
        if (quietTimer !== null) clearTimeout(quietTimer);
        quietTimer = setTimeout(submit, SUBMIT_QUIET_MS);
      });
      submitTimer = setTimeout(submit, READY_BEFORE_SUBMIT_MS);
      const exited = new Promise<void>((resolve) => {
        child!.onExit(() => resolve());
      });

      const stopPromise = this.waitForStop(state, exited);
      poller = setInterval(() => {
        if (!options.onProgress) return;
        const events = readEventsFrom(state.transcriptPath, startOffset);
        if (events.length === 0) return;
        const snapshot = JSON.stringify(events);
        if (snapshot === lastEmittedJson) return;
        lastEmittedJson = snapshot;
        options.onProgress(events);
      }, STREAM_POLL_MS);

      const reason = await stopPromise;
      state.hasFirstTurn = true;
      if (state.cancelled || reason === "cancel") {
        state.transcriptOffset = currentFileSize(state.transcriptPath);
        throw new Error("Cancelled.");
      }
      const events = await readFinalEvents(state.transcriptPath, startOffset);
      state.transcriptOffset = currentFileSize(state.transcriptPath);
      const text = concatTextEvents(events);
      if (events.length === 0 && text.length === 0) {
        throw new Error("The assistant didn't return a response. Please try again.");
      }
      return { events, text };
    } finally {
      if (poller !== null) clearInterval(poller);
      if (submitTimer !== null) clearTimeout(submitTimer);
      if (quietTimer !== null) clearTimeout(quietTimer);
      if (child) tryKillPty(child);
      state.currentPty = null;
      state.busy = false;
    }
  }

  buildArgsForTesting(key: string, message: string, model?: ModelChoice, effort?: EffortChoice): string[] | null {
    const state = this.sessions.get(key);
    if (!state) return null;
    return this.buildArgs(state, message, model, effort);
  }

  ensure(key: string, systemPrompt: string, cwd: string | null): SessionState {
    const existing = this.sessions.get(key);
    if (existing) {
      existing.systemPrompt = systemPrompt;
      return existing;
    }

    fs.mkdirSync(this.cwdRoot, { recursive: true });
    fs.mkdirSync(this.config.signalsDir, { recursive: true });
    fs.mkdirSync(this.config.hooksDir, { recursive: true });

    const sessionCwd = cwd ?? path.join(this.cwdRoot, encodeForFs(key));
    fs.mkdirSync(sessionCwd, { recursive: true });

    const sessionId = crypto.randomUUID();
    const hooksFile = this.hooks.installHooks(sessionId);
    if (!hooksFile) throw new Error("Could not install Stop hooks for the assistant session.");

    const transcriptPath = path.join(
      this.transcriptRoot,
      encodeForClaudeProjects(sessionCwd),
      `${sessionId}.jsonl`,
    );

    const state: SessionState = {
      sessionId,
      sessionCwd,
      transcriptPath,
      transcriptOffset: 0,
      hooksFile,
      systemPrompt,
      hasFirstTurn: false,
      currentPty: null,
      busy: false,
      cancelled: false,
    };
    this.sessions.set(key, state);
    return state;
  }

  private buildArgs(state: SessionState, message: string, model?: ModelChoice, effort?: EffortChoice): string[] {
    const base = state.hasFirstTurn
      ? ["--resume", state.sessionId, "--settings", state.hooksFile, "--dangerously-skip-permissions"]
      : [
          "--session-id", state.sessionId,
          "--settings", state.hooksFile,
          "--dangerously-skip-permissions",
          "--append-system-prompt", state.systemPrompt,
        ];
    const tuning: string[] = [];
    if (model && model !== "default") tuning.push("--model", model);
    const effortOk = effort !== undefined && effort !== "default" &&
      (model === undefined || model === "default" || modelEffortLevels(model).includes(effort));
    if (effortOk) tuning.push("--effort", effort);
    return [...this.claudeArgsPrefix, ...base, ...tuning, message];
  }

  private kill(key: string): void {
    const state = this.sessions.get(key);
    if (!state) return;
    this.sessions.delete(key);
    if (state.currentPty) tryKillPty(state.currentPty);
    this.hooks.removeHooks(state.sessionId);
  }

  private waitForStop(state: SessionState, exited: Promise<void>): Promise<StopReason> {
    return new Promise((resolve) => {
      let subscription: { dispose(): void } | null = null;
      let checkInterval: ReturnType<typeof setInterval> | null = null;
      let finished = false;
      const spawnTime = Date.now();
      const finish = (reason: StopReason): void => {
        if (finished) return;
        finished = true;
        if (subscription) subscription.dispose();
        if (checkInterval !== null) clearInterval(checkInterval);
        resolve(reason);
      };
      subscription = this.hooks.subscribeStop(state.sessionId, () => finish("stop"));
      if (finished) return;
      checkInterval = setInterval(() => {
        if (state.cancelled) finish("cancel");
      }, 250);
      void exited.then(() => {
        if (state.cancelled) { finish("cancel"); return; }
        const elapsed = Date.now() - spawnTime;
        const grace = Math.max(0, 2000 - elapsed);
        setTimeout(() => finish("exit"), grace);
      });
    });
  }
}

export const NODE_PTY_SPAWNER: ChatPtySpawner = {
  spawn: (file, args, options) => {
    const child = pty.spawn(file, [...args], {
      name: options.name,
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env as { [key: string]: string },
    });
    return {
      onData: (listener) => child.onData(listener),
      onExit: (listener) => child.onExit(() => listener()),
      write: (data) => child.write(data),
      kill: () => child.kill(),
    };
  },
};

const tryKillPty = (child: ChatPty): void => {
  try { child.kill(); } catch (err: unknown) { ignoreBestEffortFailure(err); }
};

const tryWritePty = (child: ChatPty, data: string): void => {
  try { child.write(data); } catch (err: unknown) { ignoreBestEffortFailure(err); }
};

const closeWatcher = (watcher: fs.FSWatcher | null): void => {
  try { watcher?.close(); } catch (err: unknown) { ignoreBestEffortFailure(err); }
};

const removeFile = (filePath: string): void => {
  try { fs.rmSync(filePath, { force: true }); } catch (err: unknown) { ignoreBestEffortFailure(err); }
};

const ignoreBestEffortFailure = (_err: unknown): void => {};

const currentFileSize = (filePath: string): number => {
  try { return fs.statSync(filePath).size; } catch { return 0; }
};

const readFinalEvents = async (
  filePath: string,
  startOffset: number,
): Promise<readonly TimelineEvent[]> => {
  const start = Date.now();
  let lastSize = currentFileSize(filePath);
  let lastGrowthAt = Date.now();
  for (;;) {
    await new Promise<void>((r) => setTimeout(r, FINAL_POLL_MS));
    const size = currentFileSize(filePath);
    if (size !== lastSize) { lastSize = size; lastGrowthAt = Date.now(); }
    const hasContent = size > startOffset;
    const stableMs = Date.now() - lastGrowthAt;
    if (hasContent && stableMs >= FINAL_STABLE_MS) {
      const events = readEventsFrom(filePath, startOffset);
      if (events.some((e) => e.kind === "text") || stableMs >= FINAL_STABLE_MS * 2) return events;
    }
    if (!hasContent && Date.now() - start >= FINAL_NO_CONTENT_MAX_MS) return [];
    if (Date.now() - start >= FINAL_MAX_WAIT_MS) return readEventsFrom(filePath, startOffset);
  }
};

export const readEventsFrom = (filePath: string, startOffset: number): readonly TimelineEvent[] => {
  if (!fs.existsSync(filePath)) return [];
  let buf: Buffer;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= startOffset) return [];
    const fd = fs.openSync(filePath, "r");
    try {
      buf = Buffer.alloc(stat.size - startOffset);
      fs.readSync(fd, buf, 0, buf.length, startOffset);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  return extractTimelineEvents(buf.toString("utf8"));
};

const readTranscript = (filePath: string): string => {
  try { return fs.readFileSync(filePath, "utf8"); } catch { return ""; }
};

export const makeFileSignalHooks = (
  signalsDir: string,
  hooksDir: string,
): ChatHooks => ({
  installHooks: (sessionId: string): string | null => {
    try {
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.mkdirSync(signalsDir, { recursive: true });
      const settings = buildCockpitHookSettings(sessionId, signalsDir);
      const file = path.join(hooksDir, `${sessionId}.json`);
      fs.writeFileSync(file, JSON.stringify(settings), "utf8");
      return file;
    } catch {
      return null;
    }
  },
  removeHooks: (sessionId: string): void => {
    for (const f of [
      path.join(hooksDir, `${sessionId}.json`),
      path.join(signalsDir, `${sessionId}.stop`),
      path.join(signalsDir, `${sessionId}.notify`),
      path.join(signalsDir, `${sessionId}.active`),
    ]) {
      removeFile(f);
    }
  },
  subscribeStop: (sessionId: string, listener: () => void): { dispose(): void } => {
    fs.mkdirSync(signalsDir, { recursive: true });
    const stopFile = path.join(signalsDir, `${sessionId}.stop`);
    removeFile(stopFile);
    let fired = false;
    const fire = (): void => {
      if (fired) return;
      fired = true;
      removeFile(stopFile);
      listener();
    };
    const check = (): void => {
      if (fs.existsSync(stopFile)) fire();
    };
    let watcher: fs.FSWatcher | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    try {
      watcher = fs.watch(signalsDir, (_event, filename) => {
        if (filename === path.basename(stopFile)) check();
      });
      watcher.on("error", () => {
        closeWatcher(watcher);
        watcher = null;
        pollTimer = setInterval(check, 500);
      });
    } catch {
      pollTimer = setInterval(check, 500);
    }
    check();
    return {
      dispose: () => {
        closeWatcher(watcher);
        if (pollTimer !== null) clearInterval(pollTimer);
      },
    };
  },
});
