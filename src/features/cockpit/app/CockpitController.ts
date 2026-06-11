import type {
  CockpitHostToWebview,
  CockpitLayout,
  CockpitState,
  CockpitWebviewToHost,
  TerminalKind,
  TerminalSession,
} from "../protocol";
import { assertNeverCockpit } from "../protocol";
import type { ProfileStore } from "../infra/ProfileStore";
import type { CockpitSessionStore } from "../infra/CockpitSessionStore";
import {
  batchNames,
  clampCount,
  fromProfileId,
  fromSpaceId,
  nextTabName,
  validateProfile,
  type ProfileId,
  type SessionProfile,
} from "../domain/profiles";
import { DEFAULT_MODEL_CHOICE, modelChoiceFromId, modelDefaultEffort, normalizeModelChoice, type EffortChoice, type ModelChoice } from "../../../shared/models";
import { buildClaudeCommand, type PermissionMode, type ShellQuote } from "../../../shared/permissionModes";

export interface CockpitHost {
  postMessage(msg: CockpitHostToWebview): void;
  onMessage(listener: (msg: CockpitWebviewToHost) => void): { dispose(): void };
  onDispose(listener: () => void): { dispose(): void };
}

export interface TerminalSpawnSpec {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly cols: number;
  readonly rows: number;
  readonly initialInput: string;
  readonly forceInitialInput?: boolean;
}

export interface TerminalBackend {
  spawn(spec: TerminalSpawnSpec): void;
  shellQuoteStyle(): ShellQuote;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  kill(sessionId: string): void;
  isAlive(sessionId: string): boolean;
  captureHistory(sessionId: string): string | null;
  forceRedraw(sessionId: string): boolean;
  onData(listener: (sessionId: string, data: string) => void): { dispose(): void };
  onExit(listener: (sessionId: string, exitCode: number) => void): { dispose(): void };
  dispose(): void;
}

export interface TerminalHistoryStore {
  append(sessionId: string, data: string): void;
  read(sessionId: string): Iterable<string>;
  delete(sessionId: string): void;
  persistSession(sessionId: string): void;
  flushAll(): void;
}

export interface CockpitActions {
  setName(sessionId: string, name: string): void;
  defaultCwd(): string | null;
  newSessionId(): string;
  prepareHooks(sessionId: string): string | null;
  cleanupHooks(sessionId: string): void;
  watchAttention(listener: (sessionId: string, reason: "stop" | "notify" | "active" | "start") => void): { dispose(): void };
  saveDroppedImage(fileName: string, dataBase64: string): string | null;
  loadCockpitLayout(): CockpitLayout;
  saveCockpitLayout(layout: CockpitLayout): void;
  pickFolder(context: string): Promise<string | null>;
  now(): number;
}

export interface CockpitControllerDeps {
  readonly host: CockpitHost;
  readonly profileStore: ProfileStore;
  readonly sessionStore: CockpitSessionStore;
  readonly terminalHistoryStore: TerminalHistoryStore;
  readonly terminals: TerminalBackend;
  readonly actions: CockpitActions;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

interface ManagedTerminal {
  readonly sessionId: string;
  windowId: string;
  readonly name: string;
  spaceId: string | null;
  readonly cwd: string | null;
  readonly model: ModelChoice;
  readonly effort: EffortChoice;
  permissionMode: PermissionMode;
  readonly startedAtMs: number;
  readonly kind: TerminalKind;
  exitCode: number | null;
}

export class CockpitController {
  private readonly disposables: { dispose(): void }[] = [];
  private readonly managed = new Map<string, ManagedTerminal>();
  private readonly nextIndex = new Map<string, number>();
  private readonly paused = new Set<string>();
  private readonly pendingInitialPrompts = new Map<string, string>();
  private disposed = false;

