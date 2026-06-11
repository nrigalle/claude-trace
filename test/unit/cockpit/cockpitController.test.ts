import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CockpitController,
  type TerminalBackend,
  type TerminalSpawnSpec,
} from "../../../src/features/cockpit/app/CockpitController";
import type { CockpitHostToWebview, CockpitWebviewToHost } from "../../../src/features/cockpit/protocol";
import type { ShellQuote } from "../../../src/shared/permissionModes";
import { ProfileStore } from "../../../src/features/cockpit/infra/ProfileStore";
import { CockpitSessionStore } from "../../../src/features/cockpit/infra/CockpitSessionStore";
import { CockpitTerminalHistoryStore } from "../../../src/features/cockpit/infra/CockpitTerminalHistoryStore";
import { defaultProfile, toProfileId, MAX_BATCH } from "../../../src/features/cockpit/domain/profiles";

class FakeHost {
  readonly posted: CockpitHostToWebview[] = [];
  private listener: ((m: CockpitWebviewToHost) => void) | null = null;
  postMessage(msg: CockpitHostToWebview): void {
    this.posted.push(msg);
  }
  onMessage(l: (m: CockpitWebviewToHost) => void): { dispose(): void } {
    this.listener = l;
    return { dispose: () => {} };
  }
  onDispose(): { dispose(): void } {
    return { dispose: () => {} };
  }
  send(msg: CockpitWebviewToHost): void {
    this.listener?.(msg);
  }
  lastState(): CockpitHostToWebview & { type: "cockpitState" } {
    for (let i = this.posted.length - 1; i >= 0; i--) {
      const m = this.posted[i]!;
      if (m.type === "cockpitState") return m;
    }
    throw new Error("no cockpitState posted");
  }
}

class FakeBackend implements TerminalBackend {
  readonly spawns: TerminalSpawnSpec[] = [];
  readonly writes: Array<{ id: string; data: string }> = [];
  readonly resizes: Array<{ id: string; cols: number; rows: number }> = [];
  readonly killed: string[] = [];
  readonly alive = new Set<string>();
  readonly capturedHistory = new Map<string, string | null>();
  readonly redrawn: string[] = [];
  redrawResult = true;
  private dataListener: ((id: string, data: string) => void) | null = null;
  private exitListener: ((id: string, code: number) => void) | null = null;
  spawn(spec: TerminalSpawnSpec): void {
    this.spawns.push(spec);
    this.alive.add(spec.sessionId);
  }
  shellQuoteStyle(): ShellQuote {
    return "posix";
  }
  write(id: string, data: string): void {
    this.writes.push({ id, data });
  }
  resize(id: string, cols: number, rows: number): void {
    this.resizes.push({ id, cols, rows });
  }
  kill(id: string): void {
    this.killed.push(id);
    this.alive.delete(id);
  }
  isAlive(id: string): boolean {
    return this.alive.has(id);
  }
  captureHistory(id: string): string | null {
    return this.capturedHistory.get(id) ?? null;
  }
  forceRedraw(id: string): boolean {
    this.redrawn.push(id);
    return this.redrawResult;
  }
  onData(l: (id: string, data: string) => void): { dispose(): void } {
    this.dataListener = l;
    return { dispose: () => {} };
  }
  onExit(l: (id: string, code: number) => void): { dispose(): void } {
    this.exitListener = l;
    return { dispose: () => {} };
  }
  emitData(id: string, data: string): void {
    this.dataListener?.(id, data);
  }
  emitExit(id: string, code: number): void {
    this.alive.delete(id);
    this.exitListener?.(id, code);
  }
  dispose(): void {}
}

let dir: string;
let store: ProfileStore;
let sessionStore: CockpitSessionStore;
let terminalHistoryStore: CockpitTerminalHistoryStore;
let host: FakeHost;
let backend: FakeBackend;
let names: Map<string, string>;
let idSeq: number;
let cleanedHooks: string[];
let attentionListener: ((sessionId: string, reason: "stop" | "notify" | "active" | "start") => void) | null;
let savedLayout: import("../../../src/features/cockpit/protocol").CockpitLayout;
let folderPickerResult: string | null;
const NOW = 9_000_000;

