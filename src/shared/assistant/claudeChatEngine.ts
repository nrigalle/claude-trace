import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as pty from "node-pty";
import { buildCockpitHookSettings } from "../../features/cockpit/infra/cockpitHooks";
import { PROJECTS_DIR } from "../config";
import type { EffortChoice, ModelChoice } from "../models";
import type { TimelineEvent } from "./timeline";

// A reusable engine that drives a real, resumable `claude` session per key,
// streams its transcript as a timeline, and resolves when the turn stops.
// Both the library "Help me write" assistant and the workflow assistant
// configure this engine; only their system prompt and reply parsing differ.

export type { TimelineEvent };

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
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly hooks?: Partial<ChatHooks>;
  readonly inactivityTimeoutMs?: number;
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
const TOOL_RESULT_PREVIEW_CHARS = 220;
const COLS = 120;
const ROWS = 40;
const INACTIVITY_TIMEOUT_MS = 120_000;
const WATCHDOG_POLL_MS = 2_000;

export type StopReason = "stop" | "exit" | "cancel" | "stuck";

export const encodeForClaudeProjects = (cwd: string): string =>
  cwd.replace(/[^a-zA-Z0-9-]/g, "-");

const encodeForFs = (key: string): string => key.replace(/[^A-Za-z0-9-]/g, "_");

export class ClaudeChatEngine {
  private readonly sessions = new Map<string, SessionState>();
  private readonly hooks: ChatHooks;
  private readonly claudeBin: string;
  private readonly claudeArgsPrefix: readonly string[];
  private readonly ptySpawner: ChatPtySpawner;
  private readonly cwdRoot: string;
  private readonly transcriptRoot: string;
  private readonly inactivityTimeoutMs: number;

