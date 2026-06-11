import type {
  CockpitHostToWebview,
  CockpitLayout,
  CockpitState,
  CockpitWebviewToHost,
  TerminalSession,
} from "../../../src/features/cockpit/protocol";
import { assertNeverCockpit } from "../../../src/features/cockpit/protocol";
import { dock, syncTree, type DropEdge, type LayoutNode } from "../../../src/features/cockpit/domain/splitTree";
import { ICONS } from "../ui/icons.js";
import { renderFoldersBar, type FoldersBarHost } from "./cockpitFoldersBar.js";
import { renderTileMeta, sessionStatus } from "./cockpitTileMeta.js";
import { flashToast } from "./cockpitToasts.js";
import { renderSkeletonTiles } from "./cockpitSkeleton.js";
import { renderTabStrip, type TabStripHost } from "./cockpitTabs.js";
import type { AttentionReason, WindowTile } from "./cockpitTileTypes.js";
import { clear, h } from "../ui/h.js";
import { renderLayoutNode } from "./cockpitLayoutView.js";
import { CockpitLauncher } from "./cockpitLauncher.js";
import { createCockpitTerminal, attachWebglRenderer, type CockpitTerminalView, type RendererHandle } from "./terminalCore.js";
import { ALL_FOLDER } from "./cockpitUtils.js";
import { wireWindowDrag, type WindowDragHost } from "./windowDrag.js";
import { buildResumeOverlay } from "./resumeOverlay.js";

const RESET_INPUT_MODES = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?2004l";

export interface TerminalCockpitDeps {
  send(msg: CockpitWebviewToHost): void;
  fullscreenChanged?(on: boolean): void;
}

interface TerminalView extends CockpitTerminalView {
  windowId: string;
  initialised: boolean;
  gotData: boolean;
  lastCols: number;
  lastRows: number;
  replaying: boolean;
  webgl: RendererHandle | null;
  webglLost: boolean;
}

const MAX_WEBGL_TERMINALS = 8;


export class TerminalCockpit {
  private readonly root: HTMLElement;
  private readonly folderBar: HTMLElement;
  private readonly topbarActions: HTMLElement;
  private readonly launcherEl: HTMLElement;
  private readonly gridEl: HTMLElement;
  private readonly launcher: CockpitLauncher;
  private readonly views = new Map<string, TerminalView>();
  private readonly tiles = new Map<string, WindowTile>();
  private readonly pendingData = new Map<string, { data: string; replay: boolean }[]>();

  private state: CockpitState = { profiles: [], spaces: [], terminals: [] };
  private loaded = false;
  private activeFolder: string = ALL_FOLDER;
  private creatingFolder = false;
  private renamingFolder: string | null = null;
  private resizing = false;
  private fitTimer: number | null = null;
  private readonly attention = new Set<string>();
  private readonly attentionReasons = new Map<string, AttentionReason>();
  private readonly pendingFocus = new Set<string>();
  private readonly trees = new Map<string, LayoutNode | null>();
  private saveLayoutTimer: number | null = null;
  private fullscreen = false;
  private pendingState: CockpitState | null = null;
  private pendingGridRender = false;
  private readonly resizeObserver: ResizeObserver;
  private readonly foldersBarHost: FoldersBarHost;
  private readonly tabStripHost: TabStripHost;
  private readonly windowDragHost: WindowDragHost;

