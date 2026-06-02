import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CockpitState, CockpitWebviewToHost, TerminalSession } from "../../../src/features/cockpit/protocol";

const COCKPIT_CSS = readFileSync(resolve(process.cwd(), "media/styles/cockpit.css"), "utf8");

const cssBlock = (selector: string): string => {
  const start = COCKPIT_CSS.indexOf(selector + " {");
  const open = COCKPIT_CSS.indexOf("{", start);
  const close = COCKPIT_CSS.indexOf("}", open);
  return start < 0 ? "" : COCKPIT_CSS.slice(open + 1, close);
};

interface FakeBuffer {
  active: { type: "normal" | "alternate"; viewportY: number; baseY: number };
}
interface FakeTerm {
  dataCb: ((d: string) => void) | null;
  bellCb: (() => void) | null;
  keyCb: ((e: KeyboardEvent) => boolean) | null;
  cols: number;
  rows: number;
  scrolls: number;
  focuses: number;
  buffer: FakeBuffer;
  selection: string;
  pastes: string[];
  oscHandlers: ((data: string) => boolean)[];
  options: FakeTermOptions;
}
interface FakeTermOptions {
  altClickMovesCursor?: boolean;
  macOptionClickForcesSelection?: boolean;
  minimumContrastRatio?: number;
  theme?: { selectionBackground?: string; selectionInactiveBackground?: string; selectionForeground?: string };
}
const terms: FakeTerm[] = [];

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    dataCb: ((d: string) => void) | null = null;
    bellCb: (() => void) | null = null;
    keyCb: ((e: KeyboardEvent) => boolean) | null = null;
    cols = 80;
    rows = 24;
    scrolls = 0;
    focuses = 0;
    buffer: FakeBuffer = { active: { type: "normal", viewportY: 0, baseY: 0 } };
    selection = "";
    pastes: string[] = [];
    oscHandlers: ((data: string) => boolean)[] = [];
    options: FakeTermOptions;
    unicode = { activeVersion: "" };
    parser = {
      registerOscHandler: (id: number, cb: (data: string) => boolean) => {
        if (id === 52) this.oscHandlers.push(cb);
        return { dispose: (): void => {} };
      },
    };
    constructor(options: FakeTermOptions) {
      this.options = options;
      terms.push(this as unknown as FakeTerm);
    }
    loadAddon(): void {}
    onData(cb: (d: string) => void): void {
      this.dataCb = cb;
    }
    onBell(cb: () => void): void {
      this.bellCb = cb;
    }
    attachCustomKeyEventHandler(cb: (e: KeyboardEvent) => boolean): void {
      this.keyCb = cb;
    }
    onSelectionChange(): void {}
    getSelection(): string {
      return this.selection;
    }
    clearSelection(): void {
      this.selection = "";
    }
    open(): void {}
    write(): void {}
    paste(data: string): void {
      this.pastes.push(data);
      this.dataCb?.(data.replace(/\r\n/g, "\r").replace(/\n/g, "\r"));
    }
    dispose(): void {}
    scrollToBottom(): void {
      this.scrolls += 1;
    }
    focus(): void {
      this.focuses += 1;
    }
  },
}));
let totalFitCalls = 0;
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {
      totalFitCalls += 1;
    }
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {},
}));

const term = (
  sessionId: string,
  windowId: string,
  name: string,
  extra: Partial<TerminalSession> = {},
): TerminalSession => ({
  sessionId,
  windowId,
  name,
  spaceId: null,
  cwd: null,
  alive: true,
  exitCode: null,
  startedAtMs: 0,
  kind: "claude",
  ...extra,
});

const state = (terminals: TerminalSession[], spaces: CockpitState["spaces"] = []): CockpitState => ({
  profiles: [],
  spaces,
  terminals,
});

let sent: CockpitWebviewToHost[];
let cockpit: import("../../../media/src/cockpit/TerminalCockpit").TerminalCockpit;

const loadCockpit = async () => {
  const mod = await import(`../../../media/src/cockpit/TerminalCockpit?ts=${Date.now()}`);
  return mod.TerminalCockpit;
};

beforeEach(async () => {
  terms.length = 0;
  sent = [];
  totalFitCalls = 0;
  document.body.innerHTML = "";
  const TerminalCockpit = await loadCockpit();
  cockpit = new TerminalCockpit({ send: (m: CockpitWebviewToHost) => sent.push(m) });
  document.body.appendChild(cockpit.element());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
  document.body.innerHTML = "";
});

const tiles = (): HTMLElement[] => Array.from(document.querySelectorAll(".tc-tile"));
const visibleTiles = (): HTMLElement[] => tiles().filter((t) => !t.classList.contains("hidden"));
const tabsIn = (tile: HTMLElement): HTMLElement[] => Array.from(tile.querySelectorAll(".tc-tab"));

const installClipboard = (readValue = ""): string[] => {
  const writes: string[] = [];
  const clipboard: Pick<Clipboard, "readText" | "writeText"> = {
    readText: () => Promise.resolve(readValue),
    writeText: (text: string) => {
      writes.push(text);
      return Promise.resolve();
    },
  };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  return writes;
};

