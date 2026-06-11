import { clear, h } from "../ui/h.js";
import type { TerminalSession } from "../../../src/features/cockpit/protocol";
import { compactPath, formatStartTime } from "./cockpitUtils.js";
import type { AttentionReason, WindowTile } from "./cockpitTileTypes.js";

export interface SessionStatus {
  readonly className: string;
  readonly label: string;
}

export const renderTileMeta = (tile: WindowTile, active: TerminalSession, status: SessionStatus): void => {
  clear(tile.metaBar);
  tile.tile.setAttribute("aria-label", `${active.name} session, ${status.label}`);
  announceStatus(tile, active.name, status.label);
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
};

const announceStatus = (tile: WindowTile, name: string, label: string): void => {
  const key = `${tile.activeId}:${label}`;
  if (tile.announced === key) return;
  const first = tile.announced === "";
  tile.announced = key;
  if (first) return;
  tile.status.textContent = `${name}: ${label}`;
};

export const sessionStatus = (active: TerminalSession, attention: ReadonlySet<string>, attentionReasons: ReadonlyMap<string, AttentionReason>): SessionStatus => {
  if (attention.has(active.sessionId)) {
    const reason = attentionReasons.get(active.sessionId);
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
};
