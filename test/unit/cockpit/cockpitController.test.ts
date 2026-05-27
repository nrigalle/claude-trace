import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CockpitController,
  type TerminalBackend,
  type TerminalSpawnSpec,
} from "../../../src/features/cockpit/app/CockpitController";
import type { CockpitHostToWebview, CockpitWebviewToHost } from "../../../src/features/cockpit/protocol";
import { ProfileStore } from "../../../src/features/cockpit/infra/ProfileStore";
import { CockpitSessionStore } from "../../../src/features/cockpit/infra/CockpitSessionStore";
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
  private dataListener: ((id: string, data: string) => void) | null = null;
  private exitListener: ((id: string, code: number) => void) | null = null;
  spawn(spec: TerminalSpawnSpec): void {
    this.spawns.push(spec);
    this.alive.add(spec.sessionId);
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
let host: FakeHost;
let backend: FakeBackend;
let names: Map<string, string>;
let transcripts: Set<string>;
let idSeq: number;
let attentionNotices: string[];
let cleanedHooks: string[];
let attentionListener: ((sessionId: string, reason: "stop" | "notify" | "active") => void) | null;
let savedLayout: import("../../../src/features/cockpit/protocol").CockpitLayout;
const NOW = 9_000_000;

const makeController = (): CockpitController =>
  new CockpitController({
    host,
    profileStore: store,
    sessionStore,
    terminals: backend,
    actions: {
      setName: (id, name) => names.set(id, name),
      defaultCwd: () => "/repo",
      newSessionId: () => `uuid-${++idSeq}`,
      transcriptExists: (_cwd, id) => transcripts.has(id),
      notifyAttention: (name) => attentionNotices.push(name),
      prepareHooks: (id) => `/hooks/${id}.json`,
      cleanupHooks: (id) => cleanedHooks.push(id),
      watchAttention: (listener) => {
        attentionListener = listener;
        return { dispose: () => { attentionListener = null; } };
      },
      saveDroppedImage: (fileName) => `/tmp/dropped/${fileName}`,
      loadCockpitLayout: () => savedLayout,
      saveCockpitLayout: (layout) => { savedLayout = layout; },
      now: () => NOW,
    },
  });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-termctl-"));
  store = new ProfileStore(path.join(dir, "cockpit.json"));
  sessionStore = new CockpitSessionStore(path.join(dir, "cockpit-sessions.json"));
  host = new FakeHost();
  backend = new FakeBackend();
  names = new Map();
  transcripts = new Set();
  idSeq = 0;
  attentionNotices = [];
  cleanedHooks = [];
  attentionListener = null;
  savedLayout = { columns: {}, spans: {}, order: [] };
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
    expect(backend.spawns[0]!.initialInput).toContain("--model claude-opus-4-7");
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

  it("folds a prompt override into the launched command", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: "review the diff" });
    expect(backend.spawns[0]!.initialInput).toContain("'review the diff'");
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

  it("a Stop signal notifies the user and tells the webview to light up that exact tile", () => {
    attentionListener!("uuid-1", "stop");
    expect(attentionNotices).toContain("Rev 1");
    expect(host.posted.some((m) => m.type === "terminalAttention" && m.sessionId === "uuid-1" && m.reason === "stop")).toBe(true);
  });

  it("ignores signals for sessions it no longer manages", () => {
    attentionListener!("ghost-session", "notify");
    expect(attentionNotices).toHaveLength(0);
    expect(host.posted.some((m) => m.type === "terminalAttention")).toBe(false);
  });

  it("notifies ONCE while idle even if Claude re-signals repeatedly (no notification spam)", () => {
    attentionListener!("uuid-1", "stop");
    attentionListener!("uuid-1", "notify");
    attentionListener!("uuid-1", "stop");
    expect(attentionNotices).toEqual(["Rev 1"]);
  });

  it("keeps lighting the tile on every signal even though it only notifies once", () => {
    attentionListener!("uuid-1", "stop");
    attentionListener!("uuid-1", "stop");
    const lit = host.posted.filter((m) => m.type === "terminalAttention" && m.sessionId === "uuid-1");
    expect(lit.length).toBe(2);
    expect(attentionNotices).toHaveLength(1);
  });

  it("typing in the terminal does NOT clear the waiting state or re-trigger notifications", () => {
    attentionListener!("uuid-1", "stop");
    host.send({ type: "terminalInput", sessionId: "uuid-1", data: "hi\r" });
    attentionListener!("uuid-1", "stop");
    expect(attentionNotices).toEqual(["Rev 1"]);
  });

  it("clears waiting state and tells the webview only when the agent becomes ACTIVE again (UserPromptSubmit)", () => {
    attentionListener!("uuid-1", "stop");
    attentionListener!("uuid-1", "active");
    expect(host.posted.some((m) => m.type === "terminalActive" && m.sessionId === "uuid-1")).toBe(true);
    attentionListener!("uuid-1", "stop");
    expect(attentionNotices).toEqual(["Rev 1", "Rev 1"]);
  });

  it("REALISTIC agentic loop: PreToolUse activity keeps clearing the border so it never lingers while the agent works", () => {
    attentionListener!("uuid-1", "active");
    attentionListener!("uuid-1", "active");
    attentionListener!("uuid-1", "active");
    expect(attentionNotices).toHaveLength(0);
    attentionListener!("uuid-1", "stop");
    attentionListener!("uuid-1", "active");
    const activeMsgs = host.posted.filter((m) => m.type === "terminalActive").length;
    expect(activeMsgs).toBeGreaterThanOrEqual(4);
    attentionListener!("uuid-1", "stop");
    expect(attentionNotices).toEqual(["Rev 1", "Rev 1"]);
  });

  it("REALISTIC multi-session: each window notifies independently and re-arms independently", () => {
    store.saveProfile(defaultProfile(toProfileId("p2"), "Worker"));
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p2"), count: 1, promptOverride: null });
    attentionListener!("uuid-1", "stop");
    attentionListener!("uuid-2", "stop");
    expect(attentionNotices).toEqual(["Rev 1", "Worker 1"]);
    attentionListener!("uuid-1", "stop");
    attentionListener!("uuid-2", "stop");
    expect(attentionNotices).toEqual(["Rev 1", "Worker 1"]);
    attentionListener!("uuid-1", "active");
    attentionListener!("uuid-1", "stop");
    expect(attentionNotices).toEqual(["Rev 1", "Worker 1", "Rev 1"]);
  });

  it("cleans up the session's hook files when the terminal is closed", () => {
    host.send({ type: "terminalClose", sessionId: "uuid-1" });
    expect(cleanedHooks).toContain("uuid-1");
  });
});