describe("TerminalCockpit — windows, tabs and folders", () => {
  it("renders one tile per window, each showing the session name", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "Reviewer 1"), term("b", "b", "Reviewer 2")]) });
    expect(visibleTiles()).toHaveLength(2);
    const names = Array.from(document.querySelectorAll(".tc-tab-name")).map((n) => n.textContent);
    expect(names).toEqual(["Reviewer 1", "Reviewer 2"]);
  });

  it("groups terminals sharing a windowId into ONE tile with multiple tabs", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "w", "Main"), term("b", "w", "Main · 2")]) });
    expect(visibleTiles()).toHaveLength(1);
    expect(tabsIn(visibleTiles()[0]!)).toHaveLength(2);
  });

  it("shows a close button on EVERY tab, including a lone single tab (regression: could not remove a 1-tab window)", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "Solo")]) });
    const closeBtn = visibleTiles()[0]!.querySelector(".tc-tab-close");
    expect(closeBtn).not.toBeNull();
    (closeBtn as HTMLElement).click();
    expect(sent).toContainEqual({ type: "terminalClose", sessionId: "a" });
  });

  it("the + button adds a tab to that window", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "Solo")]) });
    (visibleTiles()[0]!.querySelector(".tc-tab-add") as HTMLElement).click();
    expect(sent).toContainEqual({ type: "cockpitAddTab", windowId: "a" });
  });

  it("shows only the active folder's windows and preserves the tile element across folder switches", () => {
    cockpit.receive({
      type: "cockpitState",
      state: state(
        [term("a", "a", "In space", { spaceId: "s1" }), term("b", "b", "No space")],
        [{ id: "s1" as never, name: "Work" }],
      ),
    });
    expect(tiles()).toHaveLength(2);
    const tileA = document.querySelector('.tc-tile[data-window-id="a"]');
    const folder = (label: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(".tc-folder")).find((b) => b.textContent?.includes(label))!;
    folder("Work").click();
    expect(tiles()).toHaveLength(1);
    expect(document.querySelector('.tc-tile[data-window-id="a"]')).toBe(tileA);
    folder("All").click();
    expect(tiles()).toHaveLength(2);
    expect(document.querySelector('.tc-tile[data-window-id="a"]')).toBe(tileA);
  });
});

describe("TerminalCockpit — renaming folders after creation", () => {
  const withFolder = () =>
    cockpit.receive({
      type: "cockpitState",
      state: state([term("a", "a", "X", { spaceId: "s1" })], [{ id: "s1" as never, name: "Work" }]),
    });

  const folderTab = (label: string): HTMLElement =>
    Array.from(document.querySelectorAll<HTMLElement>(".tc-folder")).find((b) => b.textContent?.includes(label))!;

  it("double-clicking a real folder swaps it for an inline input prefilled with its name", () => {
    withFolder();
    folderTab("Work").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = document.querySelector(".tc-folder-input") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("Work");
  });

  it("Enter sends cockpitSaveSpace with the SAME id and the new name (a rename, not a new folder)", () => {
    withFolder();
    folderTab("Work").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = document.querySelector(".tc-folder-input") as HTMLInputElement;
    input.value = "Reviews";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sent).toContainEqual({ type: "cockpitSaveSpace", space: { id: "s1", name: "Reviews" } });
  });

  it("Escape cancels without sending anything", () => {
    withFolder();
    folderTab("Work").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = document.querySelector(".tc-folder-input") as HTMLInputElement;
    input.value = "Nope";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(sent.some((m) => m.type === "cockpitSaveSpace")).toBe(false);
    expect(document.querySelector(".tc-folder-input")).toBeNull();
  });

  it("an unchanged or blank name does not emit a rename", () => {
    withFolder();
    folderTab("Work").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    let input = document.querySelector(".tc-folder-input") as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    folderTab("Work").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    input = document.querySelector(".tc-folder-input") as HTMLInputElement;
    input.value = "   ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sent.some((m) => m.type === "cockpitSaveSpace")).toBe(false);
  });

  it("the All tab is not renamable", () => {
    withFolder();
    folderTab("All").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(document.querySelector(".tc-folder-input")).toBeNull();
  });

  it("a real folder has a delete button that sends cockpitDeleteSpace with its id", () => {
    withFolder();
    const del = folderTab("Work").querySelector(".tc-folder-del") as HTMLElement;
    expect(del).not.toBeNull();
    del.click();
    expect(sent).toContainEqual({ type: "cockpitDeleteSpace", spaceId: "s1" });
  });

  it("the All tab has no delete button", () => {
    withFolder();
    expect(folderTab("All").querySelector(".tc-folder-del")).toBeNull();
  });
});

describe("TerminalCockpit — split-tree layout", () => {
  const tile = (wid: string): HTMLElement | null => document.querySelector(`.tc-tile[data-window-id="${wid}"]`);
  const rootSplit = (): HTMLElement | null => document.querySelector(".tc-grid > .tc-split");

  it("a single window fills the grid with no split or divider", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    expect(document.querySelector(".tc-grid > .tc-tile[data-window-id='a']")).not.toBeNull();
    expect(rootSplit()).toBeNull();
    expect(document.querySelector(".tc-divider")).toBeNull();
  });

  it("two windows render a row split with one divider between them", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "A"), term("b", "b", "B")]) });
    expect(rootSplit()!.classList.contains("tc-split-row")).toBe(true);
    expect(document.querySelectorAll(".tc-divider")).toHaveLength(1);
    expect(document.querySelector(".tc-divider")!.classList.contains("tc-divider-v")).toBe(true);
    expect(tile("a")).not.toBeNull();
    expect(tile("b")).not.toBeNull();
  });

  it("a third window joins the root split, giving two dividers", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "A"), term("b", "b", "B"), term("c", "c", "C")]) });
    expect(document.querySelectorAll(".tc-tile")).toHaveLength(3);
    expect(document.querySelectorAll(".tc-divider")).toHaveLength(2);
  });

  it("restores a saved split tree on reload (a column split renders a horizontal divider)", () => {
    cockpit.receive({
      type: "cockpitLayout",
      layout: {
        trees: {
          __all__: {
            kind: "split",
            dir: "col",
            sizes: [2, 1],
            children: [
              { kind: "leaf", id: "a" },
              { kind: "leaf", id: "b" },
            ],
          },
        },
      },
    });
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "A"), term("b", "b", "B")]) });
    expect(rootSplit()!.classList.contains("tc-split-col")).toBe(true);
    expect(document.querySelector(".tc-divider")!.classList.contains("tc-divider-h")).toBe(true);
    const cells = document.querySelectorAll<HTMLElement>(".tc-split-cell");
    expect(cells[0]!.style.flexGrow).toBe("2");
    expect(cells[1]!.style.flexGrow).toBe("1");
  });

  it("renders nested splits (a column nested inside the root row)", () => {
    cockpit.receive({
      type: "cockpitLayout",
      layout: {
        trees: {
          __all__: {
            kind: "split",
            dir: "row",
            sizes: [1, 1],
            children: [
              { kind: "split", dir: "col", sizes: [1, 1], children: [{ kind: "leaf", id: "a" }, { kind: "leaf", id: "b" }] },
              { kind: "leaf", id: "c" },
            ],
          },
        },
      },
    });
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "A"), term("b", "b", "B"), term("c", "c", "C")]) });
    const root = document.querySelector(".tc-grid > .tc-split.tc-split-row");
    expect(root).not.toBeNull();
    expect(root!.querySelector(".tc-split.tc-split-col")).not.toBeNull();
  });
});