const makeController = (): CockpitController =>
  new CockpitController({
    host,
    profileStore: store,
    sessionStore,
    terminalHistoryStore,
    terminals: backend,
    actions: {
      setName: (id, name) => names.set(id, name),
      defaultCwd: () => "/repo",
      newSessionId: () => `uuid-${++idSeq}`,
      prepareHooks: (id) => `/hooks/${id}.json`,
      cleanupHooks: (id) => cleanedHooks.push(id),
      watchAttention: (listener) => {
        attentionListener = listener;
        return { dispose: () => { attentionListener = null; } };
      },
      saveDroppedImage: (fileName) => `/tmp/dropped/${fileName}`,
      loadCockpitLayout: () => savedLayout,
      saveCockpitLayout: (layout) => { savedLayout = layout; },
      pickFolder: async (_ctx) => folderPickerResult,
      now: () => NOW,
    },
  });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-termctl-"));
  store = new ProfileStore(path.join(dir, "cockpit.json"));
  sessionStore = new CockpitSessionStore(path.join(dir, "cockpit-sessions.json"));
  terminalHistoryStore = new CockpitTerminalHistoryStore(path.join(dir, "terminal-history"));
  host = new FakeHost();
  backend = new FakeBackend();
  names = new Map();
  idSeq = 0;
  cleanedHooks = [];
  attentionListener = null;
  savedLayout = { trees: {} };
  folderPickerResult = null;
  makeController();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("CockpitController launch", () => {
  beforeEach(() => {
    store.saveProfile({ ...defaultProfile(toProfileId("p1"), "Critic"), model: "claude-opus-4-7" });
  });

  it("launches with a pre-assigned --session-id, --model and --name", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 2, promptOverride: null });
    expect(backend.spawns).toHaveLength(2);
    expect(backend.spawns[0]!.initialInput).toContain("--session-id uuid-1");
    expect(backend.spawns[0]!.initialInput).toContain("--model 'claude-opus-4-7'");
    expect(backend.spawns[0]!.initialInput).toContain("--name 'Critic 1'");
    expect(backend.spawns[0]!.initialInput.endsWith("\r")).toBe(true);
    expect(backend.spawns[0]!.cwd).toBe("/repo");
  });

  it("names each session under its own id and reflects them alive in state", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 2, promptOverride: null });
    expect(names.get("uuid-1")).toBe("Critic 1");
    expect(names.get("uuid-2")).toBe("Critic 2");
    const terminals = host.lastState().state.terminals;
    expect(terminals.map((t) => t.name)).toEqual(["Critic 1", "Critic 2"]);
    expect(terminals.map((t) => t.sessionId)).toEqual(["uuid-1", "uuid-2"]);
    expect(terminals.every((t) => t.alive)).toBe(true);
  });

  it("continues numbering across launches with no name collisions", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 2, promptOverride: null });
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 2, promptOverride: null });
    expect(names.size).toBe(4);
    expect([...names.values()]).toEqual(["Critic 1", "Critic 2", "Critic 3", "Critic 4"]);
  });

  it("clamps an absurd count to the batch ceiling", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 999, promptOverride: null });
    expect(backend.spawns).toHaveLength(8);
  });

  it("delivers a prompt override as a bracketed paste on start, then submits with a SEPARATE delayed CR", () => {
    vi.useFakeTimers();
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: "review the diff" });
    expect(backend.spawns[0]!.initialInput).not.toContain("review the diff");
    expect(backend.writes).toHaveLength(0);
    attentionListener!("uuid-1", "start");
    expect(backend.writes).toContainEqual({ id: "uuid-1", data: "\u001b[200~review the diff\u001b[201~" });
    expect(backend.writes).toHaveLength(1);
    vi.advanceTimersByTime(400);
    expect(backend.writes).toContainEqual({ id: "uuid-1", data: "\r" });
    attentionListener!("uuid-1", "start");
    vi.advanceTimersByTime(400);
    expect(backend.writes, "a second start signal must not re-deliver").toHaveLength(2);
    vi.useRealTimers();
  });

  it("warns instead of spawning when the profile is gone", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("ghost"), count: 1, promptOverride: null });
    expect(backend.spawns).toHaveLength(0);
    expect(host.posted.some((m) => m.type === "cockpitNotice" && m.level === "error")).toBe(true);
  });

  it("injects per-session --settings so the Stop/Notification hooks are wired at launch", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
    expect(backend.spawns[0]!.initialInput).toContain("--settings '/hooks/uuid-1.json'");
  });
});