  constructor(private readonly deps: CockpitControllerDeps) {
    this.disposables.push(deps.host.onMessage((m) => this.onMessage(m)));
    this.disposables.push(deps.host.onDispose(() => this.dispose()));
    this.disposables.push(
      deps.terminals.onData((sessionId, data) => {
        this.deps.terminalHistoryStore.append(sessionId, data);
        this.deps.host.postMessage({ type: "terminalData", sessionId, data });
      }),
    );
    this.disposables.push(
      deps.terminals.onExit((sessionId, exitCode) => this.onTerminalExit(sessionId, exitCode)),
    );
    this.disposables.push(
      deps.actions.watchAttention((sessionId, reason) => {
        if (reason === "start") {
          this.deliverInitialPrompt(sessionId);
          return;
        }
        if (reason === "active") {
          this.onActive(sessionId);
          return;
        }
        this.onAttention(sessionId, reason);
      }),
    );
    for (const s of deps.sessionStore.load()) {
      this.managed.set(s.id, {
        sessionId: s.id,
        windowId: s.windowId,
        name: s.name,
        spaceId: s.spaceId,
        cwd: s.cwd,
        model: s.model,
        effort: s.effort,
        permissionMode: s.permissionMode,
        startedAtMs: s.startedAtMs,
        kind: s.kind,
        exitCode: null,
      });
      deps.actions.setName(s.id, s.name);
    }
    for (const key of this.managed.keys()) this.spawnResume(key);
  }

  private deliverInitialPrompt(sessionId: string): void {
    const prompt = this.pendingInitialPrompts.get(sessionId);
    if (prompt === undefined) return;
    this.pendingInitialPrompts.delete(sessionId);
    this.deps.terminals.write(sessionId, `\u001b[200~${prompt.replace(/\r\n/g, "\n")}\u001b[201~`);
    setTimeout(() => this.deps.terminals.write(sessionId, "\r"), 350);
  }