  constructor(private readonly deps: TerminalCockpitDeps) {
    this.folderBar = h("div", { className: "tc-folders" });
    this.topbarActions = h("div", { className: "tc-topbar-actions" });
    this.launcherEl = h("div", { className: "tc-launcher hidden" });
    this.gridEl = h("div", { className: "tc-grid" });
    this.launcher = new CockpitLauncher({
      send: (msg) => this.deps.send(msg),
      rerender: () => {
        this.flushBlockedUi();
        this.renderFolders();
        this.renderLauncher();
      },
      setActiveFolder: (folder) => {
        this.activeFolder = folder;
      },
    });
    this.root = h(
      "div",
      { className: "tc-root" },
      h("div", { className: "tc-topbar" }, this.folderBar, this.topbarActions),
      this.launcherEl,
      this.gridEl,
    );
    this.foldersBarHost = {
      folderBar: this.folderBar,
      topbarActions: this.topbarActions,
      state: () => this.state,
      groupWindows: () => this.groupWindows(),
      windowFolder: (windowId) => this.windowFolder(windowId),
      activeFolder: () => this.activeFolder,
      setActiveFolder: (folder) => { this.activeFolder = folder; },
      creatingFolder: () => this.creatingFolder,
      setCreatingFolder: (v) => { this.creatingFolder = v; },
      renamingFolder: () => this.renamingFolder,
      setRenamingFolder: (v) => { this.renamingFolder = v; },
      folderNeedsAttention: (folder) => this.folderNeedsAttention(folder),
      attentionCount: () => this.attentionTerminals().length,
      jumpToAttention: () => this.jumpToAttention(),
      launcherOpen: () => this.launcher.isOpen(),
      toggleLauncher: () => this.launcher.toggle(),
      fullscreen: () => this.fullscreen,
      toggleFullscreen: () => this.toggleFullscreen(),
      send: (msg) => this.deps.send(msg),
      rerender: () => this.renderFolders(),
      renderGrid: () => this.renderGrid(),
    };
    this.tabStripHost = {
      send: (msg) => this.deps.send(msg),
      switchTab: (windowId, sessionId) => this.switchTab(windowId, sessionId),
      flushBlockedUi: () => this.flushBlockedUi(),
    };
    this.windowDragHost = {
      tileFor: (id) => this.tiles.get(id)?.tile,
      tileElements: () => [...this.tiles.values()].map((t) => t.tile),
      folderBar: this.folderBar,
      moveToFolder: (windowId, folder) => this.moveWindowToFolder(windowId, folder),
      dock: (dragged, target, edge) => this.dockWindow(dragged, target, edge),
      dragEnded: () => this.flushBlockedUi(),
    };
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.root.addEventListener(
      "pointerdown",
      (e) => {
        if (!this.launcher.isOpen()) return;
        const target = e.target instanceof HTMLElement ? e.target : null;
        if (!target || this.launcherEl.contains(target) || target.closest(".tc-newsession") !== null) return;
        this.launcher.close();
      },
      true,
    );
    this.folderBar.addEventListener(
      "focusout",
      () => { setTimeout(() => this.flushBlockedUi(), 0); },
      true,
    );
    this.resizeObserver.observe(this.gridEl);
    window.addEventListener("resize", () => this.fitImmediate());
    void document.fonts?.ready?.then(() => this.fitImmediate());
    this.renderFolders();
    this.renderGrid();
  }

  element(): HTMLElement {
    return this.root;
  }

  fitActive(): void {
    this.fitVisible();
  }

  adopt(sessionId: string, name: string, cwd: string | null, modelId?: string): void {
    const spaceId = this.activeFolder === ALL_FOLDER ? null : this.activeFolder;
    this.deps.send({ type: "cockpitAdoptSession", sessionId, name, cwd, spaceId, modelId });
    this.renderFolders();
  }

  receive(msg: CockpitHostToWebview): void {
    switch (msg.type) {
      case "cockpitState":
        if (this.uiInteractionBlocked()) {
          this.pendingState = msg.state;
          return;
        }
        this.state = msg.state;
        this.loaded = true;
        this.syncTerminals(msg.state.terminals);
        this.renderFolders();
        this.renderGrid();
        if (!this.launcher.isOpen()) this.renderLauncher();
        return;
      case "terminalData": {
        const view = this.views.get(msg.sessionId);
        const replay = msg.replay === true;
        if (!view) {
          const buf = this.pendingData.get(msg.sessionId);
          if (buf) buf.push({ data: msg.data, replay });
          else this.pendingData.set(msg.sessionId, [{ data: msg.data, replay }]);
          return;
        }
        this.writeTerminalData(msg.sessionId, view, msg.data, replay);
        return;
      }
      case "terminalExit": {
        const view = this.views.get(msg.sessionId);
        if (view) view.term.write(`${RESET_INPUT_MODES}\r\n\x1b[2m[process exited · code ${msg.exitCode}]\x1b[0m\r\n`);
        if (this.uiInteractionBlocked()) this.pendingGridRender = true;
        else this.renderGrid();
        return;
      }
      case "terminalAttention":
        this.markAttention(msg.sessionId, msg.reason);
        return;
      case "terminalActive":
        this.clearAttention(msg.sessionId);
        return;
      case "cockpitLayout":
        this.applyLayout(msg.layout);
        return;
      case "cockpitProfileInvalid":
        this.flash(msg.errors.map((e) => e.message).join(" "), "error");
        return;
      case "cockpitNotice":
        this.flash(msg.message, msg.level);
        return;
      case "cockpitFolderPicked":
        if (msg.context === "quick") this.launcher.applyPickedFolder(msg.path);
        return;
      default:
        assertNeverCockpit(msg);
    }
  }