describe("CockpitController hook-driven attention — deterministic done/needs-you signal", () => {
  beforeEach(() => {
    store.saveProfile(defaultProfile(toProfileId("p1"), "Rev"));
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
  });

  it("a Stop signal tells the webview to light up that exact tile (no OS/editor notification fired)", () => {
    attentionListener!("uuid-1", "stop");
    expect(host.posted.some((m) => m.type === "terminalAttention" && m.sessionId === "uuid-1" && m.reason === "stop")).toBe(true);
  });

  it("ignores signals for sessions it no longer manages", () => {
    attentionListener!("ghost-session", "notify");
    expect(host.posted.some((m) => m.type === "terminalAttention")).toBe(false);
  });

  it("keeps lighting the tile on every signal", () => {
    attentionListener!("uuid-1", "stop");
    attentionListener!("uuid-1", "stop");
    const lit = host.posted.filter((m) => m.type === "terminalAttention" && m.sessionId === "uuid-1");
    expect(lit.length).toBe(2);
  });

  it("tells the webview when the agent becomes ACTIVE again (UserPromptSubmit) so the border clears", () => {
    attentionListener!("uuid-1", "stop");
    attentionListener!("uuid-1", "active");
    expect(host.posted.some((m) => m.type === "terminalActive" && m.sessionId === "uuid-1")).toBe(true);
  });

  it("REALISTIC agentic loop: PreToolUse activity keeps clearing the border so it never lingers while the agent works", () => {
    attentionListener!("uuid-1", "active");
    attentionListener!("uuid-1", "active");
    attentionListener!("uuid-1", "active");
    attentionListener!("uuid-1", "stop");
    attentionListener!("uuid-1", "active");
    const activeMsgs = host.posted.filter((m) => m.type === "terminalActive").length;
    expect(activeMsgs).toBeGreaterThanOrEqual(4);
  });

  it("REALISTIC multi-session: each window's tile lights independently", () => {
    store.saveProfile(defaultProfile(toProfileId("p2"), "Worker"));
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p2"), count: 1, promptOverride: null });
    attentionListener!("uuid-1", "stop");
    attentionListener!("uuid-2", "stop");
    const lit = host.posted.filter((m) => m.type === "terminalAttention");
    expect(lit.map((m) => (m as { sessionId: string }).sessionId)).toEqual(["uuid-1", "uuid-2"]);
  });

  it("cleans up the session's hook files when the terminal is closed", () => {
    host.send({ type: "terminalClose", sessionId: "uuid-1" });
    expect(cleanedHooks).toContain("uuid-1");
  });
});

describe("CockpitController layout persistence (per-folder window display survives reload)", () => {
  it("sends the saved layout to the webview on cockpitReady", () => {
    savedLayout = { trees: { __all__: { kind: "split", dir: "row", sizes: [2, 1], children: [{ kind: "leaf", id: "uuid-1" }, { kind: "leaf", id: "uuid-2" }] } } };
    backend = new FakeBackend();
    host = new FakeHost();
    makeController();
    host.send({ type: "cockpitReady" });
    const layoutMsg = host.posted.find((m) => m.type === "cockpitLayout");
    expect(layoutMsg).toBeDefined();
    expect(layoutMsg).toMatchObject({ type: "cockpitLayout", layout: savedLayout });
  });

  it("persists layout the webview sends via cockpitSaveLayout", () => {
    const layout = { trees: { test: { kind: "leaf" as const, id: "w1" } } };
    host.send({ type: "cockpitSaveLayout", layout });
    expect(savedLayout).toEqual(layout);
  });
});

describe("CockpitController image drop", () => {
  beforeEach(() => {
    store.saveProfile(defaultProfile(toProfileId("p1"), "Rev"));
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
  });

  it("writes the dropped image to disk and types its quoted path into the terminal", () => {
    host.send({ type: "cockpitDropImage", sessionId: "uuid-1", fileName: "shot.png", dataBase64: "AAAA" });
    expect(backend.writes).toContainEqual({ id: "uuid-1", data: " '/tmp/dropped/shot.png' " });
  });
});

