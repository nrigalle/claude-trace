import { clear, h } from "../ui/h.js";
import { ICONS } from "../ui/icons.js";
import type { CockpitWebviewToHost, TerminalSession } from "../../../src/features/cockpit/protocol";
import type { WindowTile } from "./cockpitTileTypes.js";

export interface TabStripHost {
  send(msg: CockpitWebviewToHost): void;
  switchTab(windowId: string, sessionId: string): void;
  flushBlockedUi(): void;
}

export const renderTabStrip = (host: TabStripHost, tile: WindowTile, windowId: string, terminals: readonly TerminalSession[]): void => {
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
            host.send({ type: "terminalClose", sessionId: t.sessionId });
          },
        },
      }),
    );
    wireTabDrag(host, chip, tile, windowId, t.sessionId, terminals.length > 1);
    tile.tabStrip.appendChild(chip);
  }
};

const wireTabDrag = (host: TabStripHost, chip: HTMLElement, tile: WindowTile, windowId: string, sessionId: string, canDetach: boolean): void => {
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
        host.switchTab(windowId, sessionId);
      } else if (outside(ev)) {
        host.send({ type: "cockpitDetachTab", sessionId });
      }
      host.flushBlockedUi();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
};