describe("TerminalCockpit — quick launch", () => {
  it("sends cockpitQuickLaunch with the entered name and count", () => {
    cockpit.receive({ type: "cockpitState", state: state([]) });
    (document.querySelector(".tc-newsession") as HTMLElement).click();
    const nameInput = document.querySelector(".tc-quick-grid .tc-field-input") as HTMLInputElement;
    nameInput.value = "Scratch";
    const plus = Array.from(document.querySelectorAll<HTMLElement>(".tc-quick .tc-stepper-btn")).find(
      (b) => b.textContent === "+",
    )!;
    plus.click();
    (document.querySelector(".tc-launch-primary") as HTMLElement).click();
    const launch = sent.find((m) => m.type === "cockpitQuickLaunch");
    expect(launch).toMatchObject({ type: "cockpitQuickLaunch", name: "Scratch", count: 2 });
  });

  it("closes the launcher with the × button", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    (document.querySelector(".tc-newsession") as HTMLElement).click();
    expect(document.querySelector(".tc-quick")).not.toBeNull();
    (document.querySelector(".tc-quick-close") as HTMLElement).click();
    expect(document.querySelector(".tc-quick")).toBeNull();
  });
});

describe("TerminalCockpit — attention border survives structural changes (regression: flicker on add-tab/remove)", () => {
  it("a host terminalAttention lights the window border without sending a duplicate cockpitAttention back", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    cockpit.receive({ type: "terminalAttention", sessionId: "a", reason: "stop" });
    expect(visibleTiles()[0]!.classList.contains("attention")).toBe(true);
    expect(sent.some((m) => m.type === "cockpitAttention")).toBe(false);
  });

  it("lights the folder dot (and the All dot) on a new attention signal, with no in-app toast", () => {
    cockpit.receive({
      type: "cockpitState",
      state: state([term("a", "a", "Reviewer 1", { spaceId: "s1" })], [{ id: "s1" as never, name: "Work" }]),
    });
    cockpit.receive({ type: "terminalAttention", sessionId: "a", reason: "stop" });
    expect(document.querySelector(".tc-flash")).toBeNull();
    const dot = (folder: string) =>
      document.querySelector(`.tc-folder[data-folder="${folder}"] .tc-folder-dot`) as HTMLElement;
    expect(dot("s1").classList.contains("on")).toBe(true);
    expect(dot("__all__").classList.contains("on")).toBe(true);
  });

  it("lights only the folders with a waiting session — unrelated folders stay dark, the All dot aggregates", () => {
    cockpit.receive({
      type: "cockpitState",
      state: state(
        [term("a", "a", "X", { spaceId: "s1" }), term("b", "b", "Y", { spaceId: "s2" })],
        [
          { id: "s1" as never, name: "Work" },
          { id: "s2" as never, name: "Play" },
        ],
      ),
    });
    cockpit.receive({ type: "terminalAttention", sessionId: "a", reason: "stop" });
    const dotOn = (folder: string) =>
      (document.querySelector(`.tc-folder[data-folder="${folder}"] .tc-folder-dot`) as HTMLElement).classList.contains(
        "on",
      );
    expect(dotOn("s1")).toBe(true);
    expect(dotOn("s2")).toBe(false);
    expect(dotOn("__all__")).toBe(true);
  });

  it("a repeated signal on an already-waiting session keeps exactly one lit folder dot, never a toast", () => {
    cockpit.receive({
      type: "cockpitState",
      state: state([term("a", "a", "X", { spaceId: "s1" })], [{ id: "s1" as never, name: "Work" }]),
    });
    cockpit.receive({ type: "terminalAttention", sessionId: "a", reason: "stop" });
    cockpit.receive({ type: "terminalAttention", sessionId: "a", reason: "stop" });
    expect(document.querySelectorAll(".tc-flash")).toHaveLength(0);
    expect(document.querySelectorAll('.tc-folder[data-folder="s1"] .tc-folder-dot.on')).toHaveLength(1);
  });

  it("KEEPS the same tile element AND its attention class when another window is added", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    const tileBefore = visibleTiles()[0]!;
    cockpit.receive({ type: "terminalAttention", sessionId: "a", reason: "stop" });
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X"), term("b", "b", "Y")]) });
    const tileA = document.querySelector('.tc-tile[data-window-id="a"]') as HTMLElement;
    expect(tileA).toBe(tileBefore);
    expect(tileA.classList.contains("attention")).toBe(true);
  });

  it("KEEPS attention on a window when a tab is added to it", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "w", "Main")]) });
    cockpit.receive({ type: "terminalAttention", sessionId: "a", reason: "stop" });
    cockpit.receive({ type: "cockpitState", state: state([term("a", "w", "Main"), term("b", "w", "Main · 2")]) });
    const tile = document.querySelector('.tc-tile[data-window-id="w"]') as HTMLElement;
    expect(tile.classList.contains("attention")).toBe(true);
  });

  it("KEEPS attention when removing a DIFFERENT window (no re-append churn)", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X"), term("b", "b", "Y")]) });
    cockpit.receive({ type: "terminalAttention", sessionId: "a", reason: "stop" });
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    const tileA = document.querySelector('.tc-tile[data-window-id="a"]') as HTMLElement;
    expect(tileA.classList.contains("attention")).toBe(true);
  });

  it("KEEPS attention across a folder switch", () => {
    cockpit.receive({
      type: "cockpitState",
      state: state([term("a", "a", "X", { spaceId: "s1" })], [{ id: "s1" as never, name: "Work" }]),
    });
    cockpit.receive({ type: "terminalAttention", sessionId: "a", reason: "stop" });
    const work = Array.from(document.querySelectorAll<HTMLElement>(".tc-folder")).find((b) =>
      b.textContent?.includes("Work"),
    )!;
    work.click();
    const tileA = document.querySelector('.tc-tile[data-window-id="a"]') as HTMLElement;
    expect(tileA.classList.contains("attention")).toBe(true);
  });

  it("does NOT clear the border when the user merely types or clicks (only when the agent is active again)", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    cockpit.receive({ type: "terminalAttention", sessionId: "a", reason: "stop" });
    expect(visibleTiles()[0]!.classList.contains("attention")).toBe(true);
    terms[0]!.dataCb?.("h");
    visibleTiles()[0]!.click();
    expect(visibleTiles()[0]!.classList.contains("attention")).toBe(true);
  });

  it("clears the border AND the folder dot only on terminalActive (agent started a new turn)", () => {
    cockpit.receive({
      type: "cockpitState",
      state: state([term("a", "a", "X", { spaceId: "s1" })], [{ id: "s1" as never, name: "Work" }]),
    });
    cockpit.receive({ type: "terminalAttention", sessionId: "a", reason: "stop" });
    const dot = () => document.querySelector('.tc-folder[data-folder="s1"] .tc-folder-dot') as HTMLElement;
    expect(dot().classList.contains("on")).toBe(true);
    cockpit.receive({ type: "terminalActive", sessionId: "a" });
    expect(visibleTiles()[0]!.classList.contains("attention")).toBe(false);
    expect(dot().classList.contains("on")).toBe(false);
  });

  it("shows a stable attention jump and moves to the oldest waiting session", () => {
    cockpit.receive({
      type: "cockpitState",
      state: state(
        [term("a", "a", "A", { spaceId: "s1" }), term("b", "b", "B", { spaceId: "s2" })],
        [
          { id: "s1" as never, name: "One" },
          { id: "s2" as never, name: "Two" },
        ],
      ),
    });
    (document.querySelector('.tc-folder[data-folder="s1"]') as HTMLElement).click();
    cockpit.receive({ type: "terminalAttention", sessionId: "b", reason: "stop" });
    const jump = document.querySelector<HTMLButtonElement>(".tc-attention-jump")!;
    expect(jump.disabled).toBe(false);
    expect(jump.textContent).toContain("1");
    jump.click();
    expect((document.querySelector('.tc-folder[data-folder="s2"]') as HTMLElement).classList.contains("active")).toBe(true);
    expect((document.querySelector('.tc-tile[data-window-id="b"]') as HTMLElement).classList.contains("attention")).toBe(true);
  });

  it("keeps pane metadata visible so status and cwd are readable without opening the terminal", () => {
    cockpit.receive({
      type: "cockpitState",
      state: state([term("a", "a", "X", { cwd: "/Users/alex/code/my-api", startedAtMs: 1_765_000_000_000 })]),
    });
    const meta = visibleTiles()[0]!.querySelector(".tc-tile-meta") as HTMLElement;
    expect(meta.textContent).toContain("Running");
    expect(meta.textContent).toContain("Claude");
    expect(meta.textContent).toContain("my-api");
    cockpit.receive({ type: "terminalAttention", sessionId: "a", reason: "stop" });
    expect(meta.textContent).toContain("Needs input");
  });

  it("drops attention state for a window that is fully closed", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    cockpit.receive({ type: "terminalAttention", sessionId: "a", reason: "stop" });
    cockpit.receive({ type: "cockpitState", state: state([]) });
    expect(tiles()).toHaveLength(0);
  });
});

