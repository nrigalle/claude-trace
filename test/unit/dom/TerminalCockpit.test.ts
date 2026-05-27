import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CockpitState, CockpitWebviewToHost, TerminalSession } from "../../../src/features/cockpit/protocol";

interface FakeBuffer {
  active: { type: "normal" | "alternate"; viewportY: number; baseY: number };
}
interface FakeTerm {
  dataCb: ((d: string) => void) | null;
  bellCb: (() => void) | null;
  wheelCb: ((e: WheelEvent) => boolean) | null;
  cols: number;
  rows: number;
  scrolls: number;
  buffer: FakeBuffer;
  options: { scrollSensitivity: number };
}
const terms: FakeTerm[] = [];

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    dataCb: ((d: string) => void) | null = null;
    bellCb: (() => void) | null = null;
    wheelCb: ((e: WheelEvent) => boolean) | null = null;
    cols = 80;
    rows = 24;
    scrolls = 0;
    buffer: FakeBuffer = { active: { type: "normal", viewportY: 0, baseY: 0 } };
    options: { scrollSensitivity: number } = { scrollSensitivity: 1 };
    constructor() {
      terms.push(this as unknown as FakeTerm);
    }
    loadAddon(): void {}
    onData(cb: (d: string) => void): void {
      this.dataCb = cb;
    }
    onBell(cb: () => void): void {
      this.bellCb = cb;
    }
    attachCustomWheelEventHandler(cb: (e: WheelEvent) => boolean): void {
      this.wheelCb = cb;
    }
    open(): void {}
    write(): void {}
    dispose(): void {}
    scrollToBottom(): void {
      this.scrolls += 1;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    dispose(): void {}
  },
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
  document.body.innerHTML = "";
  const TerminalCockpit = await loadCockpit();
  cockpit = new TerminalCockpit({ send: (m: CockpitWebviewToHost) => sent.push(m) });
  document.body.appendChild(cockpit.element());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const tiles = (): HTMLElement[] => Array.from(document.querySelectorAll(".tc-tile"));
const visibleTiles = (): HTMLElement[] => tiles().filter((t) => !t.classList.contains("hidden"));
const tabsIn = (tile: HTMLElement): HTMLElement[] => Array.from(tile.querySelectorAll(".tc-tab"));

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
});

describe("TerminalCockpit — device-aware scroll sensitivity (trackpad vs mouse)", () => {
  const PIXEL = 0;
  const LINE = 1;
  const wheel = (deltaY: number, deltaMode: number) => new WheelEvent("wheel", { deltaY, deltaMode });

  it("boosts sensitivity for small precision (trackpad) pixel deltas so they don't crawl", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    const t = terms[0]!;
    expect(t.wheelCb!(wheel(8, PIXEL))).toBe(true);
    expect(t.options.scrollSensitivity).toBeGreaterThan(1);
  });

  it("keeps sensitivity at 1 for chunky mouse-wheel pixel notches so they don't rocket", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    const t = terms[0]!;
    expect(t.wheelCb!(wheel(120, PIXEL))).toBe(true);
    expect(t.options.scrollSensitivity).toBe(1);
  });

  it("keeps sensitivity at 1 for line-mode mouse wheels", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    const t = terms[0]!;
    expect(t.wheelCb!(wheel(1, LINE))).toBe(true);
    expect(t.options.scrollSensitivity).toBe(1);
  });

  it("adapts as the user switches devices mid-session, and never drops an event", () => {
    cockpit.receive({ type: "cockpitState", state: state([term("a", "a", "X")]) });
    const t = terms[0]!;
    expect(t.wheelCb!(wheel(6, PIXEL))).toBe(true);
    const boosted = t.options.scrollSensitivity;
    expect(boosted).toBeGreaterThan(1);
    expect(t.wheelCb!(wheel(120, PIXEL))).toBe(true);
    expect(t.options.scrollSensitivity).toBe(1);
    expect(t.wheelCb!(wheel(5, PIXEL))).toBe(true);
    expect(t.options.scrollSensitivity).toBe(boosted);
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
