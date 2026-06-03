import { toSpaceId } from "../../../src/features/cockpit/domain/profiles";
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
import { clear, h } from "../ui/h.js";
import { renderLayoutNode } from "./cockpitLayoutView.js";
import { CockpitLauncher } from "./cockpitLauncher.js";
import { createCockpitTerminal, type CockpitTerminalView } from "./terminalCore.js";
import { ALL_FOLDER, compactPath, formatStartTime, newId } from "./cockpitUtils.js";

const RESET_INPUT_MODES = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?2004l";

export interface TerminalCockpitDeps {
  send(msg: CockpitWebviewToHost): void;
}

interface TerminalView extends CockpitTerminalView {
  windowId: string;
  initialised: boolean;
  gotData: boolean;
  lastCols: number;
  lastRows: number;
}

interface WindowTile {
  readonly tile: HTMLElement;
  readonly tabStrip: HTMLElement;
  readonly metaBar: HTMLElement;
  readonly termMount: HTMLElement;
  readonly resumeOverlay: HTMLElement;
  readonly bootingOverlay: HTMLElement;
  readonly status: HTMLElement;
  activeId: string;
  announced: string;
}

type AttentionReason = "stop" | "notify" | "bell";

export class TerminalCockpit {
  private readonly root: HTMLElement;
  private readonly folderBar: HTMLElement;
  private readonly topbarActions: HTMLElement;
  private readonly launcherEl: HTMLElement;
  private readonly gridEl: HTMLElement;
  private readonly launcher: CockpitLauncher;
  private readonly views = new Map<string, TerminalView>();
  private readonly tiles = new Map<string, WindowTile>();

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
  private readonly resizeObserver: ResizeObserver;