describe("TerminalCockpit — DOM identity (mount once, mutate in place)", () => {
  it("re-uses the same tile element across state updates", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    const first = visibleTiles()[0]!;
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X-renamed")]) });
    expect(visibleTiles()[0]!).toBe(first);
  });

  it("hides the booting overlay once the terminal produces output", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    const booting = visibleTiles()[0]!.querySelector(".tc-tile-booting") as HTMLElement;
    cockpit.receive({ type: "terminalData", sessionId: "a", data: "hello" });
    expect(booting.classList.contains("hidden")).toBe(true);
  });

  it("clicking Resume sends the active session id and immediately shows booting feedback", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X", { alive: false, exitCode: 0 })]) });
    const tile = visibleTiles()[0]!;
    const resume = tile.querySelector<HTMLButtonElement>(".tc-tile-resume .tc-launch-btn")!;
    const booting = tile.querySelector<HTMLElement>(".tc-tile-booting")!;
    resume.click();
    expect(sent).toContainEqual({ type: "cockpitResumeSession", sessionId: "a" });
    expect(booting.classList.contains("hidden")).toBe(false);
    expect(tile.classList.contains("exited")).toBe(false);
  });

  it("pins the active terminal to the bottom as output arrives (so the input is always reachable)", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    const before = terms[0]!.scrolls;
    cockpit.receive({ type: "terminalData", sessionId: "a", data: "line\r\n" });
    expect(terms[0]!.scrolls).toBeGreaterThan(before);
  });

  it("does NOT yank to the bottom while the user has scrolled up to read history", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    terms[0]!.buffer.active.baseY = 500;
    terms[0]!.buffer.active.viewportY = 120;
    const before = terms[0]!.scrolls;
    cockpit.receive({ type: "terminalData", sessionId: "a", data: "line\r\n" });
    expect(terms[0]!.scrolls).toBe(before);
  });

  it("does NOT yank to the bottom during a state refresh while the user is reading scrollback", async () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    terms[0]!.buffer.active.baseY = 500;
    terms[0]!.buffer.active.viewportY = 120;
    const before = terms[0]!.scrolls;
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(terms[0]!.scrolls).toBe(before);
  });
});