  private persist(m: ManagedTerminal): void {
    this.deps.sessionStore.upsert({
      id: m.sessionId,
      windowId: m.windowId,
      name: m.name,
      spaceId: m.spaceId,
      cwd: m.cwd,
      model: m.model,
      effort: m.effort,
      permissionMode: m.permissionMode,
      startedAtMs: m.startedAtMs,
      kind: m.kind,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.deps.terminals.dispose();
    this.deps.terminalHistoryStore.flushAll();
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {}
    }
    this.disposables.length = 0;
  }

  private onMessage(msg: CockpitWebviewToHost): void {
    switch (msg.type) {
      case "cockpitReady":
        this.deps.host.postMessage({ type: "cockpitLayout", layout: this.deps.actions.loadCockpitLayout() });
        this.broadcast();
        this.replayTerminalHistory();
        return;
      case "cockpitSaveLayout":
        this.deps.actions.saveCockpitLayout(msg.layout);
        return;
      case "cockpitLaunch":
        this.handleLaunch(msg.profileId, msg.count, msg.promptOverride);
        return;
      case "cockpitQuickLaunch":
        this.handleQuickLaunch(msg);
        return;
      case "cockpitSaveProfile":
        this.handleSaveProfile(msg.profile);
        return;
      case "cockpitDeleteProfile":
        this.deps.profileStore.deleteProfile(msg.profileId);
        this.broadcast();
        return;
      case "cockpitSaveSpace":
        this.deps.profileStore.saveSpace(msg.space);
        this.broadcast();
        return;
      case "cockpitDeleteSpace": {
        for (const m of this.managed.values()) {
          if (m.spaceId === fromSpaceId(msg.spaceId)) {
            m.spaceId = null;
            this.persist(m);
          }
        }
        this.deps.profileStore.deleteSpace(msg.spaceId);
        this.broadcast();
        return;
      }
      case "terminalInput":
        this.deps.terminals.write(msg.sessionId, msg.data);
        return;
      case "terminalResize":
        this.deps.terminals.resize(msg.sessionId, msg.cols, msg.rows);
        return;
      case "terminalClose":
        this.deps.terminals.kill(msg.sessionId);
        this.deps.actions.cleanupHooks(msg.sessionId);
        this.managed.delete(msg.sessionId);
        this.deps.terminalHistoryStore.delete(msg.sessionId);
        this.deps.sessionStore.remove(msg.sessionId);
        this.broadcast();
        return;
      case "cockpitResumeSession":
        this.handleResume(msg.sessionId, msg.permissionMode);
        return;
      case "cockpitPauseSession":
        this.paused.add(msg.sessionId);
        this.deps.terminals.kill(msg.sessionId);
        this.broadcast();
        return;
      case "cockpitAddTab":
        this.handleAddTab(msg.windowId);
        return;
      case "cockpitNewTerminal":
        this.spawnShell(msg.spaceId);
        return;
      case "cockpitPickFolder": {
        const context = msg.context;
        void this.deps.actions.pickFolder(context).then((path) => {
          this.deps.host.postMessage({ type: "cockpitFolderPicked", context, path });
        });
        return;
      }
      case "cockpitDetachTab": {
        const tab = this.managed.get(msg.sessionId);
        if (tab && tab.windowId !== tab.sessionId) {
          tab.windowId = tab.sessionId;
          this.persist(tab);
          this.broadcast();
        }
        return;
      }
      case "cockpitMoveSession": {
        const moved = this.managed.get(msg.sessionId);
        if (moved) {
          moved.spaceId = msg.spaceId;
          this.persist(moved);
          this.broadcast();
        }
        return;
      }
      case "cockpitAdoptSession":
        this.handleAdopt(msg.sessionId, msg.name, msg.cwd, msg.spaceId, msg.modelId);
        return;
      case "cockpitDropImage": {
        const imgPath = this.deps.actions.saveDroppedImage(msg.fileName, msg.dataBase64);
        if (imgPath) this.deps.terminals.write(msg.sessionId, ` '${imgPath}' `);
        return;
      }
      default:
        return assertNeverCockpit(msg);
    }
  }

  private handleSaveProfile(profile: SessionProfile): void {
    const errors = validateProfile(profile);
    if (errors.length > 0) {
      this.deps.host.postMessage({ type: "cockpitProfileInvalid", errors });
      return;
    }
    this.deps.profileStore.saveProfile({ ...profile, model: normalizeModelChoice(profile.model) });
    this.broadcast();
  }

  private handleLaunch(profileId: ProfileId, count: number, promptOverride: string | null): void {
    const profile = this.deps.profileStore
      .load()
      .profiles.find((p) => p.id === profileId);
    if (!profile) {
      this.deps.host.postMessage({
        type: "cockpitNotice",
        level: "error",
        message: "That profile no longer exists.",
      });
      return;
    }
    const n = clampCount(count);
    const profileKey = fromProfileId(profile.id);
    const start = this.nextIndex.get(profileKey) ?? 1;
    const names = batchNames(profile.nameTemplate, profile.name, n, start);
    this.nextIndex.set(profileKey, start + n);
    this.spawnBatch(names, {
      model: profile.model,
      effort: profile.effort,
      permissionMode: profile.permissionMode,
      cwd: profile.cwd ?? this.deps.actions.defaultCwd(),
      spaceId: profile.spaceId === null ? null : fromSpaceId(profile.spaceId),
      prompt: promptOverride ?? profile.initialPrompt,
    });
  }

  private handleQuickLaunch(msg: Extract<CockpitWebviewToHost, { type: "cockpitQuickLaunch" }>): void {
    const n = clampCount(msg.count);
    const base = msg.name.trim().length > 0 ? msg.name.trim() : "Claude";
    const names = batchNames("{profile} {n}", base, n, 1).map((name) => (n === 1 ? base : name));
    this.spawnBatch(names, {
      model: normalizeModelChoice(msg.model),
      effort: msg.effort,
      permissionMode: msg.permissionMode,
      cwd: msg.cwd ?? this.deps.actions.defaultCwd(),
      spaceId: msg.spaceId,
      prompt: msg.prompt,
    });
  }

  private spawnBatch(
    names: readonly string[],
    config: {
      readonly model: ModelChoice;
      readonly effort: EffortChoice;
      permissionMode: PermissionMode;
      readonly cwd: string | null;
      readonly spaceId: string | null;
      readonly prompt: string | null;
    },
  ): void {
    for (const name of names) {
      const sessionId = this.deps.actions.newSessionId();
      const settingsPath = this.deps.actions.prepareHooks(sessionId);
      const prompt = config.prompt?.trim() ?? "";
      const deliverViaPty = settingsPath !== null && prompt.length > 0;
      const command = buildClaudeCommand({
        mode: config.permissionMode,
        model: config.model,
        effort: config.effort,
        name,
        sessionId,
        initialPrompt: deliverViaPty ? null : config.prompt,
        settingsPath,
      }, this.deps.terminals.shellQuoteStyle());
      if (deliverViaPty) this.pendingInitialPrompts.set(sessionId, prompt);
      this.deps.terminals.spawn({
        sessionId,
        cwd: config.cwd,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        initialInput: `${command}\r`,
      });
      const managed: ManagedTerminal = {
        sessionId,
        windowId: sessionId,
        name,
        spaceId: config.spaceId,
        cwd: config.cwd,
        model: config.model,
        effort: config.effort,
        permissionMode: config.permissionMode,
        startedAtMs: this.deps.actions.now(),
        kind: "claude",
        exitCode: null,
      };
      this.managed.set(sessionId, managed);
      this.deps.actions.setName(sessionId, name);
      this.persist(managed);
    }
    this.broadcast();
  }

  private spawnShell(spaceId: string | null): void {
    const sessionId = this.deps.actions.newSessionId();
    const count = [...this.managed.values()].filter((m) => m.kind === "shell").length;
    const name = count === 0 ? "Terminal" : `Terminal ${count + 1}`;
    const cwd = this.deps.actions.defaultCwd();
    this.deps.terminals.spawn({ sessionId, cwd, cols: DEFAULT_COLS, rows: DEFAULT_ROWS, initialInput: "" });
    const managed: ManagedTerminal = {
      sessionId,
      windowId: sessionId,
      name,
      spaceId,
      cwd,
      model: DEFAULT_MODEL_CHOICE,
      effort: "default",
      permissionMode: "default",
      startedAtMs: this.deps.actions.now(),
      kind: "shell",
      exitCode: null,
    };
    this.managed.set(sessionId, managed);
    this.deps.actions.setName(sessionId, name);
    this.persist(managed);
    this.broadcast();
  }

  private handleAddTab(windowId: string): void {
    const inWindow = [...this.managed.values()].filter((m) => m.windowId === windowId);
    const template = inWindow[0];
    if (!template) return;
    const sessionId = this.deps.actions.newSessionId();
    const name = nextTabName(inWindow.map((m) => m.name), template.name);
    const initialInput =
      template.kind === "shell"
        ? ""
        : `${buildClaudeCommand({
            mode: template.permissionMode,
            model: template.model,
            effort: template.effort,
            name,
            sessionId,
            settingsPath: this.deps.actions.prepareHooks(sessionId),
          }, this.deps.terminals.shellQuoteStyle())}\r`;
    this.deps.terminals.spawn({
      sessionId,
      cwd: template.cwd,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      initialInput,
    });
    const managed: ManagedTerminal = {
      sessionId,
      windowId,
      name,
      spaceId: template.spaceId,
      cwd: template.cwd,
      model: template.model,
      effort: template.effort,
      permissionMode: template.permissionMode,
      startedAtMs: this.deps.actions.now(),
      kind: template.kind,
      exitCode: null,
    };
    this.managed.set(sessionId, managed);
    this.deps.actions.setName(sessionId, name);
    this.persist(managed);
    this.broadcast();
  }

  private handleResume(key: string, permissionMode?: PermissionMode): void {
    if (this.spawnResume(key, permissionMode)) this.broadcast();
  }

  private handleAdopt(
    sessionId: string,
    name: string,
    cwd: string | null,
    spaceId: string | null,
    modelId?: string,
  ): void {
    const existing = this.managed.get(sessionId);
    if (existing) {
      if (existing.spaceId !== spaceId) {
        existing.spaceId = spaceId;
        this.persist(existing);
      }
    } else {
      const model = modelChoiceFromId(modelId);
      this.managed.set(sessionId, {
        sessionId,
        windowId: sessionId,
        name,
        spaceId,
        cwd,
        model,
        effort: modelDefaultEffort(model),
        permissionMode: "default",
        startedAtMs: this.deps.actions.now(),
        kind: "claude",
        exitCode: null,
      });
      this.deps.actions.setName(sessionId, name);
      this.persist(this.managed.get(sessionId)!);
    }
    this.broadcast();
  }

  private spawnResume(key: string, permissionMode?: PermissionMode): boolean {
    const managed = this.managed.get(key);
    if (!managed) return false;
    if (this.deps.terminals.isAlive(key)) return false;
    managed.exitCode = null;
    if (permissionMode !== undefined && permissionMode !== managed.permissionMode) {
      managed.permissionMode = permissionMode;
      this.persist(managed);
    }
    const forceInitialInput = this.paused.has(key);
    let initialInput = "";
    if (managed.kind === "claude") {
      const command = buildClaudeCommand({
        mode: managed.permissionMode,
        model: managed.model,
        effort: managed.effort,
        name: managed.name,
        settingsPath: this.deps.actions.prepareHooks(key),
        resumeId: key,
      }, this.deps.terminals.shellQuoteStyle());
      initialInput = `${command}\r`;
    }
    this.deps.terminals.spawn({
      sessionId: key,
      cwd: managed.cwd,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      initialInput,
      forceInitialInput,
    });
    this.paused.delete(key);
    return true;
  }

  private onAttention(sessionId: string, reason: "stop" | "notify"): void {
    const managed = this.managed.get(sessionId);
    if (!managed) return;
    this.deps.host.postMessage({ type: "terminalAttention", sessionId, reason });
  }

  private onActive(sessionId: string): void {
    this.deps.host.postMessage({ type: "terminalActive", sessionId });
  }

  private onTerminalExit(sessionId: string, exitCode: number): void {
    const managed = this.managed.get(sessionId);
    if (managed) managed.exitCode = exitCode;
    this.deps.terminalHistoryStore.persistSession(sessionId);
    this.deps.host.postMessage({ type: "terminalExit", sessionId, exitCode });
    this.broadcast();
  }

  private buildState(): CockpitState {
    const cfg = this.deps.profileStore.load();
    const terminals: TerminalSession[] = [];
    for (const m of this.managed.values()) {
      terminals.push({
        sessionId: m.sessionId,
        windowId: m.windowId,
        name: m.name,
        spaceId: m.spaceId,
        cwd: m.cwd,
        alive: this.deps.terminals.isAlive(m.sessionId),
        exitCode: m.exitCode,
        startedAtMs: m.startedAtMs,
        kind: m.kind,
      });
    }
    return { profiles: cfg.profiles, spaces: cfg.spaces, terminals };
  }

  private broadcast(): void {
    if (this.disposed) return;
    this.deps.host.postMessage({ type: "cockpitState", state: this.buildState() });
  }

  private replayTerminalHistory(): void {
    for (const sessionId of this.managed.keys()) {
      const captured = this.deps.terminals.captureHistory(sessionId);
      if (captured !== null && captured.length > 0) {
        this.deps.host.postMessage({ type: "terminalData", sessionId, data: captured, replay: true });
        continue;
      }
      if (captured === "" && this.deps.terminals.isAlive(sessionId) && this.deps.terminals.forceRedraw(sessionId)) {
        continue;
      }
      for (const data of this.deps.terminalHistoryStore.read(sessionId)) {
        this.deps.host.postMessage({ type: "terminalData", sessionId, data, replay: true });
      }
    }
  }
}