describe("CockpitController terminal IO", () => {
  beforeEach(() => {
    store.saveProfile(defaultProfile(toProfileId("p1"), "Work"));
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
  });

  it("forwards webview keystrokes to the matching PTY", () => {
    host.send({ type: "terminalInput", sessionId: "uuid-1", data: "ls\r" });
    expect(backend.writes).toContainEqual({ id: "uuid-1", data: "ls\r" });
  });

  it("forwards resize to the PTY", () => {
    host.send({ type: "terminalResize", sessionId: "uuid-1", cols: 120, rows: 40 });
    expect(backend.resizes).toContainEqual({ id: "uuid-1", cols: 120, rows: 40 });
  });

  it("streams PTY output to the webview as terminalData", () => {
    backend.emitData("uuid-1", "hello\r\n");
    expect(host.posted).toContainEqual({ type: "terminalData", sessionId: "uuid-1", data: "hello\r\n" });
  });

  it("replays buffered terminal output in order after cockpitReady so a recreated webview does not lose recent history", () => {
    backend.emitData("uuid-1", "first\r\n");
    backend.emitData("uuid-1", "second\r\n");
    host.posted.length = 0;
    host.send({ type: "cockpitReady" });
    const messages = host.posted.filter((m) => m.type === "terminalData");
    expect(messages).toEqual([
      { type: "terminalData", sessionId: "uuid-1", data: "first\r\nsecond\r\n", replay: true },
    ]);
    const stateIndex = host.posted.findIndex((m) => m.type === "cockpitState");
    const replayIndex = host.posted.findIndex((m) => m.type === "terminalData");
    expect(stateIndex).toBeGreaterThanOrEqual(0);
    expect(replayIndex).toBeGreaterThan(stateIndex);
  });

  it("does not replay terminal history after the session is closed", () => {
    backend.emitData("uuid-1", "old output\r\n");
    host.send({ type: "terminalClose", sessionId: "uuid-1" });
    host.posted.length = 0;
    host.send({ type: "cockpitReady" });
    expect(host.posted.some((m) => m.type === "terminalData")).toBe(false);
  });

  it("a fresh controller after reload replays persisted terminal output instead of losing it", () => {
    backend.emitData("uuid-1", "before reload\r\n");
    backend = new FakeBackend();
    host = new FakeHost();
    makeController();
    host.send({ type: "cockpitReady" });
    expect(host.posted).toContainEqual({ type: "terminalData", sessionId: "uuid-1", data: "before reload\r\n", replay: true });
  });

  it("prefers backend text capture on reload so tmux-backed Codex sessions do not replay raw control-code logs", () => {
    backend.emitData("uuid-1", "\x1b[?1049h\x1b[3Jcodex screen");
    backend = new FakeBackend();
    backend.capturedHistory.set("uuid-1", "earlier codex text\r\nlatest codex text\r\n");
    host = new FakeHost();
    makeController();
    host.send({ type: "cockpitReady" });
    const messages = host.posted.filter((m) => m.type === "terminalData");
    expect(messages).toEqual([
      { type: "terminalData", sessionId: "uuid-1", data: "earlier codex text\r\nlatest codex text\r\n", replay: true },
    ]);
  });

  it("does not fall back to raw escape-code logs when tmux reports an active alternate screen", () => {
    backend.emitData("uuid-1", "\x1b[?1049h\x1b[2J\x1b[3Jcodex tui frame");
    backend = new FakeBackend();
    backend.capturedHistory.set("uuid-1", "");
    host = new FakeHost();
    makeController();
    host.send({ type: "cockpitReady" });
    expect(host.posted.some((m) => m.type === "terminalData")).toBe(false);
  });

  it("on PTY exit, emits terminalExit and flips the session to not-alive in state", () => {
    backend.emitExit("uuid-1", 0);
    expect(host.posted.some((m) => m.type === "terminalExit" && m.sessionId === "uuid-1")).toBe(true);
    const terminal = host.lastState().state.terminals.find((t) => t.sessionId === "uuid-1")!;
    expect(terminal.alive).toBe(false);
    expect(terminal.exitCode).toBe(0);
  });
});

describe("CockpitController profiles", () => {
  it("rejects an invalid profile and does not persist it", () => {
    host.send({
      type: "cockpitSaveProfile",
      profile: { ...defaultProfile(toProfileId("bad"), ""), defaultCount: 0 },
    });
    expect(host.posted.some((m) => m.type === "cockpitProfileInvalid")).toBe(true);
    expect(store.load().profiles).toHaveLength(0);
  });
});