  constructor(private readonly deps: TerminalCockpitDeps) {
    this.folderBar = h("div", { className: "tc-folders" });
    this.topbarActions = h("div", { className: "tc-topbar-actions" });
    this.launcherEl = h("div", { className: "tc-launcher hidden" });
    this.gridEl = h("div", { className: "tc-grid" });
    this.launcher = new CockpitLauncher({
      send: (msg) => this.deps.send(msg),
      rerender: () => {
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
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(this.gridEl);
    this.renderFolders();
    this.renderGrid();
  }

  element(): HTMLElement {
    return this.root;
  }

  fitActive(): void {
    this.fitVisible();
  }

  adopt(sessionId: string, name: string, cwd: string | null): void {
    const spaceId = this.activeFolder === ALL_FOLDER ? null : this.activeFolder;
    this.deps.send({ type: "cockpitAdoptSession", sessionId, name, cwd, spaceId });
    this.renderFolders();
  }

  receive(msg: CockpitHostToWebview): void {
    switch (msg.type) {
      case "cockpitState":
        this.state = msg.state;
        this.loaded = true;
        this.syncTerminals(msg.state.terminals);
        this.renderFolders();
        this.renderGrid();
        this.renderLauncher();
        return;
      case "terminalData": {
        const view = this.views.get(msg.sessionId);
        if (view) {
          const stick = this.atBottom(view.term);
          view.term.write(msg.data);
          const tile = this.tiles.get(view.windowId);
          if (!view.gotData) {
            view.gotData = true;
            if (tile && tile.activeId === msg.sessionId) {
              tile.bootingOverlay.classList.add("hidden");
              if (this.pendingFocus.delete(msg.sessionId)) this.focusView(msg.sessionId);
            }
          }
          if (stick && tile && tile.activeId === msg.sessionId) view.term.scrollToBottom();
        }
        return;
      }
      case "terminalExit": {
        const view = this.views.get(msg.sessionId);
        if (view) view.term.write(`${RESET_INPUT_MODES}\r\n\x1b[2m[process exited · code ${msg.exitCode}]\x1b[0m\r\n`);
        this.renderGrid();
        return;
      }
      case "terminalAttention":
        this.markAttention(msg.sessionId, false, msg.reason);
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
        view.term.dispose();
        view.termHost.remove();
        this.views.delete(id);
        this.attention.delete(id);
        this.attentionReasons.delete(id);
        this.pendingFocus.delete(id);
      }
    }
    for (const [wid, tile] of this.tiles) {
      if (!presentWindows.has(wid)) {
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
      input: (data) => this.deps.send({ type: "terminalInput", sessionId: session.sessionId, data }),
      bell: () => this.markAttention(session.sessionId, true, "bell"),
      focus: () => this.focusView(session.sessionId),
      dropImage: (fileName, dataBase64) =>
        this.deps.send({ type: "cockpitDropImage", sessionId: session.sessionId, fileName, dataBase64 }),
    });
    this.views.set(session.sessionId, {
      ...terminal,
      windowId: session.windowId,
      initialised: false,
      gotData: false,
      lastCols: 0,
      lastRows: 0,
    });
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
    const resumeOverlay = h(
      "div",
      { className: "tc-tile-resume hidden" },
      h("button", {
        className: "tc-launch-btn",
        attrs: { type: "button" },
        innerHTML: `<span class="tc-btn-icon">${ICONS.play}</span><span>Resume</span>`,
        on: {
          click: () => {
            const sessionId = this.activeSessionIdForWindow(windowId);
            if (!sessionId) return;
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
            this.deps.send({ type: "cockpitResumeSession", sessionId });
          },
        },
      }),
      h("div", { className: "tc-tile-resume-hint", textContent: "Paused or exited. Click Resume to continue. The transcript reloads from disk." }),
    );
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

    this.wireWindowDrag(head, tile, windowId);

    this.tiles.set(windowId, { tile, tabStrip, metaBar, termMount, resumeOverlay, bootingOverlay, status, activeId: "", announced: "" });
  }

  private markAttention(sessionId: string, notifyHost = true, reason: AttentionReason = "notify"): void {
    const view = this.views.get(sessionId);
    if (!view) return;
    const wasSet = this.attention.has(sessionId);
    this.attention.add(sessionId);
    this.attentionReasons.set(sessionId, reason);
    this.applyAttention(view.windowId);
    this.applyFolderAttention();
    this.applyAttentionSummary();
    this.updateWindowMeta(view.windowId);
    if (notifyHost && !wasSet) {
      const session = this.state.terminals.find((t) => t.sessionId === sessionId);
      this.deps.send({ type: "cockpitAttention", sessionId, name: session?.name ?? "Claude session" });
    }
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

  private wireWindowDrag(head: HTMLElement, tile: HTMLElement, windowId: string): void {
    head.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0 || (e.target instanceof Element && e.target.closest(".tc-tab, .tc-tab-add, .tc-tab-pause"))) return;
      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;
      const onMove = (ev: PointerEvent): void => {
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
          dragging = true;
          tile.classList.add("tc-tile-dragging");
          document.body.classList.add("tc-dragging-window");
        }
        tile.style.transform = `translate(${ev.clientX - startX}px, ${ev.clientY - startY}px)`;
        this.highlightDrop(ev, windowId);
      };
      const onUp = (ev: PointerEvent): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        tile.style.transform = "";
        tile.classList.remove("tc-tile-dragging");
        document.body.classList.remove("tc-dragging-window");
        this.clearDropHint();
        if (!dragging) return;
        const folder = this.folderUnder(ev);
        if (folder !== null) {
          this.moveWindowToFolder(windowId, folder);
          return;
        }
        const hit = this.windowUnder(ev, windowId);
        if (hit) this.dockWindow(windowId, hit.id, hit.edge);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  private windowUnder(ev: PointerEvent, self: string): { id: string; edge: DropEdge } | null {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const tile = el instanceof Element ? (el.closest(".tc-tile[data-window-id]") as HTMLElement | null) : null;
    const id = tile?.dataset["windowId"] ?? null;
    if (!id || id === self) return null;
    return { id, edge: this.edgeOf(tile!, ev) };
  }

  private edgeOf(tile: HTMLElement, ev: PointerEvent): DropEdge {
    const r = tile.getBoundingClientRect();
    const nx = (ev.clientX - (r.left + r.width / 2)) / (r.width / 2);
    const ny = (ev.clientY - (r.top + r.height / 2)) / (r.height / 2);
    if (Math.abs(nx) >= Math.abs(ny)) return nx >= 0 ? "right" : "left";
    return ny >= 0 ? "bottom" : "top";
  }

  private folderUnder(ev: PointerEvent): string | null {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const chip = el instanceof Element ? (el.closest(".tc-folder[data-folder]") as HTMLElement | null) : null;
    return chip?.getAttribute("data-folder") ?? null;
  }

  private highlightDrop(ev: PointerEvent, self: string): void {
    this.clearDropHint();
    const hit = this.windowUnder(ev, self);
    if (hit) {
      const tile = this.tiles.get(hit.id)?.tile;
      tile?.classList.add("tc-drop-target");
      tile?.setAttribute("data-drop-edge", hit.edge);
      return;
    }
    const folder = this.folderUnder(ev);
    if (folder !== null) {
      for (const chip of this.folderBar.querySelectorAll(`[data-folder="${folder}"]`)) chip.classList.add("drop-target");
    }
  }

  private clearDropHint(): void {
    for (const t of this.tiles.values()) {
      t.tile.classList.remove("tc-drop-target");
      t.tile.removeAttribute("data-drop-edge");
    }
    for (const chip of this.folderBar.querySelectorAll(".drop-target")) chip.classList.remove("drop-target");
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
    clear(this.folderBar);
    clear(this.topbarActions);
    const groups = this.groupWindows();
    const windowCount = (folder: string | null): number =>
      [...groups.keys()].filter((wid) => (this.windowFolder(wid) ?? null) === folder).length;

    const tab = (label: string, value: string, count: number, renamable = false) => {
      const el = h(
        "button",
        {
          className: `tc-folder${this.activeFolder === value ? " active" : ""}`,
          attrs: { type: "button", "data-folder": value, ...(renamable ? { title: "Double-click to rename. Drop a session here to file it in this workspace." } : {}) },
          on: { click: () => { this.activeFolder = value; this.renderFolders(); this.renderGrid(); } },
        },
        h("span", { className: "tc-folder-icon", innerHTML: ICONS.folder }),
        h("span", { textContent: label }),
        h("span", { className: "tc-folder-count", textContent: String(count) }),
        h("span", {
          className: `tc-folder-dot${this.folderNeedsAttention(value) ? " on" : ""}`,
          attrs: { "aria-hidden": "true" },
        }),
      );
      if (renamable) {
        el.addEventListener("dblclick", (e) => {
          e.preventDefault();
          this.renamingFolder = value;
          this.renderFolders();
        });
        el.appendChild(
          h("span", {
            className: "tc-folder-del",
            attrs: { role: "button", title: "Delete workspace", "aria-label": `Delete workspace ${label}` },
            innerHTML: ICONS.close,
            on: {
              click: (e: Event) => {
                e.stopPropagation();
                if (this.activeFolder === value) this.activeFolder = ALL_FOLDER;
                this.deps.send({ type: "cockpitDeleteSpace", spaceId: toSpaceId(value) });
              },
            },
          }),
        );
      }
      return el;
    };

    this.folderBar.appendChild(tab("All", ALL_FOLDER, groups.size));
    for (const space of this.state.spaces) {
      if (this.renamingFolder === space.id) {
        this.folderBar.appendChild(this.folderRenameInput(space.id, space.name));
      } else {
        this.folderBar.appendChild(tab(space.name, space.id, windowCount(space.id), true));
      }
    }

    if (this.creatingFolder) {
      const input = h("input", { className: "tc-folder-input", attrs: { type: "text", placeholder: "Workspace name" } }) as HTMLInputElement;
      input.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" && input.value.trim().length > 0) {
          this.deps.send({ type: "cockpitSaveSpace", space: { id: toSpaceId(newId()), name: input.value.trim() } });
          this.creatingFolder = false;
        } else if (e.key === "Escape") {
          this.creatingFolder = false;
          this.renderFolders();
        }
      });
      input.addEventListener("blur", () => { this.creatingFolder = false; this.renderFolders(); });
      this.folderBar.appendChild(input);
      requestAnimationFrame(() => input.focus());
    } else {
      this.folderBar.appendChild(
        h("button", {
          className: "tc-folder-add",
          attrs: { type: "button", title: "Create a workspace to group your sessions", "aria-label": "New workspace" },
          on: { click: () => { this.creatingFolder = true; this.renderFolders(); } },
        },
          h("span", { className: "tc-folder-add-icon", innerHTML: ICONS.plus }),
          h("span", { textContent: "New workspace" }),
        ),
      );
      if (this.state.spaces.length === 0) {
        this.folderBar.appendChild(
          h("span", { className: "tc-folder-hint", textContent: "Group sessions into workspaces" }),
        );
      }
    }