describe("CockpitController layout persistence (per-folder window display survives reload)", () => {
  it("sends the saved layout to the webview on cockpitReady", () => {
    savedLayout = { columns: { __all__: 3, "space-x": 1 }, spans: { "uuid-1": { cols: 2, rows: 1 } }, order: ["uuid-1"] };
    backend = new FakeBackend();
    host = new FakeHost();
    makeController();
    host.send({ type: "cockpitReady" });
    const layoutMsg = host.posted.find((m) => m.type === "cockpitLayout");
    expect(layoutMsg).toBeDefined();
    expect(layoutMsg).toMatchObject({ type: "cockpitLayout", layout: savedLayout });
  });

  it("persists layout the webview sends via cockpitSaveLayout", () => {
    const layout = { columns: { test: 4 }, spans: { w1: { cols: 1, rows: 2 } }, order: ["w1"] };
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
    transcripts.add("uuid-1");
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

  it("resumes via --resume when a transcript exists, but re-launches with --session-id when it does not", () => {
    host.send({ type: "cockpitLaunch", profileId: toProfileId("p1"), count: 1, promptOverride: null });
    backend = new FakeBackend();
    host = new FakeHost();
    makeController();
    host.send({ type: "cockpitReady" });
    expect(backend.spawns[0]!.initialInput).toContain("--session-id uuid-1");
    expect(backend.spawns[0]!.initialInput).not.toContain("--resume");
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
    expect(tab.initialInput).toContain("--model claude-opus-4-7");
    expect(tab.initialInput).toContain("plan");
    const terminals = host.lastState().state.terminals;
    expect(terminals).toHaveLength(2);
    expect(terminals.every((t) => t.windowId === "uuid-1")).toBe(true);
    expect(terminals[1]!.name).toBe("Rev 1 · 2");
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
    expect(backend.spawns[0]!.initialInput).toContain("--model claude-opus-4-7");
    expect(backend.spawns[0]!.initialInput).toContain("'go'");
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