describe("CockpitController persistence and resume — a session NEVER vanishes on reload", () => {
  beforeEach(() => {
    store.saveProfile({ ...defaultProfile(toProfileId("p1"), "Rev"), model: "claude-opus-4-7", spaceId: null });
  });

  it("persists every launched session to disk IMMEDIATELY at launch (no async dependency)", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 2, promptOverride: null });
    const saved = sessionStore.load();
    expect(saved.map((s) => s.id)).toEqual(["uuid-1", "uuid-2"]);
    expect(saved.map((s) => s.name)).toEqual(["Rev 1", "Rev 2"]);
  });

  it("a fresh controller (RELOAD) restores persisted sessions with the SAME id and auto-resumes them", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
    backend = new FakeBackend();
    host = new FakeHost();
    makeController();
    host.send({ type: "cockpitReady" });
    expect(backend.spawns).toHaveLength(1);
    expect(backend.spawns[0]!.initialInput).toContain("claude --resume uuid-1");
    expect(backend.spawns[0]!.initialInput).toContain("--name 'Rev 1'");
    const terminals = host.lastState().state.terminals;
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.sessionId).toBe("uuid-1");
    expect(terminals[0]!.name).toBe("Rev 1");
    expect(terminals[0]!.alive).toBe(true);
  });

  it("always resumes with --resume (never reuses --session-id, which claude rejects as 'already used')", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
    backend = new FakeBackend();
    host = new FakeHost();
    makeController();
    host.send({ type: "cockpitReady" });
    expect(backend.spawns[0]!.initialInput).toContain("--resume uuid-1");
    expect(backend.spawns[0]!.initialInput).not.toContain("--session-id");
  });

  it("Resume after a session exits re-runs claude with --resume, not a duplicate --session-id", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
    backend.emitExit("uuid-1", 0);
    const before = backend.spawns.length;
    host.send({ type: "cockpitResumeSession", sessionId: "uuid-1" });
    expect(backend.spawns.length).toBe(before + 1);
    const resumed = backend.spawns[backend.spawns.length - 1]!;
    expect(resumed.sessionId).toBe("uuid-1");
    expect(resumed.initialInput).toContain("--resume uuid-1");
    expect(resumed.initialInput).not.toContain("--session-id");
  });

  it("moving a session to a folder updates its space and persists it (survives reload in that folder)", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
    host.send({ type: "cockpitMoveSession", sessionId: "uuid-1", spaceId: "space-x" });
    expect(host.lastState().state.terminals[0]!.spaceId).toBe("space-x");
    expect(sessionStore.load()[0]!.spaceId).toBe("space-x");
  });

  it("dismissing a session removes it from disk so it does NOT come back on reload", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
    expect(sessionStore.load()).toHaveLength(1);
    host.send({ type: "terminalClose", sessionId: "uuid-1" });
    expect(sessionStore.load()).toHaveLength(0);
    backend = new FakeBackend();
    host = new FakeHost();
    makeController();
    host.send({ type: "cockpitReady" });
    expect(host.lastState().state.terminals).toHaveLength(0);
  });

  it("each launched session is its own window (own windowId)", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 2, promptOverride: null });
    const terminals = host.lastState().state.terminals;
    expect(terminals.map((t) => t.windowId)).toEqual(["uuid-1", "uuid-2"]);
    expect(terminals.every((t) => t.windowId === t.sessionId)).toBe(true);
  });
});

describe("CockpitController tabs — adding a tab clones the window's config into the same window", () => {
  beforeEach(() => {
    store.saveProfile({ ...defaultProfile(toProfileId("p1"), "Rev"), model: "claude-opus-4-7", permissionMode: "plan", spaceId: null });
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
  });

  it("spawns a new terminal sharing the window's id, model, permission mode and cwd", () => {
    host.send({ type: "cockpitAddTab", windowId: "uuid-1" });
    expect(backend.spawns).toHaveLength(2);
    const tab = backend.spawns[1]!;
    expect(tab.sessionId).toBe("uuid-2");
    expect(tab.cwd).toBe("/repo");
    expect(tab.initialInput).toContain("--model 'claude-opus-4-7'");
    expect(tab.initialInput).toContain("plan");
    const terminals = host.lastState().state.terminals;
    expect(terminals).toHaveLength(2);
    expect(terminals.every((t) => t.windowId === "uuid-1")).toBe(true);
    expect(terminals[1]!.name).toBe("Rev 1 · 2");
  });

  it("adding tabs increments the suffix · 2, · 3, · 4 instead of repeating · 2", () => {
    host.send({ type: "cockpitAddTab", windowId: "uuid-1" });
    host.send({ type: "cockpitAddTab", windowId: "uuid-1" });
    host.send({ type: "cockpitAddTab", windowId: "uuid-1" });
    const names = host.lastState().state.terminals.map((t) => t.name);
    expect(names).toEqual(["Rev 1", "Rev 1 · 2", "Rev 1 · 3", "Rev 1 · 4"]);
  });

  it("keeps incrementing (no double suffix) after the base tab is closed", () => {
    host.send({ type: "cockpitAddTab", windowId: "uuid-1" });
    host.send({ type: "cockpitAddTab", windowId: "uuid-1" });
    host.send({ type: "terminalClose", sessionId: "uuid-1" });
    host.send({ type: "cockpitAddTab", windowId: "uuid-1" });
    const names = host.lastState().state.terminals.map((t) => t.name);
    expect(names).toContain("Rev 1 · 4");
    expect(names.some((n) => n.includes("· 2 ·") || n.includes("· 3 ·"))).toBe(false);
  });

  it("the added tab persists and is restored into the same window on reload", () => {
    host.send({ type: "cockpitAddTab", windowId: "uuid-1" });
    const saved = sessionStore.load();
    expect(saved).toHaveLength(2);
    expect(saved.every((s) => s.windowId === "uuid-1")).toBe(true);
    backend = new FakeBackend();
    host = new FakeHost();
    makeController();
    host.send({ type: "cockpitReady" });
    const terminals = host.lastState().state.terminals;
    expect(terminals).toHaveLength(2);
    expect(terminals.every((t) => t.windowId === "uuid-1")).toBe(true);
  });
});

