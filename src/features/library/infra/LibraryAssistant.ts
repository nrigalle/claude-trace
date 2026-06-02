import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as pty from "node-pty";
import { buildCockpitHookSettings } from "../../cockpit/infra/cockpitHooks";
import { TRACE_DATA_DIR, PROJECTS_DIR } from "../../../shared/config";
import type {
  AssistantContext,
  AssistantMode,
  TimelineEvent,
} from "../protocol";
import type { EffortChoice, ModelChoice } from "../../../shared/models";

export const encodeForClaudeProjects = (cwd: string): string =>
  cwd.replace(/[^a-zA-Z0-9-]/g, "-");

export interface AssistantResult {
  readonly events: readonly TimelineEvent[];
  readonly text: string;
  readonly suggestedDescription: string | null;
}

export interface AssistantOptions {
  readonly cwd?: string;
  readonly mode?: AssistantMode;
  readonly model?: ModelChoice;
  readonly effort?: EffortChoice;
  readonly onProgress?: (events: readonly TimelineEvent[]) => void;
}

export interface AssistantHooks {
  readonly installHooks: (sessionId: string) => string | null;
  readonly removeHooks: (sessionId: string) => void;
  readonly subscribeStop: (sessionId: string, listener: () => void) => { dispose(): void };
}

const ASSISTANT_CWD_ROOT = path.join(TRACE_DATA_DIR, "library-assistant");
const ASSISTANT_SIGNALS_DIR = path.join(TRACE_DATA_DIR, "library-assistant", "signals");
const ASSISTANT_HOOKS_DIR = path.join(TRACE_DATA_DIR, "library-assistant", "hooks");
const STREAM_POLL_MS = 500;
const READY_BEFORE_SUBMIT_MS = 1800;
const TOOL_RESULT_PREVIEW_CHARS = 220;
const DISALLOWED_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "Task", "Agent"];
const ALLOWED_TOOLS = ["WebSearch", "WebFetch", "Read", "Grep", "Glob", "TodoWrite"];
const COLS = 120;
const ROWS = 40;

interface ItemState {
  sessionId: string;
  sessionCwd: string;
  transcriptPath: string;
  transcriptOffset: number;
  hooksFile: string;
  systemPrompt: string;
  hasFirstTurn: boolean;
  currentPty: LibraryPty | null;
  busy: boolean;
  cancelled: boolean;
}

export interface LibraryPty {
  readonly onData: (listener: (data: string) => void) => unknown;
  readonly onExit: (listener: () => void) => unknown;
  readonly write: (data: string) => void;
  readonly kill: () => void;
}

export interface LibraryPtyOptions {
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string;
  readonly env: { readonly [key: string]: string };
}

export interface LibraryPtySpawner {
  readonly spawn: (file: string, args: readonly string[], options: LibraryPtyOptions) => LibraryPty;
}

export interface LibraryAssistantConfig {
  readonly claudeBin?: string;
  readonly claudeArgsPrefix?: readonly string[];
  readonly ptySpawner?: LibraryPtySpawner;
  readonly cwdRoot?: string;
  readonly transcriptRoot?: string;
  readonly hooks?: Partial<AssistantHooks>;
}

export class LibraryAssistant {
  private readonly items = new Map<string, ItemState>();
  private readonly assistantHooks: AssistantHooks;
  private readonly claudeBin: string;
  private readonly claudeArgsPrefix: readonly string[];
  private readonly ptySpawner: LibraryPtySpawner;
  private readonly cwdRoot: string;
  private readonly transcriptRoot: string;

  constructor(config: LibraryAssistantConfig = {}) {
    this.claudeBin = config.claudeBin ?? "claude";
    this.claudeArgsPrefix = config.claudeArgsPrefix ?? [];
    this.ptySpawner = config.ptySpawner ?? NODE_PTY_SPAWNER;
    this.cwdRoot = config.cwdRoot ?? ASSISTANT_CWD_ROOT;
    this.transcriptRoot = config.transcriptRoot ?? PROJECTS_DIR;
    this.assistantHooks = {
      installHooks: config.hooks?.installHooks ?? defaultInstallHooks,
      removeHooks: config.hooks?.removeHooks ?? defaultRemoveHooks,
      subscribeStop: config.hooks?.subscribeStop ?? defaultSubscribeStop,
    };
  }

  dispose(): void {
    for (const itemKey of [...this.items.keys()]) this.killItem(itemKey);
  }

  resetItem(itemKey: string): void {
    this.killItem(itemKey);
  }

  cancel(itemKey: string): void {
    const state = this.items.get(itemKey);
    if (!state) return;
    state.cancelled = true;
    if (state.currentPty) tryKillPty(state.currentPty);
  }