  private groupWindows(): Map<string, TerminalSession[]> {
    const groups = new Map<string, TerminalSession[]>();
    for (const t of this.state.terminals) {
      const list = groups.get(t.windowId);
      if (list) list.push(t);
      else groups.set(t.windowId, [t]);
    }
    return groups;
  }

  private windowFolder(windowId: string): string | null {
    return this.state.terminals.find((t) => t.windowId === windowId)?.spaceId ?? null;
  }

  private windowsInFolder(): string[] {
    const wins = [...new Set(this.state.terminals.map((t) => t.windowId))];
    return wins.filter(
      (wid) => this.activeFolder === ALL_FOLDER || (this.windowFolder(wid) ?? "") === this.activeFolder,
    );
  }

  private syncTerminals(terminals: readonly TerminalSession[]): void {
    const present = new Set(terminals.map((t) => t.sessionId));
    const presentWindows = new Set(terminals.map((t) => t.windowId));

    for (const [id, view] of this.views) {
      if (!present.has(id)) {
        view.webgl?.dispose();
        view.webgl = null;
        view.term.dispose();
        view.termHost.remove();
        this.views.delete(id);
        this.attention.delete(id);
        this.attentionReasons.delete(id);
        this.pendingFocus.delete(id);
        this.pendingData.delete(id);
      }
    }
    for (const id of [...this.pendingData.keys()]) {
      if (!present.has(id)) this.pendingData.delete(id);
    }
    for (const [wid, tile] of this.tiles) {
      if (!presentWindows.has(wid)) {
        this.resizeObserver.unobserve(tile.termMount);
        tile.tile.remove();
        this.tiles.delete(wid);
      }
    }
    for (const t of terminals) {
      if (!this.views.has(t.sessionId)) this.createTerminalView(t);
      else this.views.get(t.sessionId)!.windowId = t.windowId;
      if (!this.tiles.has(t.windowId)) this.createWindowTile(t.windowId);
    }
  }

  private createTerminalView(session: TerminalSession): void {
    const terminal = createCockpitTerminal(session, {
      input: (data) => {
        if (this.views.get(session.sessionId)?.replaying) return;
        this.deps.send({ type: "terminalInput", sessionId: session.sessionId, data });
      },
      bell: () => this.markAttention(session.sessionId, "bell"),
      focus: () => this.focusView(session.sessionId),
      dropImage: (fileName, dataBase64) =>
        this.deps.send({ type: "cockpitDropImage", sessionId: session.sessionId, fileName, dataBase64 }),
    });
    const view: TerminalView = {
      ...terminal,
      windowId: session.windowId,
      initialised: false,
      gotData: false,
      lastCols: 0,
      lastRows: 0,
      replaying: false,
      webgl: null,
      webglLost: false,
    };
    this.views.set(session.sessionId, view);
    const buffered = this.pendingData.get(session.sessionId);
    if (buffered) {
      this.pendingData.delete(session.sessionId);
      for (const item of buffered) this.writeTerminalData(session.sessionId, view, item.data, item.replay);
    }
  }