describe("CockpitController quick launch — no saved profile required", () => {
  it("launches directly from inline config and persists the session", () => {
    host.send({
      type: "cockpitQuickLaunch",
      name: "Scratch",
      model: "claude-opus-4-7",
      permissionMode: "plan",
      cwd: null,
      spaceId: "space-y",
      count: 1,
      prompt: "go",
    });
    expect(backend.spawns).toHaveLength(1);
    expect(backend.spawns[0]!.initialInput).toContain("--name 'Scratch'");
    expect(backend.spawns[0]!.initialInput).toContain("--model 'claude-opus-4-7'");
    expect(backend.spawns[0]!.initialInput).not.toContain("'go'");
    vi.useFakeTimers();
    attentionListener!("uuid-1", "start");
    expect(backend.writes).toContainEqual({ id: "uuid-1", data: "\u001b[200~go\u001b[201~" });
    vi.advanceTimersByTime(400);
    expect(backend.writes).toContainEqual({ id: "uuid-1", data: "\r" });
    vi.useRealTimers();
    expect(backend.spawns[0]!.cwd).toBe("/repo");
    const terminals = host.lastState().state.terminals;
    expect(terminals[0]!.spaceId).toBe("space-y");
    expect(sessionStore.load()).toHaveLength(1);
  });

  it("numbers multiple quick-launched terminals", () => {
    host.send({
      type: "cockpitQuickLaunch",
      name: "Scratch",
      model: "default",
      permissionMode: "default",
      cwd: null,
      spaceId: null,
      count: 3,
      prompt: null,
    });
    expect(backend.spawns).toHaveLength(3);
    expect([...names.values()]).toEqual(["Scratch 1", "Scratch 2", "Scratch 3"]);
  });

  it("clamps an absurd quick-launch count to the batch maximum", () => {
    host.send({
      type: "cockpitQuickLaunch",
      name: "Scratch",
      model: "default",
      permissionMode: "default",
      cwd: null,
      spaceId: null,
      count: 999,
      prompt: null,
    });
    expect(backend.spawns).toHaveLength(MAX_BATCH);
  });
});

describe("CockpitController plain shell terminals", () => {
  it("opens a shell with no claude command, named Terminal, kind shell", () => {
    host.send({ type: "cockpitNewTerminal", spaceId: null });
    expect(backend.spawns).toHaveLength(1);
    expect(backend.spawns[0]!.initialInput).toBe("");
    const t = host.lastState().state.terminals[0]!;
    expect(t.name).toBe("Terminal");
    expect(t.kind).toBe("shell");
  });

  it("numbers further shells and drops them in the active folder", () => {
    host.send({ type: "cockpitNewTerminal", spaceId: null });
    host.send({ type: "cockpitNewTerminal", spaceId: "space-a" });
    const names = host.lastState().state.terminals.map((t) => t.name);
    expect(names).toEqual(["Terminal", "Terminal 2"]);
    expect(host.lastState().state.terminals[1]!.spaceId).toBe("space-a");
  });

  it("reattaches a closed shell with no claude command on resume", () => {
    host.send({ type: "cockpitNewTerminal", spaceId: null });
    const id = host.lastState().state.terminals[0]!.sessionId;
    backend.emitExit(id, 0);
    host.send({ type: "cockpitResumeSession", sessionId: id });
    const resumeSpawn = backend.spawns.at(-1)!;
    expect(resumeSpawn.sessionId).toBe(id);
    expect(resumeSpawn.initialInput).toBe("");
  });

  it("a plain shell terminal keeps its output history across a controller reload", () => {
    host.send({ type: "cockpitNewTerminal", spaceId: null });
    const id = host.lastState().state.terminals[0]!.sessionId;
    backend.emitData(id, "shell line 1\r\n");
    backend.emitData(id, "shell line 2\r\n");
    backend = new FakeBackend();
    host = new FakeHost();
    makeController();
    host.send({ type: "cockpitReady" });
    const replay = host.posted.filter((m) => m.type === "terminalData").map((m) => m.data).join("");
    expect(replay).toBe("shell line 1\r\nshell line 2\r\n");
  });
});

describe("CockpitController shell-keepalive for claude sessions", () => {
  beforeEach(() => {
    store.saveProfile(defaultProfile(toProfileId("p1"), "Worker"));
  });

  it("runs claude as a child of the shell, never exec-replacing it", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
    expect(backend.spawns[0]!.initialInput).toContain("claude");
    expect(backend.spawns[0]!.initialInput).not.toContain("exec ");
  });

  it("pause marks the session not alive immediately and resume forces a fresh claude command", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
    const id = host.lastState().state.terminals[0]!.sessionId;
    host.send({ type: "cockpitPauseSession", sessionId: id });
    expect(host.lastState().state.terminals[0]!.alive).toBe(false);

    host.send({ type: "cockpitResumeSession", sessionId: id });
    const resumeSpawn = backend.spawns.at(-1)!;
    expect(resumeSpawn.sessionId).toBe(id);
    expect(resumeSpawn.initialInput).toContain("claude");
    expect(resumeSpawn.forceInitialInput).toBe(true);
  });
});