  async ask(
    context: AssistantContext,
    message: string,
    options: AssistantOptions = {},
  ): Promise<AssistantResult> {
    const state = this.ensureItem(context, options.mode ?? "writeBody");
    if (state.busy) throw new Error("Assistant is still finishing the previous turn.");
    state.busy = true;
    state.cancelled = false;
    let poller: ReturnType<typeof setInterval> | null = null;
    let submitTimer: ReturnType<typeof setTimeout> | null = null;
    let lastEmittedJson = "";
    const startOffset = state.transcriptOffset;
    let child: LibraryPty | null = null;
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

      const stopPromise = this.waitForStop(state.sessionId, state, exited);
      poller = setInterval(() => {
        if (!options.onProgress) return;
        const events = readEventsFrom(state.transcriptPath, startOffset);
        if (events.length === 0) return;
        const snapshot = JSON.stringify(events);
        if (snapshot === lastEmittedJson) return;
        lastEmittedJson = snapshot;
        options.onProgress(events);
      }, STREAM_POLL_MS);

      await stopPromise;
      const events = await readEventsWithRetry(state.transcriptPath, startOffset);
      state.transcriptOffset = currentFileSize(state.transcriptPath);
      state.hasFirstTurn = true;
      if (state.cancelled) throw new Error("Cancelled.");
      const text = concatTextEvents(events);
      const parsed = parseReply(text);
      return { events, text: parsed.text, suggestedDescription: parsed.suggestedDescription };
    } finally {
      if (poller !== null) clearInterval(poller);
      if (submitTimer !== null) clearTimeout(submitTimer);
      if (child) tryKillPty(child);
      state.currentPty = null;
      state.busy = false;
    }
  }

  private ensureItem(context: AssistantContext, mode: AssistantMode): ItemState {
    let state = this.items.get(context.itemKey);
    if (state) {
      state.systemPrompt = systemPromptFor(context, mode);
      return state;
    }

    fs.mkdirSync(this.cwdRoot, { recursive: true });
    fs.mkdirSync(ASSISTANT_SIGNALS_DIR, { recursive: true });
    fs.mkdirSync(ASSISTANT_HOOKS_DIR, { recursive: true });

    const sessionCwd = path.join(this.cwdRoot, encodeForFs(context.itemKey));
    fs.mkdirSync(sessionCwd, { recursive: true });

    const sessionId = crypto.randomUUID();
    const hooksFile = this.assistantHooks.installHooks(sessionId);
    if (!hooksFile) throw new Error("Could not install Stop hooks for the assistant session.");

    const transcriptPath = path.join(
      this.transcriptRoot,
      encodeForClaudeProjects(sessionCwd),
      `${sessionId}.jsonl`,
    );

    state = {
      sessionId,
      sessionCwd,
      transcriptPath,
      transcriptOffset: 0,
      hooksFile,
      systemPrompt: systemPromptFor(context, mode),
      hasFirstTurn: false,
      currentPty: null,
      busy: false,
      cancelled: false,
    };
    this.items.set(context.itemKey, state);
    return state;
  }

  buildArgsForTesting(itemKey: string, message: string, model?: ModelChoice, effort?: EffortChoice): string[] | null {
    const state = this.items.get(itemKey);
    if (!state) return null;
    return this.buildArgs(state, message, model, effort);
  }

  private buildArgs(state: ItemState, message: string, model?: ModelChoice, effort?: EffortChoice): string[] {
    const base = state.hasFirstTurn
      ? [
          "--resume", state.sessionId,
          "--settings", state.hooksFile,
        ]
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

  private killItem(itemKey: string): void {
    const state = this.items.get(itemKey);
    if (!state) return;
    this.items.delete(itemKey);
    if (state.currentPty) tryKillPty(state.currentPty);
    this.assistantHooks.removeHooks(state.sessionId);
  }

  private waitForStop(sessionId: string, state: ItemState, exited: Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      let subscription: { dispose(): void } | null = null;
      let checkInterval: ReturnType<typeof setInterval> | null = null;
      let finished = false;
      const spawnTime = Date.now();
      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (subscription) subscription.dispose();
        if (checkInterval !== null) clearInterval(checkInterval);
        resolve();
      };
      subscription = this.assistantHooks.subscribeStop(sessionId, finish);
      if (finished) return;
      checkInterval = setInterval(() => {
        if (state.cancelled) finish();
      }, 250);
      void exited.then(() => {
        const elapsed = Date.now() - spawnTime;
        const grace = Math.max(0, 2000 - elapsed);
        setTimeout(finish, grace);
      });
    });
  }
}

const encodeForFs = (key: string): string => key.replace(/[^A-Za-z0-9-]/g, "_");