  private writeTerminalData(sessionId: string, view: TerminalView, data: string, replay = false): void {
    const stick = this.atBottom(view.term);
    if (replay) {
      view.replaying = true;
      view.term.write(data, () => { view.replaying = false; });
    } else {
      view.term.write(data);
    }
    const tile = this.tiles.get(view.windowId);
    if (!view.gotData && data.length > 0) {
      view.gotData = true;
      if (tile && tile.activeId === sessionId) {
        tile.bootingOverlay.classList.add("hidden");
        if (this.pendingFocus.delete(sessionId)) this.focusView(sessionId);
      }
    }
    if (stick && tile && tile.activeId === sessionId) view.term.scrollToBottom();
  }

  private createWindowTile(windowId: string): void {
    const tabStrip = h("div", { className: "tc-tabs" });
    const grip = h("span", { className: "tc-tile-grip", innerHTML: ICONS.grip });
    const pauseBtn = h("button", {
      className: "tc-tab-pause",
      attrs: { type: "button", title: "Pause: kill the inner process to free RAM. Click Resume to bring it back.", "aria-label": "Pause active session" },
      innerHTML: ICONS.pause,
      on: {
        click: () => {
          const tile = this.tiles.get(windowId);
          if (tile && tile.activeId) this.deps.send({ type: "cockpitPauseSession", sessionId: tile.activeId });
        },
      },
    });
    const addTab = h("button", {
      className: "tc-tab-add",
      attrs: { type: "button", title: "New tab in this window", "aria-label": "New tab" },
      innerHTML: ICONS.plus,
      on: { click: () => this.deps.send({ type: "cockpitAddTab", windowId }) },
    });
    const head = h("div", { className: "tc-tile-head", attrs: { title: "Drag to swap places, or drop on a workspace" } }, grip, tabStrip, pauseBtn, addTab);
    const termMount = h("div", { className: "tc-tile-termmount" });
    this.resizeObserver.observe(termMount);
    const resumeOverlay = buildResumeOverlay((button, permissionMode) => {
      const sessionId = this.activeSessionIdForWindow(windowId);
      if (!sessionId) return;
      button.disabled = true;
      const tile = this.tiles.get(windowId);
      const view = this.views.get(sessionId);
      if (view) {
        view.term.write(RESET_INPUT_MODES);
        view.gotData = false;
        view.lastCols = 0;
        view.lastRows = 0;
      }
      tile?.resumeOverlay.classList.add("hidden");
      tile?.bootingOverlay.classList.remove("hidden");
      tile?.tile.classList.remove("exited");
      this.pendingFocus.add(sessionId);
      this.deps.send(
        permissionMode === null
          ? { type: "cockpitResumeSession", sessionId }
          : { type: "cockpitResumeSession", sessionId, permissionMode },
      );
    });
    const bootingOverlay = h(
      "div",
      { className: "tc-tile-booting", attrs: { role: "status", "aria-live": "polite" } },
      h("div", { className: "tc-tile-booting-dot", attrs: { "aria-hidden": "true" } }),
      h("div", { className: "tc-tile-booting-text", textContent: "Starting session…" }),
    );
    const metaBar = h("div", { className: "tc-tile-meta" });
    const body = h("div", { className: "tc-tile-body" }, termMount, resumeOverlay, bootingOverlay);
    const status = h("div", { className: "visually-hidden", attrs: { role: "status", "aria-live": "polite" } });
    const tile = h(
      "div",
      { className: "tc-tile", dataset: { windowId }, attrs: { role: "group" } },
      head,
      metaBar,
      body,
      status,
    );

    wireWindowDrag(this.windowDragHost, head, tile, windowId);

    this.tiles.set(windowId, { tile, tabStrip, metaBar, termMount, resumeOverlay, bootingOverlay, status, activeId: "", announced: "" });
  }

  private markAttention(sessionId: string, reason: AttentionReason): void {
    const view = this.views.get(sessionId);
    if (!view) return;
    this.attention.add(sessionId);
    this.attentionReasons.set(sessionId, reason);
    this.applyAttention(view.windowId);
    this.applyFolderAttention();
    this.applyAttentionSummary();
    this.updateWindowMeta(view.windowId);
  }