describe("CockpitController detach tab into its own window", () => {
  beforeEach(() => {
    store.saveProfile(defaultProfile(toProfileId("p1"), "Worker"));
  });

  it("moves a tab out of a shared window into a window of its own", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
    const first = host.lastState().state.terminals[0]!;
    host.send({ type: "cockpitAddTab", windowId: first.windowId });
    const tab = host.lastState().state.terminals.find((t) => t.sessionId !== first.sessionId)!;
    expect(tab.windowId).toBe(first.windowId);

    host.send({ type: "cockpitDetachTab", sessionId: tab.sessionId });
    const detached = host.lastState().state.terminals.find((t) => t.sessionId === tab.sessionId)!;
    expect(detached.windowId).toBe(tab.sessionId);
    expect(host.lastState().state.terminals.find((t) => t.sessionId === first.sessionId)!.windowId).toBe(first.windowId);
  });

  it("leaves a single-tab window untouched (it is already its own window)", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
    const only = host.lastState().state.terminals[0]!;
    const before = host.posted.length;
    host.send({ type: "cockpitDetachTab", sessionId: only.sessionId });
    expect(host.posted.length).toBe(before);
  });
});

describe("CockpitController adopt a resumed session into the active folder", () => {
  it("places the adopted session in the given folder (and thus in All too)", () => {
    host.send({ type: "cockpitAdoptSession", sessionId: "r1", name: "Resumed", cwd: "/repo", spaceId: "space-x" });
    const t = host.lastState().state.terminals.find((s) => s.sessionId === "r1")!;
    expect(t.spaceId).toBe("space-x");
    expect(t.kind).toBe("claude");
  });

  it("adopts into no folder when resumed from All (null spaceId)", () => {
    host.send({ type: "cockpitAdoptSession", sessionId: "r2", name: "Resumed", cwd: "/repo", spaceId: null });
    expect(host.lastState().state.terminals.find((s) => s.sessionId === "r2")!.spaceId).toBeNull();
  });

  it("re-adopting the same session into a different folder moves it there", () => {
    host.send({ type: "cockpitAdoptSession", sessionId: "r3", name: "Resumed", cwd: "/repo", spaceId: "space-x" });
    host.send({ type: "cockpitAdoptSession", sessionId: "r3", name: "Resumed", cwd: "/repo", spaceId: "space-y" });
    expect(host.lastState().state.terminals.find((s) => s.sessionId === "r3")!.spaceId).toBe("space-y");
  });

  it("does not auto-start the adopted session: it waits on the resume overlay so the user picks the permission mode", () => {
    host.send({ type: "cockpitAdoptSession", sessionId: "r4", name: "Resumed", cwd: "/repo", spaceId: null, modelId: "claude-opus-4-7" });
    expect(backend.spawns).toHaveLength(0);
    expect(host.lastState().state.terminals.find((s) => s.sessionId === "r4")!.alive).toBe(false);
  });

  it("restores the session's ORIGINAL model on resume instead of forcing the default (regression: every resume ran on opus-4-8)", () => {
    host.send({ type: "cockpitAdoptSession", sessionId: "r5", name: "Resumed", cwd: "/repo", spaceId: null, modelId: "claude-opus-4-7" });
    host.send({ type: "cockpitResumeSession", sessionId: "r5", permissionMode: "plan" });
    expect(backend.spawns).toHaveLength(1);
    const cmd = backend.spawns[0]!.initialInput;
    expect(cmd).toContain("--resume r5");
    expect(cmd).toContain("--model 'claude-opus-4-7'");
    expect(cmd).not.toContain("claude-opus-4-8");
  });

  it("falls back to the default model only when the transcript carries no model id", () => {
    host.send({ type: "cockpitAdoptSession", sessionId: "r6", name: "Resumed", cwd: "/repo", spaceId: null });
    host.send({ type: "cockpitResumeSession", sessionId: "r6" });
    expect(backend.spawns[0]!.initialInput).toContain("--model 'claude-opus-4-8'");
  });
});