    const attentionCount = this.attentionTerminals().length;
    this.topbarActions.appendChild(
      h("button", {
        className: `tc-attention-jump${attentionCount > 0 ? " on" : ""}`,
        attrs: {
          type: "button",
          title: attentionCount === 0 ? "No sessions need attention" : `${attentionCount} session${attentionCount === 1 ? "" : "s"} need attention. Jump to the oldest one.`,
          "aria-label": attentionCount === 0 ? "No sessions need attention" : `${attentionCount} session${attentionCount === 1 ? "" : "s"} need attention. Jump to the oldest one.`,
          ...(attentionCount === 0 ? { disabled: "true" } : {}),
        },
        innerHTML: `<span class="tc-btn-icon">${ICONS.bell}</span><span class="tc-attention-count">${attentionCount}</span>`,
        on: { click: () => this.jumpToAttention() },
      }),
    );

    this.topbarActions.appendChild(
      h("button", {
        className: "tc-newterminal",
        attrs: { type: "button", title: "Open a plain shell terminal" },
        innerHTML: `<span class="tc-btn-icon">${ICONS.terminal}</span><span>Terminal</span>`,
        on: { click: () => this.deps.send({ type: "cockpitNewTerminal", spaceId: this.activeFolder === ALL_FOLDER ? null : this.activeFolder }) },
      }),
    );