  private clearAttention(sessionId: string): void {
    const view = this.views.get(sessionId);
    if (!view) return;
    this.attention.delete(sessionId);
    this.attentionReasons.delete(sessionId);
    this.applyAttention(view.windowId);
    this.applyFolderAttention();
    this.applyAttentionSummary();
    this.updateWindowMeta(view.windowId);
  }

  private folderNeedsAttention(folder: string): boolean {
    return this.state.terminals.some(
      (t) => (folder === ALL_FOLDER || (t.spaceId ?? "") === folder) && this.attention.has(t.sessionId),
    );
  }

  private applyFolderAttention(): void {
    for (const chip of this.folderBar.querySelectorAll<HTMLElement>("[data-folder]")) {
      chip
        .querySelector(".tc-folder-dot")
        ?.classList.toggle("on", this.folderNeedsAttention(chip.getAttribute("data-folder")!));
    }
  }

  private applyAttentionSummary(): void {
    const button = this.root.querySelector<HTMLButtonElement>(".tc-attention-jump");
    if (!button) return;
    const count = this.attentionTerminals().length;
    const label = count === 0 ? "No sessions need attention" : `${count} session${count === 1 ? "" : "s"} need attention`;
    button.classList.toggle("on", count > 0);
    button.disabled = count === 0;
    button.title = count === 0 ? label : `${label}. Jump to the oldest one.`;
    button.setAttribute("aria-label", button.title);
    const countEl = button.querySelector(".tc-attention-count");
    if (countEl) countEl.textContent = String(count);
  }

  private applyAttention(windowId: string): void {
    const tile = this.tiles.get(windowId);
    if (!tile) return;
    const terminals = this.state.terminals.filter((t) => t.windowId === windowId);
    const windowNeedsAttention = terminals.some((t) => this.attention.has(t.sessionId));
    tile.tile.classList.toggle("attention", windowNeedsAttention);
    for (const t of terminals) {
      tile.tabStrip
        .querySelector(`[data-tab="${t.sessionId}"]`)
        ?.classList.toggle("attention", this.attention.has(t.sessionId));
    }
  }

  private attentionTerminals(): TerminalSession[] {
    const byId = new Map(this.state.terminals.map((t) => [t.sessionId, t]));
    const terminals: TerminalSession[] = [];
    for (const id of this.attention) {
      const terminal = byId.get(id);
      if (terminal) terminals.push(terminal);
    }
    return terminals;
  }

  private jumpToAttention(): void {
    const target = this.attentionTerminals()[0];
    if (!target) return;
    this.activeFolder = target.spaceId ?? ALL_FOLDER;
    const tile = this.tiles.get(target.windowId);
    if (tile) tile.activeId = target.sessionId;
    this.renderFolders();
    this.renderGrid();
    this.focusView(target.sessionId);
  }

  private focusView(sessionId: string): void {
    const view = this.views.get(sessionId);
    if (!view) return;
    if (view.termHost.classList.contains("hidden")) return;
    const tile = this.tiles.get(view.windowId);
    if (tile && (!tile.resumeOverlay.classList.contains("hidden") || !tile.bootingOverlay.classList.contains("hidden"))) {
      return;
    }
    requestAnimationFrame(() => {
      (view.term as unknown as { focus?: () => void }).focus?.();
    });
  }

  private focusActiveInWindow(windowId: string): void {
    const tile = this.tiles.get(windowId);
    if (!tile || !tile.activeId) return;
    this.focusView(tile.activeId);
  }

  private uiInteractionBlocked(): boolean {
    return (
      this.creatingFolder ||
      this.renamingFolder !== null ||
      document.body.classList.contains("tc-dragging-window") ||
      document.body.classList.contains("tc-tearing")
    );
  }

  private flushBlockedUi(): void {
    if (this.uiInteractionBlocked()) return;
    if (this.pendingState !== null) {
      const state = this.pendingState;
      this.pendingState = null;
      this.pendingGridRender = false;
      this.receive({ type: "cockpitState", state });
      return;
    }
    if (this.pendingGridRender) {
      this.pendingGridRender = false;
      this.renderGrid();
    }
  }