describe("CockpitController pick a working folder for the launch", () => {
  it("opens the host folder picker and returns the chosen path tagged with the context", async () => {
    folderPickerResult = "/Users/alex/code/my-api";
    host.send({ type: "cockpitPickFolder", context: "quick" });
    await Promise.resolve();
    await Promise.resolve();
    expect(host.posted.find((m) => m.type === "cockpitFolderPicked")).toEqual({
      type: "cockpitFolderPicked",
      context: "quick",
      path: "/Users/alex/code/my-api",
    });
  });

  it("returns a null path when the picker is cancelled", async () => {
    folderPickerResult = null;
    host.send({ type: "cockpitPickFolder", context: "quick" });
    await Promise.resolve();
    await Promise.resolve();
    expect(host.posted.find((m) => m.type === "cockpitFolderPicked")).toEqual({
      type: "cockpitFolderPicked",
      context: "quick",
      path: null,
    });
  });

  it("honours the picked cwd when the webview then launches", () => {
    store.saveProfile(defaultProfile(toProfileId("p1"), "Worker"));
    host.send({
      type: "cockpitQuickLaunch",
      name: "Scratch",
      model: "default",
      permissionMode: "default",
      cwd: "/Users/alex/code/my-api",
      spaceId: null,
      count: 1,
      prompt: null,
    });
    expect(backend.spawns[0]!.cwd).toBe("/Users/alex/code/my-api");
  });
});

describe("CockpitController — resume on webview re-show", () => {
  beforeEach(() => {
    store.saveProfile(defaultProfile(toProfileId("p1"), "Worker"));
  });

  it("forces a redraw for an alive alternate-screen session instead of replaying stale text", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
    backend.capturedHistory.set("uuid-1", "");
    backend.redrawResult = true;
    backend.redrawn.length = 0;
    host.posted.length = 0;
    host.send({ type: "cockpitReady" });
    expect(backend.redrawn).toContain("uuid-1");
    expect(host.posted.some((m) => m.type === "terminalData" && m.sessionId === "uuid-1")).toBe(false);
  });

  it("falls back to disk history when a redraw is not possible", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
    terminalHistoryStore.append("uuid-1", "earlier output\r\n");
    backend.capturedHistory.set("uuid-1", "");
    backend.redrawResult = false;
    backend.redrawn.length = 0;
    host.posted.length = 0;
    host.send({ type: "cockpitReady" });
    expect(backend.redrawn).toContain("uuid-1");
    const replayed = host.posted.filter(
      (m): m is Extract<typeof m, { type: "terminalData" }> => m.type === "terminalData" && m.sessionId === "uuid-1",
    );
    expect(replayed.map((m) => m.data).join("")).toContain("earlier output");
  });

  it("replays captured text for a normal-screen session without forcing a redraw", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
    backend.capturedHistory.set("uuid-1", "$ ls\r\nfile.txt\r\n");
    backend.redrawn.length = 0;
    host.posted.length = 0;
    host.send({ type: "cockpitReady" });
    expect(backend.redrawn).not.toContain("uuid-1");
    const replayed = host.posted.filter(
      (m): m is Extract<typeof m, { type: "terminalData" }> => m.type === "terminalData" && m.sessionId === "uuid-1",
    );
    expect(replayed.map((m) => m.data).join("")).toContain("file.txt");
  });

  it("does not force a redraw for a paused session and replays its disk history", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
    terminalHistoryStore.append("uuid-1", "before pause\r\n");
    host.send({ type: "cockpitPauseSession", sessionId: "uuid-1" });
    backend.redrawn.length = 0;
    host.posted.length = 0;
    host.send({ type: "cockpitReady" });
    expect(backend.redrawn).not.toContain("uuid-1");
    const replayed = host.posted.filter(
      (m): m is Extract<typeof m, { type: "terminalData" }> => m.type === "terminalData" && m.sessionId === "uuid-1",
    );
    expect(replayed.map((m) => m.data).join("")).toContain("before pause");
  });

  it("persists a session's scrollback to disk on process exit, so a host restart can still replay it", async () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
    terminalHistoryStore.append("uuid-1", "final output before exit\r\n");
    backend.emitExit("uuid-1", 0);
    const restarted = new CockpitTerminalHistoryStore(path.join(dir, "terminal-history"));
    await vi.waitFor(() => {
      expect([...restarted.read("uuid-1")].join("")).toContain("final output before exit");
    }, { timeout: 2000 });
  });
});

describe("CockpitController resume — permission override", () => {
  it("resumes with the picked permission mode, persists it, and keeps it for later resumes", () => {
    store.saveProfile(defaultProfile(toProfileId("p1"), "Rev"));
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
    backend.emitExit("uuid-1", 0);

    host.send({ type: "cockpitResumeSession", sessionId: "uuid-1", permissionMode: "plan" });
    const resumed = backend.spawns.at(-1)!;
    expect(resumed.initialInput).toContain("--resume uuid-1");
    expect(resumed.initialInput).toContain("--permission-mode plan");

    backend.emitExit("uuid-1", 0);
    host.send({ type: "cockpitResumeSession", sessionId: "uuid-1" });
    expect(backend.spawns.at(-1)!.initialInput, "the override sticks for the next resume").toContain("--permission-mode plan");
  });
});
