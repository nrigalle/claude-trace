import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { MODEL_OPTIONS } from "../../../src/shared/models";
import { PERMISSION_MODES } from "../../../src/shared/permissionModes";
import {
  DEFAULT_NAME_TEMPLATE,
  MAX_BATCH,
  clampCount,
  toProfileId,
  toSpaceId,
  type SessionProfile,
} from "../../../src/features/cockpit/domain/profiles";
import type {
  CockpitHostToWebview,
  CockpitLayout,
  CockpitState,
  CockpitWebviewToHost,
  TerminalSession,
} from "../../../src/features/cockpit/protocol";
import { assertNeverCockpit } from "../../../src/features/cockpit/protocol";
import { dock, syncTree, type DropEdge, type LayoutNode } from "../../../src/features/cockpit/domain/splitTree";
import type { ModelChoice } from "../../../src/shared/models";
import type { PermissionMode } from "../../../src/shared/permissionModes";
import { ICONS } from "../ui/icons.js";
import { clear, h } from "../ui/h.js";

export interface TerminalCockpitDeps {
  send(msg: CockpitWebviewToHost): void;
}

interface TerminalView {
  readonly term: Terminal;
  readonly fit: FitAddon;
  readonly termHost: HTMLElement;
  windowId: string;
  initialised: boolean;
  gotData: boolean;
  lastCols: number;
  lastRows: number;
}

interface WindowTile {
  readonly tile: HTMLElement;
  readonly tabStrip: HTMLElement;
  readonly termMount: HTMLElement;
  readonly resumeOverlay: HTMLElement;
  readonly bootingOverlay: HTMLElement;
  activeId: string;
}

const ALL_FOLDER = "__all__";
const CHUNKY_WHEEL_PX = 40;
const TRACKPAD_SCROLL_SENSITIVITY = 2.5;
const ROW_HEIGHT_PER_WEIGHT = 150;

const TERM_THEME: ITheme = {
  background: "#100f14",
  foreground: "#d6d6e0",
  cursor: "#e8956f",
  cursorAccent: "#100f14",
  selectionBackground: "rgba(217,119,87,0.32)",
  selectionForeground: "#ffffff",
  black: "#1b1a22",
  red: "#e0795c",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#c8c8d4",
  brightBlack: "#565666",
  brightRed: "#f08a6a",
  brightGreen: "#b9f27c",
  brightYellow: "#f2c88a",
  brightBlue: "#9bb8ff",
  brightMagenta: "#d2b8ff",
  brightCyan: "#a4dcff",
  brightWhite: "#ffffff",
};