describe("TerminalCockpit — keyboard focus follows user gestures only", () => {
  const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r(undefined)));
  const showLive = (): void => {
    for (const host of Array.from(document.querySelectorAll<HTMLElement>(".tc-term"))) {
      Object.defineProperty(host, "isConnected", { value: true, configurable: true });
    }
  };

  it("focuses the active terminal when the user switches tabs", async () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "w", "Main"), term("b", "w", "Second")]) });
    cockpit.receive({ type: "terminalData", sessionId: "a", data: "ready a" });
    cockpit.receive({ type: "terminalData", sessionId: "b", data: "ready b" });
    showLive();
    const focusesB = terms[1]!.focuses;
    (document.querySelector('.tc-tab[data-tab="b"]') as HTMLElement).dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 5, clientY: 5, button: 0, bubbles: true }),
    );
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 5, clientY: 5, bubbles: true }));
    await frame();
    expect(terms[1]!.focuses).toBeGreaterThan(focusesB);
  });

  it("focuses the terminal when the user clicks into a ready tile body", async () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    cockpit.receive({ type: "terminalData", sessionId: "a", data: "ready" });
    showLive();
    const before = terms[0]!.focuses;
    const host = document.querySelector(".tc-term:not(.hidden)") as HTMLElement;
    host.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    await frame();
    expect(terms[0]!.focuses).toBeGreaterThan(before);
  });

  it("does NOT focus any terminal on a background cockpitState broadcast", async () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    showLive();
    await frame();
    const before = terms[0]!.focuses;
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X-renamed"), term("b", "b", "Y")]) });
    await frame();
    expect(terms.reduce((n, t) => n + t.focuses, 0)).toBe(before);
  });

  it("does NOT focus the terminal when streamed terminalData arrives in the background", async () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    showLive();
    await frame();
    const before = terms[0]!.focuses;
    cockpit.receive({ type: "terminalData", sessionId: "a", data: "agent is typing while I work elsewhere" });
    await frame();
    expect(terms[0]!.focuses).toBe(before);
  });

  it("focuses the resumed terminal once it produces output after a Resume click (a user gesture)", async () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X", { alive: false, exitCode: 0 })]) });
    showLive();
    const tile = visibleTiles()[0]!;
    (tile.querySelector(".tc-tile-resume .tc-launch-btn") as HTMLElement).click();
    const before = terms[0]!.focuses;
    cockpit.receive({ type: "terminalData", sessionId: "a", data: "resumed transcript" });
    await frame();
    expect(terms[0]!.focuses).toBeGreaterThan(before);
  });

  it("does NOT focus behind a visible resume overlay (no focus stuck under the overlay)", async () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X", { alive: false, exitCode: 0 })]) });
    showLive();
    const before = terms[0]!.focuses;
    const host = document.querySelector(".tc-term") as HTMLElement;
    host.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    await frame();
    expect(terms[0]!.focuses).toBe(before);
  });
});

describe("TerminalCockpit — native selection and clipboard", () => {
  it("configures xterm so Option-drag can force native text selection through terminal apps", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    expect(terms[0]!.options.macOptionClickForcesSelection).toBe(true);
    expect(terms[0]!.options.altClickMovesCursor).toBe(false);
  });

  it("Cmd+C copies the xterm selection without clearing it", () => {
    const writes = installClipboard();
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    terms[0]!.selection = "selected terminal output";
    const handled = terms[0]!.keyCb!(
      new KeyboardEvent("keydown", { key: "c", metaKey: true }),
    );
    expect(handled).toBe(false);
    expect(writes).toEqual(["selected terminal output"]);
    expect(terms[0]!.selection).toBe("selected terminal output");
  });

  it("does NOT intercept Cmd+V at the keydown level (the paste is handled on the paste event)", () => {
    installClipboard("line one\nline two");
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    const handled = terms[0]!.keyCb!(
      new KeyboardEvent("keydown", { key: "v", metaKey: true }),
    );
    expect(handled).toBe(true);
    expect(terms[0]!.pastes).toEqual([]);
  });

  it("on a paste event pastes via clipboard readText, not xterm's native clipboardData, so multibyte text is not mojibaked", async () => {
    installClipboard("café résumé naïve");
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    const host = document.querySelector(".tc-term") as HTMLElement;
    const evt = new Event("paste", { bubbles: true, cancelable: true });
    host.dispatchEvent(evt);
    await Promise.resolve();
    await Promise.resolve();
    expect(terms[0]!.pastes).toEqual(["café résumé naïve"]);
    expect(evt.defaultPrevented).toBe(true);
  });

  it("does NOT intercept Ctrl+V, leaving the control byte to reach Claude Code so it can paste images from the clipboard", () => {
    installClipboard("ctrl pasted text");
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    const handled = terms[0]!.keyCb!(
      new KeyboardEvent("keydown", { key: "v", ctrlKey: true }),
    );
    expect(handled).toBe(true);
    expect(terms[0]!.pastes).toEqual([]);
  });

  it("does NOT paste on Ctrl+Shift+V or Ctrl+Alt+V, leaving those chords for the shell", () => {
    installClipboard("should not paste");
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    expect(terms[0]!.keyCb!(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(terms[0]!.keyCb!(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, altKey: true }))).toBe(true);
    expect(terms[0]!.pastes).toEqual([]);
  });

  it("maps Cmd+Backspace to Ctrl+U so it deletes to the start of the line, like macOS terminals", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    const handled = terms[0]!.keyCb!(
      new KeyboardEvent("keydown", { key: "Backspace", metaKey: true }),
    );
    expect(handled).toBe(false);
    expect(sent).toContainEqual({ type: "terminalInput", sessionId: "a", data: "\x15" });
  });

  it("leaves a plain Backspace and Ctrl based shortcuts untouched for Windows and Linux users", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    expect(terms[0]!.keyCb!(new KeyboardEvent("keydown", { key: "Backspace" }))).toBe(true);
    expect(terms[0]!.keyCb!(new KeyboardEvent("keydown", { key: "Backspace", ctrlKey: true }))).toBe(true);
    expect(sent.some((m) => m.type === "terminalInput")).toBe(false);
  });

  it("does NOT swallow Ctrl+C, so the shell's interrupt still reaches the process", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    terms[0]!.selection = "some output";
    const handled = terms[0]!.keyCb!(
      new KeyboardEvent("keydown", { key: "c", ctrlKey: true }),
    );
    expect(handled).toBe(true);
  });

  it("lets Cmd+C fall through when there is no selection, so nothing is blocked", () => {
    installClipboard();
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    terms[0]!.selection = "";
    const handled = terms[0]!.keyCb!(
      new KeyboardEvent("keydown", { key: "c", metaKey: true }),
    );
    expect(handled).toBe(true);
  });

  it("registers the OSC 52 clipboard handler exactly once per terminal (no double write on the same sequence)", () => {
    const writes = installClipboard();
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    expect(terms[0]!.oscHandlers).toHaveLength(1);
    terms[0]!.oscHandlers[0]!("0;" + btoa("clip from agent"));
    expect(writes).toEqual(["clip from agent"]);
  });

  it("right-click with no selection pastes the clipboard exactly once through term.paste", async () => {
    installClipboard("right click pasted");
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    terms[0]!.selection = "";
    const host = document.querySelector(".tc-term") as HTMLElement;
    host.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(terms[0]!.pastes).toEqual(["right click pasted"]);
  });

  it("right-click with a selection copies it instead of pasting", () => {
    const writes = installClipboard("ignored clipboard");
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    terms[0]!.selection = "selected text";
    const host = document.querySelector(".tc-term") as HTMLElement;
    host.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(writes).toEqual(["selected text"]);
    expect(terms[0]!.pastes).toEqual([]);
  });
});