  constructor(private readonly config: ClaudeChatConfig) {
    this.claudeBin = config.claudeBin ?? "claude";
    this.claudeArgsPrefix = config.claudeArgsPrefix ?? [];
    this.ptySpawner = config.ptySpawner ?? NODE_PTY_SPAWNER;
    this.cwdRoot = config.cwdRoot;
    this.transcriptRoot = config.transcriptRoot ?? PROJECTS_DIR;
    this.inactivityTimeoutMs = config.inactivityTimeoutMs ?? INACTIVITY_TIMEOUT_MS;
    const defaults = makeFileSignalHooks(config.signalsDir, config.hooksDir, config.allowedTools, config.disallowedTools);
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

  // Re-attach a session that was persisted in a previous run so the next turn
  // resumes the same claude conversation (--resume) instead of starting fresh.
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

  // The full transcript so far, for replaying a saved chat into the panel.
  history(key: string): readonly TimelineEvent[] {
    const state = this.sessions.get(key);
    if (!state) return [];
    return readEventsFrom(state.transcriptPath, 0);
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
      child.onData(() => {});
      submitTimer = setTimeout(() => {
        if (child) tryWritePty(child, "\r");
      }, READY_BEFORE_SUBMIT_MS);
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
      state.transcriptOffset = currentFileSize(state.transcriptPath);
      state.hasFirstTurn = true;
      if (state.cancelled || reason === "cancel") throw new Error("Cancelled.");
      if (reason === "stuck") {
        throw new Error(
          "The assistant stopped responding. It likely paused for input it can't receive here (an interactive prompt or a tool that needs approval). Your message wasn't lost, try sending it again or rephrasing.",
        );
      }
      const events = await readEventsWithRetry(state.transcriptPath, startOffset);
      const text = concatTextEvents(events);
      if (events.length === 0 && text.length === 0) {
        throw new Error("The assistant didn't return a response. Please try again.");
      }
      return { events, text };
    } finally {
      if (poller !== null) clearInterval(poller);
      if (submitTimer !== null) clearTimeout(submitTimer);
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
      ? ["--resume", state.sessionId, "--settings", state.hooksFile]
      : [
          "--session-id", state.sessionId,
          "--settings", state.hooksFile,
          "--append-system-prompt", state.systemPrompt,
        ];
    const tuning: string[] = [];
    if (model && model !== "default") tuning.push("--model", model);
    if (effort && effort !== "default") tuning.push("--effort", effort);
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
      let watchdog: ReturnType<typeof setInterval> | null = null;
      let finished = false;
      const spawnTime = Date.now();
      let lastSize = currentFileSize(state.transcriptPath);
      let lastGrowthAt = Date.now();
      const finish = (reason: StopReason): void => {
        if (finished) return;
        finished = true;
        if (subscription) subscription.dispose();
        if (checkInterval !== null) clearInterval(checkInterval);
        if (watchdog !== null) clearInterval(watchdog);
        resolve(reason);
      };
      subscription = this.hooks.subscribeStop(state.sessionId, () => finish("stop"));
      if (finished) return;
      checkInterval = setInterval(() => {
        if (state.cancelled) finish("cancel");
      }, 250);
      const timeout = this.inactivityTimeoutMs;
      watchdog = setInterval(() => {
        const size = currentFileSize(state.transcriptPath);
        if (size > lastSize) {
          lastSize = size;
          lastGrowthAt = Date.now();
          return;
        }
        if (Date.now() - lastGrowthAt >= timeout) finish("stuck");
      }, Math.min(WATCHDOG_POLL_MS, Math.max(50, timeout)));
      void exited.then(() => {
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
  try { child.kill(); } catch { return; }
};

const tryWritePty = (child: ChatPty, data: string): void => {
  try { child.write(data); } catch { return; }
};

const closeWatcher = (watcher: fs.FSWatcher | null): void => {
  try { watcher?.close(); } catch { return; }
};

const removeFile = (filePath: string): void => {
  try { fs.rmSync(filePath, { force: true }); } catch { return; }
};

const currentFileSize = (filePath: string): number => {
  try { return fs.statSync(filePath).size; } catch { return 0; }
};

const readEventsWithRetry = async (
  filePath: string,
  startOffset: number,
): Promise<readonly TimelineEvent[]> => {
  const delays = [50, 100, 200, 400, 800];
  let lastEvents: readonly TimelineEvent[] = [];
  for (let attempt = 0; attempt < delays.length + 1; attempt += 1) {
    const events = readEventsFrom(filePath, startOffset);
    if (events.some((e) => e.kind === "text")) return events;
    if (events.length > lastEvents.length) lastEvents = events;
    if (attempt < delays.length) await new Promise<void>((r) => setTimeout(r, delays[attempt]));
  }
  return lastEvents;
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

export const extractTimelineEvents = (jsonlChunk: string): readonly TimelineEvent[] => {
  const events: TimelineEvent[] = [];
  for (const line of jsonlChunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const obj = parseJsonLine(trimmed);
    if (obj === null) continue;
    pushEventsFromEntry(obj, events);
  }
  return events;
};

const parseJsonLine = (line: string): unknown | null => {
  try { return JSON.parse(line) as unknown; } catch { return null; }
};

const pushEventsFromEntry = (entry: unknown, out: TimelineEvent[]): void => {
  if (!entry || typeof entry !== "object") return;
  const e = entry as { type?: unknown; message?: unknown };
  if (e.type === "assistant" && e.message && typeof e.message === "object") {
    const content = (e.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown };
      if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
        out.push({ kind: "text", text: b.text });
      } else if (b.type === "tool_use" && typeof b.name === "string" && typeof b.id === "string") {
        out.push({ kind: "tool_use", id: b.id, name: b.name, input: previewToolInput(b.input) });
      }
    }
    return;
  }
  if (e.type === "user" && e.message && typeof e.message === "object") {
    const content = (e.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };
      if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      out.push({
        kind: "tool_result",
        toolUseId: b.tool_use_id,
        preview: previewToolResult(b.content),
        isError: b.is_error === true,
      });
    }
  }
};

const previewToolInput = (input: unknown): string => {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return truncate(input, TOOL_RESULT_PREVIEW_CHARS);
  const json = JSON.stringify(input);
  return typeof json === "string" ? truncate(json, TOOL_RESULT_PREVIEW_CHARS) : "";
};

const previewToolResult = (content: unknown): string => {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return truncate(content, TOOL_RESULT_PREVIEW_CHARS);
  if (Array.isArray(content)) {
    const text = content
      .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
        ? (c as { text: string }).text
        : ""))
      .filter((s) => s.length > 0)
      .join("\n");
    return truncate(text, TOOL_RESULT_PREVIEW_CHARS);
  }
  const json = JSON.stringify(content);
  return typeof json === "string" ? truncate(json, TOOL_RESULT_PREVIEW_CHARS) : "";
};

const truncate = (s: string, max: number): string => {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
};

export const concatTextEvents = (events: readonly TimelineEvent[]): string => {
  const hasTools = events.some((e) => e.kind === "tool_use");
  const pick = (subset: readonly TimelineEvent[]): string =>
    subset
      .filter((e): e is TimelineEvent & { kind: "text" } => e.kind === "text")
      .map((e) => e.text)
      .join("\n")
      .trim();
  if (!hasTools) return pick(events);
  let lastToolIdx = -1;
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]!;
    if (ev.kind === "tool_use" || ev.kind === "tool_result") lastToolIdx = i;
  }
  return pick(events.slice(lastToolIdx + 1));
};

export const makeFileSignalHooks = (
  signalsDir: string,
  hooksDir: string,
  allowedTools: readonly string[] = [],
  disallowedTools: readonly string[] = [],
): ChatHooks => ({
  installHooks: (sessionId: string): string | null => {
    try {
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.mkdirSync(signalsDir, { recursive: true });
      const base = buildCockpitHookSettings(sessionId, signalsDir);
      const settings = { ...base, permissions: { allow: allowedTools, deny: disallowedTools } };
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
    return {
      dispose: () => {
        closeWatcher(watcher);
        if (pollTimer !== null) clearInterval(pollTimer);
      },
    };
  },
});
