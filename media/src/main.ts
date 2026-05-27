import type { GlobalStats, SessionId, SessionSummary } from "../../src/features/dashboard/domain/types";
import type { HostToWebview } from "../../src/features/dashboard/protocol";
import type { PipelinesWebviewToHost } from "../../src/features/pipelines/protocol";
import type { CockpitWebviewToHost } from "../../src/features/cockpit/protocol";
import { MessageClient } from "./messaging/client.js";
import { TerminalCockpit } from "./cockpit/TerminalCockpit.js";
import { PipelinesApp } from "./pipelines/PipelinesApp.js";
import { Store } from "./state/Store.js";
import { App } from "./ui/layout/App.js";
import { h } from "./ui/h.js";

type Mode = "sessions" | "pipelines";

const boot = () => {
  const store = new Store();
  let sessionsCache: readonly SessionSummary[] = [];
  let statsCache: GlobalStats | null = null;

  const client = new MessageClient(store);
  const terminalCockpit = new TerminalCockpit({
    send: (msg: CockpitWebviewToHost) => client.send(msg),
  });

  const app = new App(store, {
    onSelect: (id: SessionId) => {
      if (store.state.selectedId === id) return;
      store.update({
        selectedId: id,
        expandedEvent: null,
        timelineFilter: "all",
        timelineScroll: 0,
      });
      app.updateDetail(null);
      app.updateSessions(sessionsCache, null, new Set([id]));
      client.send({ type: "selectSession", sessionId: id });
    },
    onRename: (id: SessionId) => client.send({ type: "renameSession", sessionId: id }),
    onResume: (id: SessionId) => resumeInCockpit(id),
    onOpenMemoryFile: (filePath: string) => client.send({ type: "openMemoryFile", filePath }),
    onOpenMemoryFolder: (id: SessionId) => client.send({ type: "openMemoryFolder", sessionId: id }),
    onOpenFile: (filePath: string) => client.send({ type: "openFile", filePath }),
    onViewFileDiff: (id: SessionId, filePath: string) =>
      client.send({ type: "viewFileDiff", sessionId: id, filePath }),
    onExportChat: (id: SessionId) => client.send({ type: "exportChatMarkdown", sessionId: id }),
    onCopyConversation: (id: SessionId) => client.send({ type: "copyConversation", sessionId: id }),
    onResumeInCockpit: (id: SessionId) => resumeInCockpit(id),
    onTogglePin: (id: SessionId) => {
      let target: SessionSummary | undefined;
      sessionsCache = sessionsCache.map((s) => {
        if (s.session_id !== id) return s;
        const flipped = { ...s, pinned: !s.pinned };
        target = flipped;
        return flipped;
      });
      if (target) app.updateSessions(sessionsCache, statsCache, new Set([id]));
      client.send({ type: "togglePin", sessionId: id });
    },
    onBackToHome: () => {
      store.update({ selectedId: null });
      app.noSelection();
      client.send({ type: "selectSession", sessionId: null });
    },
    onSaveDetailLayout: (layout) => client.send({ type: "saveDetailLayout", layout }),
  }, terminalCockpit);

  const pipelinesApp = new PipelinesApp({
    send: (msg: PipelinesWebviewToHost) => client.send(msg),
  });

  const sessionsModeEl = h("div", { className: "ct-mode" });
  sessionsModeEl.appendChild(app.root);
  const pipelinesModeEl = h("div", { className: "ct-mode hidden" });
  pipelinesModeEl.appendChild(pipelinesApp.element());

  const tab = (label: string, target: Mode, active: boolean) =>
    h("button", {
      className: `ct-tab${active ? " active" : ""}`,
      attrs: { type: "button", "aria-label": label },
      textContent: label,
      on: { click: () => setMode(target) },
    });
  const sessionsTab = tab("Sessions", "sessions", true);
  const pipelinesTab = tab("Workflows", "pipelines", false);

  let mode: Mode = "sessions";
  const setMode = (next: Mode) => {
    if (next === mode) return;
    mode = next;
    sessionsTab.classList.toggle("active", next === "sessions");
    pipelinesTab.classList.toggle("active", next === "pipelines");
    sessionsModeEl.classList.toggle("hidden", next !== "sessions");
    pipelinesModeEl.classList.toggle("hidden", next !== "pipelines");
  };

  const resumeInCockpit = (id: SessionId) => {
    const summary = sessionsCache.find((s) => s.session_id === id);
    const name = summary?.title && summary.title.length > 0 ? summary.title : `Session ${id.slice(0, 8)}`;
    terminalCockpit.adopt(id, name, summary?.cwd ?? null);
    setMode("sessions");
    if (store.state.selectedId !== null) {
      store.update({ selectedId: null });
      app.noSelection();
    }
  };

  const tabsEl = h("div", { className: "ct-tabs" }, sessionsTab, pipelinesTab);

  const appHost = document.getElementById("app");
  if (!appHost) throw new Error("no #app host");
  const modeStack = h("div", { className: "ct-mode-stack" }, sessionsModeEl, pipelinesModeEl);
  appHost.appendChild(tabsEl);
  appHost.appendChild(modeStack);

  client.onUpdate((msg: HostToWebview) => {
    if (msg.type === "update") {
      sessionsCache = msg.sessions;
      statsCache = msg.stats;
      app.updateSessions(msg.sessions, msg.stats, new Set(msg.changedIds));

      const selected = store.state.selectedId;
      if (selected) {
        const exists = msg.sessions.some((s) => s.session_id === selected);
        if (!exists) {
          store.update({ selectedId: null });
          app.noSelection();
        }
      }
    } else if (msg.type === "sessionDetail") {
      if (msg.sessionId !== store.state.selectedId) return;
      app.updateDetail(msg.detail);
    } else if (msg.type === "detailLayout") {
      app.applyHostDetailLayout(msg.layout);
    }
  });
  client.onPipelinesUpdate((msg) => pipelinesApp.receive(msg));
  client.onCockpitUpdate((msg) => terminalCockpit.receive(msg));
  client.send({ type: "ready" });
  client.send({ type: "cockpitReady" });
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