describe("TerminalCockpit — tab tear-off (drag a tab into its own window)", () => {
  const down = (el: HTMLElement, x: number, y: number) =>
    el.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, clientY: y, button: 0, bubbles: true }));
  const winMove = (x: number, y: number) =>
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
  const winUp = (x: number, y: number) =>
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: x, clientY: y, bubbles: true }));

  it("detaches a tab dragged out of a multi-tab strip", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "w", "Main"), term("b", "w", "Second")]) });
    down(document.querySelector('.tc-tab[data-tab="b"]') as HTMLElement, 0, 0);
    winMove(60, 200);
    winUp(60, 200);
    expect(sent).toContainEqual({ type: "cockpitDetachTab", sessionId: "b" });
  });

  it("does not detach a lone tab (its window is already its own)", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "Solo")]) });
    down(document.querySelector('.tc-tab[data-tab="a"]') as HTMLElement, 0, 0);
    winMove(60, 200);
    winUp(60, 200);
    expect(sent.some((m) => m.type === "cockpitDetachTab")).toBe(false);
  });

  it("treats a press with no drag as a tab switch, never a detach", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "w", "Main"), term("b", "w", "Second")]) });
    down(document.querySelector('.tc-tab[data-tab="b"]') as HTMLElement, 5, 5);
    winUp(5, 5);
    expect(sent.some((m) => m.type === "cockpitDetachTab")).toBe(false);
    expect((document.querySelector('.tc-tab[data-tab="b"]') as HTMLElement).classList.contains("active")).toBe(true);
  });
});

describe("TerminalCockpit — resume keeps the active folder", () => {
  const folder = (label: string): HTMLElement =>
    Array.from(document.querySelectorAll<HTMLElement>(".tc-folder")).find((b) => b.textContent?.includes(label))!;

  it("adopts a resumed session into the active folder without switching the view to All", () => {
    cockpit.receive({
      type: "cockpitState",
      state: state([term("a", "a", "X", { spaceId: "s1" })], [{ id: "s1" as never, name: "Work" }]),
    });
    folder("Work").click();
    cockpit.adopt("resumed-1", "Resumed", "/repo");
    expect(sent).toContainEqual({
      type: "cockpitAdoptSession",
      sessionId: "resumed-1",
      name: "Resumed",
      cwd: "/repo",
      spaceId: "s1",
    });
    expect(folder("Work").classList.contains("active")).toBe(true);
  });

  it("adopts with no folder when All is the active view", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    cockpit.adopt("resumed-2", "Resumed", null);
    expect(sent.find((m) => m.type === "cockpitAdoptSession")).toMatchObject({ spaceId: null });
  });
});

describe("TerminalCockpit — fit preserves scroll position", () => {
  const stubLiveSize = (): void => {
    for (const host of Array.from(document.querySelectorAll<HTMLElement>(".tc-term"))) {
      Object.defineProperty(host, "clientWidth", { value: 800, configurable: true });
      Object.defineProperty(host, "clientHeight", { value: 600, configurable: true });
      Object.defineProperty(host, "isConnected", { value: true, configurable: true });
    }
  };

  it("does NOT scroll to bottom when fitting a terminal the user has scrolled up in", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    stubLiveSize();
    terms[0]!.buffer.active.baseY = 500;
    terms[0]!.buffer.active.viewportY = 120;
    const before = terms[0]!.scrolls;
    cockpit.fitActive();
    expect(terms[0]!.scrolls).toBe(before);
  });

  it("pins to the bottom on fit when the user is already at the bottom (keeps the prompt visible)", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    stubLiveSize();
    terms[0]!.buffer.active.baseY = 500;
    terms[0]!.buffer.active.viewportY = 500;
    const before = terms[0]!.scrolls;
    cockpit.fitActive();
    expect(terms[0]!.scrolls).toBeGreaterThan(before);
  });

  it("still resizes correctly while a full-screen TUI owns the alternate buffer", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    stubLiveSize();
    terms[0]!.buffer.active.type = "alternate";
    terms[0]!.buffer.active.baseY = 0;
    terms[0]!.buffer.active.viewportY = 0;
    terms[0]!.cols = 132;
    terms[0]!.rows = 40;
    const fitsBefore = totalFitCalls;
    cockpit.fitActive();
    expect(totalFitCalls).toBeGreaterThan(fitsBefore);
    expect(sent).toContainEqual({ type: "terminalResize", sessionId: "a", cols: 132, rows: 40 });
  });

  it("re-sends the size to the pty after Resume so the resumed session fills the tile, not a stale-dedup quarter width", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    stubLiveSize();
    cockpit.fitActive();
    const afterFirstFit = sent.filter((m) => m.type === "terminalResize").length;
    cockpit.fitActive();
    expect(sent.filter((m) => m.type === "terminalResize").length).toBe(afterFirstFit);
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X", { alive: false, exitCode: 0 })]) });
    const resume = visibleTiles()[0]!.querySelector<HTMLButtonElement>(".tc-tile-resume .tc-launch-btn")!;
    resume.click();
    stubLiveSize();
    cockpit.fitActive();
    expect(sent.filter((m) => m.type === "terminalResize").length).toBeGreaterThan(afterFirstFit);
  });
});