  private moveWindowToFolder(windowId: string, folder: string): void {
    const spaceId = folder === ALL_FOLDER ? null : folder;
    for (const t of this.state.terminals.filter((s) => s.windowId === windowId)) {
      this.deps.send({ type: "cockpitMoveSession", sessionId: t.sessionId, spaceId });
    }
  }

  private dockWindow(dragged: string, target: string, edge: DropEdge): void {
    const tree = this.trees.get(this.activeFolder);
    if (!tree) return;
    this.trees.set(this.activeFolder, dock(tree, dragged, target, edge));
    this.renderGrid();
    this.saveLayout();
  }

  private atBottom(term: CockpitTerminalView["term"]): boolean {
    return term.buffer.active.viewportY >= term.buffer.active.baseY;
  }

  private activeSessionIdForWindow(windowId: string): string | null {
    const tile = this.tiles.get(windowId);
    if (tile?.activeId) return tile.activeId;
    return this.state.terminals.find((t) => t.windowId === windowId)?.sessionId ?? null;
  }

  private applyLayout(layout: CockpitLayout): void {
    for (const [folder, tree] of Object.entries(layout.trees)) this.trees.set(folder, tree);
    this.renderGrid();
  }

  private saveLayout(): void {
    if (this.saveLayoutTimer !== null) clearTimeout(this.saveLayoutTimer);
    this.saveLayoutTimer = setTimeout(() => {
      this.saveLayoutTimer = null;
      const trees: Record<string, LayoutNode> = {};
      for (const [k, v] of this.trees) if (v) trees[k] = v;
      this.deps.send({ type: "cockpitSaveLayout", layout: { trees } });
    }, 500) as unknown as number;
  }

  private renderFolders(): void {
    renderFoldersBar(this.foldersBarHost);
  }

  private toggleFullscreen(): void {
    this.fullscreen = !this.fullscreen;
    document.body.classList.toggle("ct-cockpit-fullscreen", this.fullscreen);
    this.deps.fullscreenChanged?.(this.fullscreen);
    this.renderFolders();
    this.fitImmediate();
  }

  private renderGrid(): void {
    if (!this.loaded) {
      renderSkeletonTiles(this.gridEl);
      return;
    }
    const groups = this.groupWindows();
    const visibleIds = this.windowsInFolder();

    for (const wid of visibleIds) {
      const tile = this.tiles.get(wid);
      const terminals = groups.get(wid) ?? [];
      if (!tile || terminals.length === 0) continue;
      if (!terminals.some((t) => t.sessionId === tile.activeId)) tile.activeId = terminals[0]!.sessionId;
      renderTabStrip(this.tabStripHost, tile, wid, terminals);
      this.mountWindow(tile, terminals);
      this.applyAttention(wid);
      const active = terminals.find((t) => t.sessionId === tile.activeId)!;
      tile.tile.classList.toggle("exited", !active.alive);
      tile.resumeOverlay.classList.toggle("hidden", active.alive);
      const view = this.views.get(active.sessionId);
      tile.bootingOverlay.classList.toggle("hidden", !active.alive || (view?.gotData ?? false));
      this.renderTileMeta(tile, active);
    }

    const tree = syncTree(this.trees.get(this.activeFolder) ?? null, visibleIds);
    this.trees.set(this.activeFolder, tree);

    clear(this.gridEl);
    if (tree) {
      this.gridEl.classList.remove("empty");
      this.gridEl.appendChild(
        renderLayoutNode(tree, {
          tile: (id) => this.tiles.get(id)?.tile ?? null,
          setResizing: (value) => {
            this.resizing = value;
          },
          fitVisible: () => this.fitVisible(),
          saveLayout: () => this.saveLayout(),
        }),
      );
    } else {
      this.gridEl.classList.add("empty");
      this.gridEl.appendChild(
        h(
          "div",
          { className: "tc-center" },
          h("button", {
            className: "tc-bigplus",
            attrs: { type: "button", "aria-label": "Start a session" },
            innerHTML: ICONS.plus,
            on: { click: () => this.launcher.openForNew() },
          }),
          h("div", { className: "tc-center-title", textContent: "Start a Claude session" }),
          h("div", { className: "tc-center-desc", textContent: "Spin up one or many terminals. Drag a window onto another's edge to split, and drag the divider between them to resize." }),
        ),
      );
    }

    for (const view of this.views.values()) {
      if (!view.initialised && view.termHost.isConnected && !view.termHost.classList.contains("hidden")) {
        view.term.open(view.termHost);
        view.initialised = true;
      }
    }
    this.syncRenderers();
    this.fitImmediate();
  }