    this.topbarActions.appendChild(
      h("button", {
        className: `tc-newsession${this.launcher.isOpen() ? " active" : ""}`,
        attrs: { type: "button" },
        innerHTML: `<span class="tc-btn-icon">${ICONS.plus}</span><span>Session</span>`,
        on: { click: () => this.launcher.toggle() },
      }),
    );

    this.topbarActions.appendChild(
      h("button", {
        className: `tc-expand${this.fullscreen ? " active" : ""}`,
        attrs: {
          type: "button",
          title: this.fullscreen ? "Exit full screen" : "Full screen",
          "aria-label": this.fullscreen ? "Exit full screen" : "Full screen",
        },
        innerHTML: this.fullscreen ? ICONS.shrink : ICONS.expand,
        on: { click: () => this.toggleFullscreen() },
      }),
    );
  }

  private folderRenameInput(spaceId: string, currentName: string): HTMLElement {
    const input = h("input", {
      className: "tc-folder-input",
      attrs: { type: "text", value: currentName, "aria-label": "Rename workspace" },
    }) as HTMLInputElement;
    let done = false;
    const commit = (save: boolean): void => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name.length > 0 && name !== currentName) {
        this.deps.send({ type: "cockpitSaveSpace", space: { id: toSpaceId(spaceId), name } });
      }
      this.renamingFolder = null;
      this.renderFolders();
    };
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") commit(true);
      else if (e.key === "Escape") commit(false);
    });
    input.addEventListener("blur", () => commit(true));
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return input;
  }

  private toggleFullscreen(): void {
    this.fullscreen = !this.fullscreen;
    document.body.classList.toggle("ct-cockpit-fullscreen", this.fullscreen);
    this.renderFolders();
    this.fitImmediate();
  }

  private renderGrid(): void {
    if (!this.loaded) {
      this.renderSkeleton();
      return;
    }
    const groups = this.groupWindows();
    const visibleIds = this.windowsInFolder();

    for (const wid of visibleIds) {
      const tile = this.tiles.get(wid);
      const terminals = groups.get(wid) ?? [];
      if (!tile || terminals.length === 0) continue;
      if (!terminals.some((t) => t.sessionId === tile.activeId)) tile.activeId = terminals[0]!.sessionId;
      this.renderTabs(tile, wid, terminals);
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
    this.fitImmediate();
  }

  private updateWindowMeta(windowId: string): void {
    const tile = this.tiles.get(windowId);
    if (!tile) return;
    const active = this.state.terminals.find((t) => t.windowId === windowId && t.sessionId === tile.activeId);
    if (active) this.renderTileMeta(tile, active);
  }

  private renderTileMeta(tile: WindowTile, active: TerminalSession): void {
    clear(tile.metaBar);
    const status = this.sessionStatus(active);
    tile.tile.setAttribute("aria-label", `${active.name} session, ${status.label}`);
    this.announceStatus(tile, active.name, status.label);
    tile.metaBar.append(
      h("span", { className: `tc-meta-pill ${status.className}` }, h("span", { className: "tc-meta-dot" }), h("span", { textContent: status.label })),
      h("span", { className: "tc-meta-pill", textContent: active.kind === "shell" ? "Terminal" : "Claude" }),
      h("span", {
        className: "tc-meta-path",
        attrs: { title: active.cwd ?? "VS Code workspace" },
        textContent: active.cwd ? compactPath(active.cwd) : "Workspace",
      }),
      h("span", { className: "tc-meta-time", textContent: formatStartTime(active.startedAtMs) }),
    );
  }

  private announceStatus(tile: WindowTile, name: string, label: string): void {
    const key = `${tile.activeId}:${label}`;
    if (tile.announced === key) return;
    const first = tile.announced === "";
    tile.announced = key;
    if (first) return;
    tile.status.textContent = `${name}: ${label}`;
  }

  private sessionStatus(active: TerminalSession): { readonly className: string; readonly label: string } {
    if (this.attention.has(active.sessionId)) {
      const reason = this.attentionReasons.get(active.sessionId);
      if (reason === "bell") return { className: "attention", label: "Bell" };
      if (reason === "notify") return { className: "attention", label: "Needs you" };
      return { className: "attention", label: "Needs input" };
    }
    if (!active.alive) {
      return active.exitCode === 0
        ? { className: "paused", label: "Paused" }
        : { className: "exited", label: `Exited ${active.exitCode ?? ""}`.trim() };
    }
    return { className: "running", label: "Running" };
  }

  private renderTabs(tile: WindowTile, windowId: string, terminals: readonly TerminalSession[]): void {
    clear(tile.tabStrip);
    const single = terminals.length === 1;
    for (const t of terminals) {
      const chip = h(
        "button",
        {
          className: `tc-tab${t.sessionId === tile.activeId ? " active" : ""}${t.alive ? "" : " exited"}`,
          dataset: { tab: t.sessionId },
          attrs: { type: "button", title: t.name },
        },
        h("span", { className: "tc-tab-dot" }),
        h("span", { className: "tc-tab-name", textContent: t.name }),
        h("span", {
          className: "tc-tab-close",
          attrs: {
            role: "button",
            title: single ? "Close window" : "Close tab",
            "aria-label": single ? `Close ${t.name}` : `Close tab ${t.name}`,
          },
          innerHTML: ICONS.close,
          on: {
            click: (e: Event) => {
              e.stopPropagation();
              this.deps.send({ type: "terminalClose", sessionId: t.sessionId });
            },
          },
        }),
      );
      this.wireTabDrag(chip, tile, windowId, t.sessionId, terminals.length > 1);
      tile.tabStrip.appendChild(chip);
    }
  }

  private wireTabDrag(chip: HTMLElement, tile: WindowTile, windowId: string, sessionId: string, canDetach: boolean): void {
    chip.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0 || (e.target instanceof Element && e.target.closest(".tc-tab-close"))) return;
      const startX = e.clientX;
      const startY = e.clientY;
      let tearing = false;
      let ghost: HTMLElement | null = null;
      const outside = (ev: PointerEvent): boolean => {
        const r = tile.tabStrip.getBoundingClientRect();
        return ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom;
      };
      const move = (ev: PointerEvent): void => {
        if (!tearing) {
          if (!canDetach || Math.hypot(ev.clientX - startX, ev.clientY - startY) < 8) return;
          tearing = true;
          chip.classList.add("tearing");
          document.body.classList.add("tc-tearing");
          ghost = h("div", { className: "tc-tab-ghost", textContent: chip.textContent ?? "" });
          document.body.appendChild(ghost);
        }
        if (ghost) {
          ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 8}px)`;
          ghost.classList.toggle("out", outside(ev));
        }
      };
      const up = (ev: PointerEvent): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        ghost?.remove();
        chip.classList.remove("tearing");
        document.body.classList.remove("tc-tearing");
        if (!tearing) {
          this.switchTab(windowId, sessionId);
        } else if (outside(ev)) {
          this.deps.send({ type: "cockpitDetachTab", sessionId });
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
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

  private renderSkeleton(): void {
    if (this.gridEl.querySelector(".tc-skel-tile")) return;
    this.gridEl.classList.remove("empty");
    for (let i = 0; i < 4; i++) {
      this.gridEl.appendChild(
        h("div", { className: "tc-skel-tile" }, h("div", { className: "tc-skel-head" }), h("div", { className: "tc-skel-body" })),
      );
    }
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

  private buildToast(level: string, icon: string, title: string | undefined, message: string): HTMLElement {
    const body = h("div", { className: "tc-flash-body" });
    if (title) body.appendChild(h("div", { className: "tc-flash-title", textContent: title }));
    body.appendChild(h("div", { className: "tc-flash-msg", textContent: message }));
    const note = h(
      "div",
      { className: `tc-flash ${level}` },
      h("span", { className: "tc-flash-icon", innerHTML: icon }),
      body,
    );
    this.root.appendChild(note);
    requestAnimationFrame(() => note.classList.add("in"));
    return note;
  }

  private removeToast(note: HTMLElement): void {
    note.classList.remove("in");
    setTimeout(() => note.remove(), 220);
  }

  private flash(message: string, level: "info" | "warning" | "error", title?: string): void {
    const icon = level === "error" || level === "warning" ? ICONS.alert : ICONS.check;
    const note = this.buildToast(level, icon, title, message);
    setTimeout(() => this.removeToast(note), 4000);
  }

}