describe("TerminalCockpit — folder switch fits the terminal in one frame, not after a 200ms debounce", () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const stubLiveSize = (): void => {
    for (const host of Array.from(document.querySelectorAll<HTMLElement>(".tc-term"))) {
      Object.defineProperty(host, "clientWidth", { value: 800, configurable: true });
      Object.defineProperty(host, "clientHeight", { value: 600, configurable: true });
      Object.defineProperty(host, "isConnected", { value: true, configurable: true });
    }
  };

  it("a folder switch triggers a terminal fit on the next animation frame (no 200ms squish flash)", async () => {
    cockpit.receive({
      type: "cockpitState",
      state: state(
        [term("a", "a", "Solo A", { spaceId: "s1" }), term("b", "b", "Solo B", { spaceId: "s2" })],
        [
          { id: "s1" as never, name: "Folder A" },
          { id: "s2" as never, name: "Folder B" },
        ],
      ),
    });
    stubLiveSize();
    const folder = (name: string): HTMLElement =>
      Array.from(document.querySelectorAll(".tc-folder")).find((b) => b.textContent?.includes(name)) as HTMLElement;
    folder("Folder A").click();
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    stubLiveSize();
    const baseline = totalFitCalls;
    folder("Folder B").click();
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(totalFitCalls).toBeGreaterThan(baseline);
  });

  it("does NOT defer the folder-switch fit by 200ms (the squish-flash regression)", async () => {
    cockpit.receive({
      type: "cockpitState",
      state: state(
        [term("a", "a", "A", { spaceId: "s1" }), term("b", "b", "B", { spaceId: "s2" })],
        [
          { id: "s1" as never, name: "FA" },
          { id: "s2" as never, name: "FB" },
        ],
      ),
    });
    stubLiveSize();
    const folder = (name: string): HTMLElement =>
      Array.from(document.querySelectorAll(".tc-folder")).find((b) => b.textContent?.includes(name)) as HTMLElement;
    folder("FA").click();
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    stubLiveSize();
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    folder("FB").click();
    await tick();
    const scheduled200ms = setTimeoutSpy.mock.calls.find((c) => c[1] === 200);
    expect(scheduled200ms).toBeUndefined();
    setTimeoutSpy.mockRestore();
  });
});

describe("TerminalCockpit — overlay stacking + hit-test contract (regression: dead Resume button under xterm layers)", () => {
  it("the resume overlay claims a high z-index and accepts pointer events so its button is the top hit target", () => {
    const block = cssBlock(".tc-tile-resume");
    expect(block).toMatch(/z-index:\s*20/);
    expect(block).toMatch(/pointer-events:\s*auto/);
    expect(block).toMatch(/inset:\s*0/);
  });

  it("the booting overlay also claims the high z-index and accepts pointer events (blocks clicks while starting)", () => {
    const block = cssBlock(".tc-tile-booting");
    expect(block).toMatch(/z-index:\s*20/);
    expect(block).toMatch(/pointer-events:\s*auto/);
    expect(block).toMatch(/inset:\s*0/);
  });

  it("isolates the tile body so the overlays always outrank the terminal regardless of outside z-index", () => {
    expect(cssBlock(".tc-tile-body")).toMatch(/isolation:\s*isolate/);
  });

  it("isolates the terminal mount so xterm's internal z-index 5/10 layers cannot rise above the overlays", () => {
    const block = cssBlock(".tc-tile-termmount");
    expect(block).toMatch(/isolation:\s*isolate/);
    expect(block).toMatch(/z-index:\s*0/);
  });

  it("drops pointer events on the terminal mount once a tile is exited (defence behind the resume overlay)", () => {
    expect(cssBlock(".tc-tile.exited .tc-tile-termmount")).toMatch(/pointer-events:\s*none/);
  });

  it("keeps the head (tabs, pause, add) outside the overlay region: head precedes the body, overlays live inside the body", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X", { alive: false, exitCode: 0 })]) });
    const tile = visibleTiles()[0]!;
    const head = tile.querySelector(".tc-tile-head") as HTMLElement;
    const body = tile.querySelector(".tc-tile-body") as HTMLElement;
    const resume = tile.querySelector(".tc-tile-resume") as HTMLElement;
    const booting = tile.querySelector(".tc-tile-booting") as HTMLElement;
    expect(head.parentElement).toBe(tile);
    expect(body.parentElement).toBe(tile);
    expect(head.contains(resume)).toBe(false);
    expect(head.contains(booting)).toBe(false);
    expect(body.contains(resume)).toBe(true);
    expect(body.contains(booting)).toBe(true);
    expect(head.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the pause and add buttons in the head where the body overlays can never cover them", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    const head = visibleTiles()[0]!.querySelector(".tc-tile-head") as HTMLElement;
    expect(head.querySelector(".tc-tab-pause")).not.toBeNull();
    expect(head.querySelector(".tc-tab-add")).not.toBeNull();
  });

  it("the head sits above the terminal mount (head z-index outranks the mount) without entering the body context", () => {
    expect(cssBlock(".tc-tile-head")).toMatch(/z-index:\s*2/);
  });
});