const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export class TerminalCockpit {
  private readonly root: HTMLElement;
  private readonly folderBar: HTMLElement;
  private readonly launcherEl: HTMLElement;
  private readonly gridEl: HTMLElement;
  private readonly views = new Map<string, TerminalView>();
  private readonly tiles = new Map<string, WindowTile>();

  private state: CockpitState = { profiles: [], spaces: [], terminals: [] };
  private loaded = false;
  private activeFolder: string = ALL_FOLDER;
  private launcherOpen = false;
  private creatingFolder = false;
  private renamingFolder: string | null = null;
  private editing: SessionProfile | null = null;
  private quickCount = 1;
  private quickPrefill: SessionProfile | null = null;
  private resizing = false;
  private fitTimer: number | null = null;
  private readonly attention = new Set<string>();
  private readonly trees = new Map<string, LayoutNode | null>();
  private saveLayoutTimer: number | null = null;
  private fullscreen = false;
  private readonly resizeObserver: ResizeObserver;

  constructor(private readonly deps: TerminalCockpitDeps) {
    this.folderBar = h("div", { className: "tc-folders" });
    this.launcherEl = h("div", { className: "tc-launcher hidden" });
    this.gridEl = h("div", { className: "tc-grid" });
    this.root = h(
      "div",
      { className: "tc-root" },
      h("div", { className: "tc-topbar" }, this.folderBar),
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
            if (tile && tile.activeId === msg.sessionId) tile.bootingOverlay.classList.add("hidden");
          }
          if (stick && tile && tile.activeId === msg.sessionId) view.term.scrollToBottom();
        }
        return;
      }
      case "terminalExit": {
        const view = this.views.get(msg.sessionId);
        if (view) view.term.write(`\r\n\x1b[2m[process exited · code ${msg.exitCode}]\x1b[0m\r\n`);
        this.renderGrid();
        return;
      }
      case "terminalAttention":
        this.markAttention(msg.sessionId, false);
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
    const term = new Terminal({
      fontFamily: '"SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.0,
      cursorBlink: false,
      theme: TERM_THEME,
      scrollback: 10000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    this.tameWheel(term);
    const termHost = h("div", { className: "tc-term hidden" });
    term.onData((data) => {
      this.deps.send({ type: "terminalInput", sessionId: session.sessionId, data });
    });
    term.onBell(() => this.markAttention(session.sessionId));
    this.wireImageDrop(termHost, session.sessionId);
    this.views.set(session.sessionId, {
      term,
      fit,
      termHost,
      windowId: session.windowId,
      initialised: false,
      gotData: false,
      lastCols: 0,
      lastRows: 0,
    });
  }

  private wireImageDrop(host: HTMLElement, sessionId: string): void {
    host.addEventListener("dragover", (e: DragEvent) => {
      if (!e.dataTransfer) return;
      const hasFiles = Array.from(e.dataTransfer.items).some((i) => i.kind === "file");
      if (!hasFiles) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      host.classList.add("tc-term-drop");
    });
    host.addEventListener("dragleave", () => host.classList.remove("tc-term-drop"));
    host.addEventListener("drop", (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      host.classList.remove("tc-term-drop");
      for (const file of Array.from(files)) {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          if (typeof result !== "string") return;
          const base64 = result.slice(result.indexOf(",") + 1);
          this.deps.send({ type: "cockpitDropImage", sessionId, fileName: file.name, dataBase64: base64 });
        };
        reader.readAsDataURL(file);
      }
    });
  }

  private createWindowTile(windowId: string): void {
    const tabStrip = h("div", { className: "tc-tabs" });
    const grip = h("span", { className: "tc-tile-grip", innerHTML: ICONS.grip });
    const addTab = h("button", {
      className: "tc-tab-add",
      attrs: { type: "button", title: "New tab in this window", "aria-label": "New tab" },
      innerHTML: ICONS.plus,
      on: { click: () => this.deps.send({ type: "cockpitAddTab", windowId }) },
    });
    const head = h("div", { className: "tc-tile-head", attrs: { title: "Drag to swap places, or drop on a folder" } }, grip, tabStrip, addTab);
    const termMount = h("div", { className: "tc-tile-termmount" });
    const resumeOverlay = h(
      "div",
      { className: "tc-tile-resume hidden" },
      h("button", {
        className: "tc-launch-btn",
        attrs: { type: "button" },
        innerHTML: `<span class="tc-btn-icon">${ICONS.play}</span><span>Resume</span>`,
        on: { click: () => { const tile = this.tiles.get(windowId); if (tile) this.deps.send({ type: "cockpitResumeSession", sessionId: tile.activeId }); } },
      }),
      h("div", { className: "tc-tile-resume-hint", textContent: "This tab ended (or VS Code reloaded). Resume to continue." }),
    );
    const bootingOverlay = h(
      "div",
      { className: "tc-tile-booting" },
      h("div", { className: "tc-tile-booting-dot" }),
      h("div", { className: "tc-tile-booting-text", textContent: "Resuming session…" }),
    );
    const body = h("div", { className: "tc-tile-body" }, termMount, resumeOverlay, bootingOverlay);
    const tile = h("div", { className: "tc-tile", dataset: { windowId } }, head, body);

    this.wireWindowDrag(head, tile, windowId);

    this.tiles.set(windowId, { tile, tabStrip, termMount, resumeOverlay, bootingOverlay, activeId: "" });
  }

  private markAttention(sessionId: string, notifyHost = true): void {
    const view = this.views.get(sessionId);
    if (!view) return;
    const wasSet = this.attention.has(sessionId);
    this.attention.add(sessionId);
    this.applyAttention(view.windowId);
    this.applyFolderAttention();
    if (notifyHost && !wasSet) {
      const session = this.state.terminals.find((t) => t.sessionId === sessionId);
      this.deps.send({ type: "cockpitAttention", sessionId, name: session?.name ?? "Claude session" });
    }
  }

  private clearAttention(sessionId: string): void {
    const view = this.views.get(sessionId);
    if (!view) return;
    this.attention.delete(sessionId);
    this.applyAttention(view.windowId);
    this.applyFolderAttention();
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

  private wireWindowDrag(head: HTMLElement, tile: HTMLElement, windowId: string): void {
    head.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0 || (e.target instanceof Element && e.target.closest(".tc-tab, .tc-tab-add"))) return;
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

  private tryWebgl(term: Terminal): void {
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => addon.dispose());
      term.loadAddon(addon);
    } catch {}
  }

  private atBottom(term: Terminal): boolean {
    return term.buffer.active.viewportY >= term.buffer.active.baseY;
  }

  private tameWheel(term: Terminal): void {
    term.attachCustomWheelEventHandler((ev) => {
      const precision = ev.deltaMode === WheelEvent.DOM_DELTA_PIXEL && Math.abs(ev.deltaY) < CHUNKY_WHEEL_PX;
      const desired = precision ? TRACKPAD_SCROLL_SENSITIVITY : 1;
      if (term.options.scrollSensitivity !== desired) term.options.scrollSensitivity = desired;
      return true;
    });
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

  private buildNode(node: LayoutNode): HTMLElement {
    if (node.kind === "leaf") {
      const tile = this.tiles.get(node.id)?.tile;
      return tile ?? h("div");
    }
    const container = h("div", { className: `tc-split tc-split-${node.dir}` });
    node.children.forEach((child, i) => {
      if (i > 0) container.appendChild(this.makeDivider(node, i - 1));
      const weight = node.sizes[i] ?? 1;
      const cell = h("div", { className: "tc-split-cell" }, this.buildNode(child));
      cell.style.flexGrow = String(weight);
      if (node.dir === "col") cell.style.minHeight = `${weight * ROW_HEIGHT_PER_WEIGHT}px`;
      container.appendChild(cell);
    });
    return container;
  }

  private makeDivider(node: { dir: "row" | "col"; sizes: number[] }, index: number): HTMLElement {
    const horizontal = node.dir === "row";
    const handle = h("div", { className: `tc-divider tc-divider-${horizontal ? "v" : "h"}` });
    handle.addEventListener("pointerdown", (e: PointerEvent) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      this.resizing = true;
      const prev = handle.previousElementSibling as HTMLElement;
      const next = handle.nextElementSibling as HTMLElement;
      const startPos = horizontal ? e.clientX : e.clientY;
      const prevPx = horizontal ? prev.offsetWidth : prev.offsetHeight;
      const nextPx = horizontal ? next.offsetWidth : next.offsetHeight;
      const totalPx = prevPx + nextPx;
      const totalW = (node.sizes[index] ?? 1) + (node.sizes[index + 1] ?? 1);
      const move = (ev: PointerEvent): void => {
        const delta = (horizontal ? ev.clientX : ev.clientY) - startPos;
        const np = Math.max(80, Math.min(totalPx - 80, prevPx + delta));
        const ratio = np / totalPx;
        const a = totalW * ratio;
        const b = totalW * (1 - ratio);
        node.sizes[index] = a;
        node.sizes[index + 1] = b;
        prev.style.flexGrow = String(a);
        next.style.flexGrow = String(b);
        if (!horizontal) {
          prev.style.minHeight = `${a * ROW_HEIGHT_PER_WEIGHT}px`;
          next.style.minHeight = `${b * ROW_HEIGHT_PER_WEIGHT}px`;
        }
      };
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        this.resizing = false;
        this.fitVisible();
        this.saveLayout();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    return handle;
  }

  private renderFolders(): void {
    clear(this.folderBar);
    const groups = this.groupWindows();
    const windowCount = (folder: string | null): number =>
      [...groups.keys()].filter((wid) => (this.windowFolder(wid) ?? null) === folder).length;

    const tab = (label: string, value: string, count: number, renamable = false) => {
      const el = h(
        "button",
        {
          className: `tc-folder${this.activeFolder === value ? " active" : ""}`,
          attrs: { type: "button", "data-folder": value, ...(renamable ? { title: "Double-click to rename" } : {}) },
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
            attrs: { role: "button", title: "Delete folder", "aria-label": `Delete folder ${label}` },
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
      const input = h("input", { className: "tc-folder-input", attrs: { type: "text", placeholder: "Folder name" } }) as HTMLInputElement;
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
          attrs: { type: "button", title: "New folder", "aria-label": "New folder" },
          innerHTML: ICONS.plus,
          on: { click: () => { this.creatingFolder = true; this.renderFolders(); } },
        }),
      );
    }

    this.folderBar.appendChild(h("span", { className: "tc-folder-spacer" }));

    this.folderBar.appendChild(
      h("button", {
        className: "tc-newterminal",
        attrs: { type: "button", title: "Open a plain shell terminal" },
        innerHTML: `<span class="tc-btn-icon">${ICONS.terminal}</span><span>Terminal</span>`,
        on: { click: () => this.deps.send({ type: "cockpitNewTerminal", spaceId: this.activeFolder === ALL_FOLDER ? null : this.activeFolder }) },
      }),
    );

    this.folderBar.appendChild(
      h("button", {
        className: `tc-newsession${this.launcherOpen ? " active" : ""}`,
        attrs: { type: "button" },
        innerHTML: `<span class="tc-btn-icon">${ICONS.plus}</span><span>Session</span>`,
        on: { click: () => { this.launcherOpen = !this.launcherOpen; this.renderFolders(); this.renderLauncher(); } },
      }),
    );

    this.folderBar.appendChild(
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
      attrs: { type: "text", value: currentName, "aria-label": "Rename folder" },
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

  private stepper(initial: number, min: number, max: number, icon: string, title: string, onChange: (v: number) => void): HTMLElement {
    let value = initial;
    const valEl = h("span", { className: "tc-stepper-val", textContent: String(value) });
    const set = (next: number): void => {
      const clamped = Math.max(min, Math.min(max, next));
      if (clamped === value) return;
      value = clamped;
      valEl.textContent = String(value);
      onChange(value);
    };
    return h(
      "div",
      { className: "tc-stepper", attrs: { title } },
      h("span", { className: "tc-stepper-icon", innerHTML: icon }),
      h("button", {
        className: "tc-stepper-btn",
        attrs: { type: "button", "aria-label": `Decrease ${title}` },
        textContent: "−",
        on: { click: () => set(value - 1) },
      }),
      valEl,
      h("button", {
        className: "tc-stepper-btn",
        attrs: { type: "button", "aria-label": `Increase ${title}` },
        textContent: "+",
        on: { click: () => set(value + 1) },
      }),
    );
  }

  private toggleFullscreen(): void {
    this.fullscreen = !this.fullscreen;
    document.body.classList.toggle("ct-cockpit-fullscreen", this.fullscreen);
    this.renderFolders();
    this.scheduleFit();
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
    }

    const tree = syncTree(this.trees.get(this.activeFolder) ?? null, visibleIds);
    this.trees.set(this.activeFolder, tree);

    clear(this.gridEl);
    if (tree) {
      this.gridEl.classList.remove("empty");
      this.gridEl.appendChild(this.buildNode(tree));
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
            on: { click: () => { this.launcherOpen = true; this.renderFolders(); this.renderLauncher(); } },
          }),
          h("div", { className: "tc-center-title", textContent: "Start a Claude session" }),
          h("div", { className: "tc-center-desc", textContent: "Spin up one or many terminals. Drag a window onto another's edge to split, and drag the divider between them to resize." }),
        ),
      );
    }

    for (const view of this.views.values()) {
      if (!view.initialised && view.termHost.isConnected && !view.termHost.classList.contains("hidden")) {
        view.term.open(view.termHost);
        this.tryWebgl(view.term);
        view.initialised = true;
      }
    }
    this.scheduleFit();
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
      const isActive = t.sessionId === tile.activeId;
      view.termHost.classList.toggle("hidden", !isActive);
      if (isActive) requestAnimationFrame(() => view.term.scrollToBottom());
    }
  }

  private switchTab(windowId: string, sessionId: string): void {
    const tile = this.tiles.get(windowId);
    if (!tile || tile.activeId === sessionId) return;
    tile.activeId = sessionId;
    this.renderGrid();
  }

  private scheduleFit(): void {
    if (this.resizing) return;
    if (this.fitTimer !== null) clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => {
      this.fitTimer = null;
      this.fitVisible();
    }, 200) as unknown as number;
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
      try {
        view.fit.fit();
      } catch {
        continue;
      }
      view.term.scrollToBottom();
      if (view.term.cols === view.lastCols && view.term.rows === view.lastRows) continue;
      view.lastCols = view.term.cols;
      view.lastRows = view.term.rows;
      this.deps.send({ type: "terminalResize", sessionId, cols: view.term.cols, rows: view.term.rows });
    }
  }

  private renderLauncher(): void {
    this.launcherEl.classList.toggle("hidden", !this.launcherOpen);
    clear(this.launcherEl);
    if (!this.launcherOpen) return;
    if (this.editing) {
      this.launcherEl.appendChild(this.profileForm(this.editing));
      return;
    }
    this.launcherEl.appendChild(this.quickForm());
  }

  private closeLauncher(): void {
    this.launcherOpen = false;
    this.quickPrefill = null;
    this.renderFolders();
    this.renderLauncher();
  }

  private quickForm(): HTMLElement {
    const pre = this.quickPrefill;
    const nameInput = h("input", { className: "tc-field-input", attrs: { type: "text", placeholder: "Claude", value: pre?.name ?? "" } }) as HTMLInputElement;
    const modelSel = this.selectFrom(MODEL_OPTIONS.map((m) => ({ value: m.id, label: m.label })), pre?.model ?? "default");
    const modeSel = this.selectFrom(PERMISSION_MODES.map((m) => ({ value: m.mode, label: m.label })), pre?.permissionMode ?? "default");
    const spaceSel = this.selectFrom(
      [{ value: "", label: "No folder" }, ...this.state.spaces.map((s) => ({ value: s.id, label: s.name }))],
      pre?.spaceId ?? (this.activeFolder === ALL_FOLDER ? "" : this.activeFolder),
    );
    const prompt = h("textarea", { className: "tc-prompt", attrs: { rows: "2", placeholder: "Optional first prompt (sent to every terminal)" } }) as HTMLTextAreaElement;
    if (pre?.initialPrompt) prompt.value = pre.initialPrompt;
    this.quickCount = clampCount(pre?.defaultCount ?? this.quickCount);
    const countStepper = this.stepper(this.quickCount, 1, MAX_BATCH, ICONS.terminal, "How many terminals", (v) => { this.quickCount = v; });

    const launch = h("button", {
      className: "tc-launch-btn tc-launch-primary",
      attrs: { type: "button" },
      innerHTML: `<span class="tc-btn-icon">${ICONS.play}</span><span>Launch</span>`,
      on: {
        click: () => {
          this.deps.send({
            type: "cockpitQuickLaunch",
            name: nameInput.value,
            model: modelSel.value as ModelChoice,
            permissionMode: modeSel.value as PermissionMode,
            cwd: null,
            spaceId: spaceSel.value === "" ? null : spaceSel.value,
            count: clampCount(this.quickCount),
            prompt: prompt.value.trim().length > 0 ? prompt.value : null,
          });
          if (spaceSel.value !== "") this.activeFolder = spaceSel.value;
          this.closeLauncher();
        },
      },
    });

    const field = (label: string, control: HTMLElement) =>
      h("label", { className: "tc-qfield" }, h("span", { className: "tc-qlabel", textContent: label }), control);

    const grid = h(
      "div",
      { className: "tc-quick-grid" },
      field("Name", nameInput),
      field("Model", modelSel),
      field("Permissions", modeSel),
      field("Folder", spaceSel),
      field("Terminals", countStepper),
    );

    const profilesRow = h("div", { className: "tc-profile-chips" });
    for (const p of this.state.profiles) {
      profilesRow.appendChild(
        h("button", {
          className: `tc-chip${pre?.id === p.id ? " active" : ""}`,
          attrs: { type: "button", title: `Use “${p.name}” settings` },
          textContent: p.name,
          on: { click: () => { this.quickPrefill = p; this.renderLauncher(); } },
        }),
      );
    }
    profilesRow.appendChild(
      h("button", {
        className: "tc-chip tc-chip-ghost",
        attrs: { type: "button" },
        textContent: "＋ Save as profile",
        on: { click: () => { this.editing = this.draftFromQuick(nameInput.value, modelSel.value, modeSel.value, spaceSel.value, prompt.value); this.renderLauncher(); } },
      }),
    );

    const close = h("button", {
      className: "tc-quick-close",
      attrs: { type: "button", title: "Close", "aria-label": "Close session setup" },
      innerHTML: ICONS.close,
      on: { click: () => this.closeLauncher() },
    });

    return h(
      "div",
      { className: "tc-quick" },
      h("div", { className: "tc-quick-head" }, h("span", { className: "tc-quick-title", textContent: "New session" }), h("span", { className: "tc-quick-spacer" }), close),
      grid,
      prompt,
      h("div", { className: "tc-quick-actions" }, launch, h("span", { className: "tc-quick-spacer" }), profilesRow),
    );
  }

  private draftFromQuick(name: string, model: string, mode: string, space: string, prompt: string): SessionProfile {
    return {
      id: newId() as SessionProfile["id"],
      name: name.trim().length > 0 ? name.trim() : "",
      model: model as SessionProfile["model"],
      permissionMode: mode as SessionProfile["permissionMode"],
      cwd: null,
      nameTemplate: DEFAULT_NAME_TEMPLATE,
      initialPrompt: prompt.trim().length > 0 ? prompt : null,
      defaultCount: clampCount(this.quickCount),
      spaceId: space === "" ? null : toSpaceId(space),
    };
  }

  private selectFrom(options: ReadonlyArray<{ value: string; label: string }>, selected: string): HTMLSelectElement {
    const sel = h("select", { className: "tc-field-input" }) as HTMLSelectElement;
    for (const o of options) {
      const opt = h("option", { textContent: o.label, attrs: { value: o.value } }) as HTMLOptionElement;
      if (o.value === selected) opt.selected = true;
      sel.appendChild(opt);
    }
    return sel;
  }

  private profileForm(profile: SessionProfile): HTMLElement {
    let draft: SessionProfile = profile;
    const set = (patch: Partial<SessionProfile>) => { draft = { ...draft, ...patch }; };
    const textField = (label: string, value: string, on: (v: string) => void, placeholder = "") => {
      const input = h("input", { className: "tc-field-input", attrs: { type: "text", value, placeholder } }) as HTMLInputElement;
      input.addEventListener("input", () => on(input.value));
      return h("label", { className: "tc-field" }, h("span", { textContent: label }), input);
    };
    const modelSel = this.selectFrom(MODEL_OPTIONS.map((m) => ({ value: m.id, label: m.label })), draft.model);
    modelSel.addEventListener("change", () => set({ model: modelSel.value as SessionProfile["model"] }));
    const modeSel = this.selectFrom(PERMISSION_MODES.map((m) => ({ value: m.mode, label: m.label })), draft.permissionMode);
    modeSel.addEventListener("change", () => set({ permissionMode: modeSel.value as SessionProfile["permissionMode"] }));
    const spaceSel = this.selectFrom(
      [{ value: "", label: "No folder" }, ...this.state.spaces.map((s) => ({ value: s.id, label: s.name }))],
      draft.spaceId ?? "",
    );
    spaceSel.addEventListener("change", () => set({ spaceId: spaceSel.value === "" ? null : toSpaceId(spaceSel.value) }));
    const countInput = h("input", { className: "tc-field-input", attrs: { type: "number", min: "1", max: String(MAX_BATCH), value: String(draft.defaultCount) } }) as HTMLInputElement;
    countInput.addEventListener("change", () => { const c = clampCount(Number(countInput.value)); set({ defaultCount: c }); countInput.value = String(c); });
    const save = h("button", {
      className: "tc-launch-btn",
      attrs: { type: "button" },
      textContent: "Save profile",
      on: { click: () => { this.deps.send({ type: "cockpitSaveProfile", profile: draft }); this.editing = null; this.renderLauncher(); } },
    });
    const cancel = h("button", { className: "tc-link", attrs: { type: "button" }, textContent: "Cancel", on: { click: () => { this.editing = null; this.renderLauncher(); } } });
    const del = this.state.profiles.some((p) => p.id === draft.id)
      ? h("button", { className: "tc-link tc-danger", attrs: { type: "button" }, textContent: "Delete", on: { click: () => { this.deps.send({ type: "cockpitDeleteProfile", profileId: toProfileId(draft.id) }); this.editing = null; this.renderLauncher(); } } })
      : null;
    return h(
      "div",
      { className: "tc-form" },
      textField("Profile name", draft.name, (v) => set({ name: v }), "e.g. Reviewer"),
      h("label", { className: "tc-field" }, h("span", { textContent: "Model" }), modelSel),
      h("label", { className: "tc-field" }, h("span", { textContent: "Permission mode" }), modeSel),
      textField("Working directory", draft.cwd ?? "", (v) => set({ cwd: v.trim() === "" ? null : v }), "Defaults to the workspace root"),
      textField("Name template", draft.nameTemplate, (v) => set({ nameTemplate: v }), "{profile} {n}"),
      textField("Initial prompt", draft.initialPrompt ?? "", (v) => set({ initialPrompt: v.trim() === "" ? null : v }), "Optional"),
      h("label", { className: "tc-field" }, h("span", { textContent: "Default count" }), countInput),
      h("label", { className: "tc-field" }, h("span", { textContent: "Folder" }), spaceSel),
      h("div", { className: "tc-form-actions" }, save, cancel, del),
    );
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