const NODE_PTY_SPAWNER: LibraryPtySpawner = {
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

const tryKillPty = (child: LibraryPty): void => {
  try {
    child.kill();
  } catch {
    return;
  }
};

const tryWritePty = (child: LibraryPty, data: string): void => {
  try {
    child.write(data);
  } catch {
    return;
  }
};

const closeWatcher = (watcher: fs.FSWatcher | null): void => {
  try {
    watcher?.close();
  } catch {
    return;
  }
};

const removeFile = (filePath: string): void => {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    return;
  }
};

const currentFileSize = (filePath: string): number => {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
};

const readEventsWithRetry = async (
  filePath: string,
  startOffset: number,
): Promise<readonly TimelineEvent[]> => {
  const delays = [50, 100, 200, 400, 800];
  let lastEvents: readonly TimelineEvent[] = [];
  for (let attempt = 0; attempt < delays.length + 1; attempt += 1) {
    const events = readEventsFrom(filePath, startOffset);
    const hasText = events.some((e) => e.kind === "text");
    if (hasText) return events;
    if (events.length > lastEvents.length) lastEvents = events;
    if (attempt < delays.length) {
      await new Promise<void>((r) => setTimeout(r, delays[attempt]));
    }
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
  const lines = jsonlChunk.split(/\r?\n/);
  const events: TimelineEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const obj = parseJsonLine(trimmed);
    if (obj === null) continue;
    pushEventsFromEntry(obj, events);
  }
  return events;
};

const parseJsonLine = (line: string): unknown | null => {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
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
        out.push({
          kind: "tool_use",
          id: b.id,
          name: b.name,
          input: previewToolInput(b.input),
        });
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
  if (!hasTools) {
    return events
      .filter((e): e is TimelineEvent & { kind: "text" } => e.kind === "text")
      .map((e) => e.text)
      .join("\n")
      .trim();
  }
  let lastToolIdx = -1;
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]!;
    if (ev.kind === "tool_use" || ev.kind === "tool_result") lastToolIdx = i;
  }
  const trailing = events.slice(lastToolIdx + 1);
  return trailing
    .filter((e): e is TimelineEvent & { kind: "text" } => e.kind === "text")
    .map((e) => e.text)
    .join("\n")
    .trim();
};