describe("TerminalCockpit — paused/exited/starting state copy is clear and dash-free", () => {
  const metaText = (): string => (visibleTiles()[0]!.querySelector(".tc-tile-meta") as HTMLElement).textContent ?? "";

  it("labels a clean stop as Paused and a non-zero exit with its code", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X", { alive: false, exitCode: 0 })]) });
    expect(metaText()).toContain("Paused");
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X", { alive: false, exitCode: 137 })]) });
    expect(metaText()).toContain("Exited 137");
  });

  it("labels a stop-hook wait as Needs input and a notify-hook wait as Needs you", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    cockpit.receive({ type: "terminalAttention", sessionId: "a", reason: "stop" });
    expect(metaText()).toContain("Needs input");
    cockpit.receive({ type: "terminalActive", sessionId: "a" });
    cockpit.receive({ type: "terminalAttention", sessionId: "a", reason: "notify" });
    expect(metaText()).toContain("Needs you");
  });

  it("shows neutral Starting copy on the booting overlay (true for a first launch and a resume alike)", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    const booting = visibleTiles()[0]!.querySelector(".tc-tile-booting-text") as HTMLElement;
    expect(booting.textContent).toBe("Starting session…");
  });

  it("the resume hint and all state copy carry no em or en dash", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X", { alive: false, exitCode: 0 })]) });
    const tile = visibleTiles()[0]!;
    const hint = (tile.querySelector(".tc-tile-resume-hint") as HTMLElement).textContent ?? "";
    expect(hint.length).toBeGreaterThan(0);
    for (const txt of [hint, metaText()]) {
      expect(txt).not.toMatch(/[–—]/);
    }
  });
});

const srgbChannel = (c: number): number => {
  const n = c / 255;
  return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
};
const rgbOf = (hex: string): [number, number, number] => {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const luminance = (rgb: [number, number, number]): number =>
  0.2126 * srgbChannel(rgb[0]) + 0.7152 * srgbChannel(rgb[1]) + 0.0722 * srgbChannel(rgb[2]);
const contrastRatio = (a: string, b: string): number => {
  const [l1, l2] = [luminance(rgbOf(a)), luminance(rgbOf(b))].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};
const declared = (selector: string, prop: string): string => {
  const body = cssBlock(selector);
  const m = body.match(new RegExp(`${prop}\\s*:\\s*([^;]+);`));
  return m ? m[1]!.trim() : "";
};

describe("TerminalCockpit — terminal renderer + selection options", () => {
  it("leaves minimumContrastRatio at the default so the GPU renderer does not churn the glyph atlas with per-glyph contrast math while scrolling (the dark theme is already high contrast)", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    expect(terms[0]!.options.minimumContrastRatio ?? 1).toBe(1);
  });

  it("keeps a visible selection when the terminal loses focus via selectionInactiveBackground", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    const theme = terms[0]!.options.theme;
    expect(theme?.selectionInactiveBackground).toBeTruthy();
    expect(theme?.selectionBackground).toBeTruthy();
  });
});

describe("TerminalCockpit — WCAG AA contrast (terminal-scoped overrides)", () => {
  it("the session start time meets AA body contrast against both ends of the meta-bar background (regression: text-dim was 2.7:1)", () => {
    const color = declared(".tc-meta-time", "color");
    expect(color.startsWith("#")).toBe(true);
    expect(contrastRatio(color, "#100f14")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(color, "#1f1f27")).toBeGreaterThanOrEqual(4.5);
  });

  it("terminal foreground reads well above AA against the terminal background", () => {
    expect(contrastRatio("#d6d6e0", "#100f14")).toBeGreaterThanOrEqual(4.5);
  });

  it("the selection foreground stays readable over the composited selection background", () => {
    const over = ([r, g, b]: [number, number, number], a: number, bg: [number, number, number]): string => {
      const mix = [r, g, b].map((c, i) => Math.round(c * a + bg[i]! * (1 - a)));
      return "#" + mix.map((c) => c.toString(16).padStart(2, "0")).join("");
    };
    const selBg = over(rgbOf("#d97757"), 0.32, rgbOf("#100f14"));
    expect(contrastRatio("#ffffff", selBg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("TerminalCockpit — accessibility roles and labels", () => {
  it("labels the terminal host as a group named after the session so it is reachable and identified", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "Reviewer")]) });
    const host = document.querySelector(".tc-term") as HTMLElement;
    expect(host.getAttribute("role")).toBe("group");
    expect(host.getAttribute("aria-label")).toContain("Reviewer");
  });

  it("labels the tile as a group reflecting the active session and its status", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "Builder")]) });
    const tile = visibleTiles()[0]!;
    expect(tile.getAttribute("role")).toBe("group");
    expect(tile.getAttribute("aria-label")).toContain("Builder");
    expect(tile.getAttribute("aria-label")).toContain("Running");
  });

  it("retitles the tile when the session status changes (Running to Needs input)", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    cockpit.receive({ type: "terminalAttention", sessionId: "a", reason: "stop" });
    expect(visibleTiles()[0]!.getAttribute("aria-label")).toContain("Needs input");
  });

  it("provides a polite per-tile status live region that does NOT announce on first render (no spam on load)", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    const region = visibleTiles()[0]!.querySelector('.visually-hidden[role="status"][aria-live="polite"]') as HTMLElement;
    expect(region).not.toBeNull();
    expect(region.textContent).toBe("");
  });

  it("announces a status transition exactly once into the live region", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    cockpit.receive({ type: "terminalAttention", sessionId: "a", reason: "stop" });
    const region = visibleTiles()[0]!.querySelector('.visually-hidden[role="status"][aria-live="polite"]') as HTMLElement;
    expect(region.textContent).toContain("Needs input");
  });
});

describe("TerminalCockpit — keyboard focus is visible on the terminal tile", () => {
  it("draws a focus ring on the tile when the terminal inside takes focus (xterm clears its own outline)", () => {
    expect(COCKPIT_CSS).toMatch(/\.tc-tile:focus-within:not\(\.attention\)\s*\{/);
  });
});