  private syncRenderers(): void {
    let active = 0;
    for (const view of this.views.values()) {
      if (view.webgl === null) continue;
      if (this.viewVisible(view)) {
        active++;
        continue;
      }
      view.webgl.dispose();
      view.webgl = null;
    }
    for (const view of this.views.values()) {
      if (active >= MAX_WEBGL_TERMINALS) break;
      if (!view.initialised || view.webgl !== null || view.webglLost || !this.viewVisible(view)) continue;
      const handle = attachWebglRenderer(view.term, () => {
        view.webgl = null;
        view.webglLost = true;
      });
      if (handle === null) {
        view.webglLost = true;
        continue;
      }
      view.webgl = handle;
      active++;
    }
  }

  private viewVisible(view: TerminalView): boolean {
    return view.termHost.isConnected && !view.termHost.classList.contains("hidden");
  }

  private updateWindowMeta(windowId: string): void {
    const tile = this.tiles.get(windowId);
    if (!tile) return;
    const active = this.state.terminals.find((t) => t.windowId === windowId && t.sessionId === tile.activeId);
    if (active) this.renderTileMeta(tile, active);
  }

  private renderTileMeta(tile: WindowTile, active: TerminalSession): void {
    renderTileMeta(tile, active, sessionStatus(active, this.attention, this.attentionReasons));
  }

  private mountWindow(tile: WindowTile, terminals: readonly TerminalSession[]): void {
    for (const t of terminals) {
      const view = this.views.get(t.sessionId);
      if (!view) continue;
      if (view.termHost.parentElement !== tile.termMount) tile.termMount.appendChild(view.termHost);
      view.termHost.setAttribute("aria-label", `${t.name} terminal`);
      const isActive = t.sessionId === tile.activeId;
      view.termHost.classList.toggle("hidden", !isActive);
      if (isActive && this.atBottom(view.term)) requestAnimationFrame(() => view.term.scrollToBottom());
    }
  }

  private switchTab(windowId: string, sessionId: string): void {
    const tile = this.tiles.get(windowId);
    if (!tile || tile.activeId === sessionId) return;
    tile.activeId = sessionId;
    this.renderGrid();
    this.focusActiveInWindow(windowId);
  }

  private scheduleFit(): void {
    if (this.resizing) return;
    if (this.fitTimer !== null) clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => {
      this.fitTimer = null;
      this.fitVisible();
    }, 200) as unknown as number;
  }

  private fitImmediate(): void {
    if (this.resizing) return;
    if (this.fitTimer !== null) {
      clearTimeout(this.fitTimer);
      this.fitTimer = null;
    }
    requestAnimationFrame(() => this.fitVisible());
  }

  private fitVisible(): void {
    for (const [sessionId, view] of this.views) {
      if (!view.initialised) continue;
      if (view.termHost.clientWidth === 0 || view.termHost.clientHeight === 0) continue;
      const stick = this.atBottom(view.term);
      try {
        view.fit.fit();
      } catch {
        continue;
      }
      if (stick) view.term.scrollToBottom();
      if (view.term.cols === view.lastCols && view.term.rows === view.lastRows) continue;
      view.lastCols = view.term.cols;
      view.lastRows = view.term.rows;
      this.deps.send({ type: "terminalResize", sessionId, cols: view.term.cols, rows: view.term.rows });
    }
  }

  private renderLauncher(): void {
    this.launcher.renderInto(this.launcherEl, this.state, this.activeFolder);
  }

  private flash(message: string, level: "info" | "warning" | "error"): void {
    flashToast(this.root, message, level);
  }

}