export const parseReply = (text: string): { text: string; suggestedDescription: string | null } => {
  const lines = text.split(/\r?\n/);
  let suggestedDescription: string | null = null;
  const kept: string[] = [];
  for (const line of lines) {
    const match = /^SUGGESTED_DESCRIPTION:\s*(.+)$/.exec(line.trim());
    if (match && suggestedDescription === null) {
      suggestedDescription = match[1] ?? "";
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n").trim(), suggestedDescription };
};

export const systemPromptFor = (ctx: AssistantContext, mode: AssistantMode): string => {
  const kindLong = ctx.kind === "skill" ? "Claude Code Skill" : "Claude Code Subagent";
  const formatRules = ctx.kind === "skill" ? SKILL_FORMAT : AGENT_FORMAT;
  const attached = ctx.attachedSkills.length > 0
    ? `\nAttached skills (preloaded into this agent's context at startup): ${ctx.attachedSkills.join(", ")}`
    : "";
  const modeRules = mode === "writeBody" ? WRITE_BODY_RULES : DISCUSS_RULES;
  return [
    `You are an expert Claude Code author helping the user draft the BODY (markdown content under the YAML frontmatter) of a ${kindLong}.`,
    `The user is editing this ${ctx.kind} in the Claude Trace library at this moment.`,
    "",
    `Name: ${ctx.name}`,
    `Current description: ${ctx.description || "(empty)"}`,
    `${attached}`,
    "",
    "Current draft of the body:",
    "<current_body>",
    ctx.body && ctx.body.trim().length > 0 ? ctx.body : "(empty)",
    "</current_body>",
    "",
    "2026 Claude Code format reference:",
    formatRules,
    "",
    "Available tools: WebSearch, WebFetch, Read, Grep, Glob, TodoWrite. Use them when they genuinely help draft this content (e.g. WebSearch to confirm current best practices).",
    "Forbidden tools: Bash, Edit, Write, NotebookEdit, Task, Agent. These are removed from your context. Do NOT attempt them.",
    "",
    "Response rules:",
    modeRules,
    "Never invent frontmatter fields that do not exist in the 2026 spec. Use kebab-case for skill fields (allowed-tools, when_to_use, argument-hint) and camelCase for subagent fields (disallowedTools, permissionMode, maxTurns).",
    "If you have a strong suggestion for the description, put a separate line at the very end of your reply in this exact form (the UI parses it):",
    "SUGGESTED_DESCRIPTION: <your suggested description, one line>",
    "Only include that line when you have a meaningfully better description; otherwise omit it.",
    "Be terse. No filler. Production-grade voice: declarative, specific, no hedging.",
  ].join("\n");
};

const WRITE_BODY_RULES = [
  "1. The user has chosen 'Write to body' mode. The body field will be REPLACED with the text you emit AFTER your last tool call. That trailing text is the body. Nothing else (no preamble, no inline narration) is preserved.",
  "2. CRITICAL: every turn MUST end with a single closing text block containing the complete body markdown. Even if you used WebSearch / WebFetch / Read first, you MUST follow them with a final text block that IS the body. A turn that ends with only tool calls and no closing body text produces NOTHING for the user. That is a failure.",
  "3. No preamble. Do not say 'I'll research…' or 'Now let me write…' or 'Here is the body:' or 'I hope this helps'. Tool calls do your thinking; the final text block does your writing. The reader is the LLM that will run this skill/agent, not the user.",
  "4. Always emit the COMPLETE body in that final text block, not a diff or a patch. Multi-turn iteration means you rewrite the whole body each turn.",
  "5. When the user asks a clarifying question that would change the design, do not stall: use tools if helpful, then end with the body that reflects your best interpretation. The user can refine in the next turn.",
].join("\n");

const DISCUSS_RULES = [
  "1. The user has chosen 'Discuss' mode: respond conversationally. Your text will appear in the chat panel only; it will NOT be written to the body field.",
  "2. Help the user think through the design before generating. Ask clarifying questions when useful.",
  "3. When the user is ready to draft, tell them to switch to 'Write to body' mode.",
].join("\n");

const SKILL_FORMAT = [
  "- A skill is a directory containing SKILL.md (uppercase, case-sensitive).",
  "- The directory may carry scripts/, references/, assets/ alongside SKILL.md.",
  "- Frontmatter is YAML, kebab-case. Common fields: name, description, when_to_use, allowed-tools, argument-hint, model, disable-model-invocation (bool), user-invocable (bool).",
  "- Body is prose markdown: instructions for Claude to follow when invoking the skill.",
  "- A great skill body: starts with a one-line statement of when to invoke, then numbered steps or sections. Concrete heuristics, not vibes. Calls out edge cases. Cites file paths only as placeholders.",
].join("\n");

const AGENT_FORMAT = [
  "- A subagent is a single .md file with YAML frontmatter.",
  "- Fields: name, description, tools (comma list), disallowedTools, model (sonnet|opus|haiku|inherit), permissionMode (default|acceptEdits|plan|auto|dontAsk|bypassPermissions), maxTurns, skills (preload skill content).",
  "- The body IS the agent's system prompt. It replaces Claude Code's default system prompt entirely (only env info is appended).",
  "- A great agent body: opens with a one-line identity ('You are X. You do Y.'). Defines the persona, the inputs it expects, the deliverable it returns, and the explicit guardrails. Does not include conversational filler.",
].join("\n");

const defaultInstallHooks = (sessionId: string): string | null => {
  try {
    fs.mkdirSync(ASSISTANT_HOOKS_DIR, { recursive: true });
    fs.mkdirSync(ASSISTANT_SIGNALS_DIR, { recursive: true });
    const baseSettings = buildCockpitHookSettings(sessionId, ASSISTANT_SIGNALS_DIR);
    const settings = { ...baseSettings, permissions: { allow: ALLOWED_TOOLS, deny: DISALLOWED_TOOLS } };
    const file = path.join(ASSISTANT_HOOKS_DIR, `${sessionId}.json`);
    fs.writeFileSync(file, JSON.stringify(settings), "utf8");
    return file;
  } catch {
    return null;
  }
};

const defaultRemoveHooks = (sessionId: string): void => {
  for (const f of [
    path.join(ASSISTANT_HOOKS_DIR, `${sessionId}.json`),
    path.join(ASSISTANT_SIGNALS_DIR, `${sessionId}.stop`),
    path.join(ASSISTANT_SIGNALS_DIR, `${sessionId}.notify`),
    path.join(ASSISTANT_SIGNALS_DIR, `${sessionId}.active`),
  ]) {
    removeFile(f);
  }
};

const defaultSubscribeStop = (
  sessionId: string,
  listener: () => void,
): { dispose(): void } => {
  fs.mkdirSync(ASSISTANT_SIGNALS_DIR, { recursive: true });
  const stopFile = path.join(ASSISTANT_SIGNALS_DIR, `${sessionId}.stop`);
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
    watcher = fs.watch(ASSISTANT_SIGNALS_DIR, (_event, filename) => {
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
};
