import type { GlobalStats, SessionId, SessionSummary } from "../../src/domain/types";
import type { HostToWebview } from "../../src/protocol";
import { MessageClient } from "./messaging/client.js";
import { Store } from "./state/Store.js";
import { App } from "./ui/layout/App.js";

const boot = () => {
  const store = new Store();
  let sessionsCache: readonly SessionSummary[] = [];
  let statsCache: GlobalStats | null = null;

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
    onResume: (id: SessionId) => client.send({ type: "resumeSession", sessionId: id }),
    onOpenMemoryFile: (filePath: string) => client.send({ type: "openMemoryFile", filePath }),
    onOpenMemoryFolder: (id: SessionId) => client.send({ type: "openMemoryFolder", sessionId: id }),
    onOpenFile: (filePath: string) => client.send({ type: "openFile", filePath }),
    onViewFileDiff: (id: SessionId, filePath: string) =>
      client.send({ type: "viewFileDiff", sessionId: id, filePath }),
    onExportChat: (id: SessionId) => client.send({ type: "exportChatMarkdown", sessionId: id }),
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
    onStartNewSession: () => client.send({ type: "startNewSession" }),
  });

  const appHost = document.getElementById("app");
  if (!appHost) throw new Error("no #app host");
  appHost.appendChild(app.root);

  const client = new MessageClient(store);
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
    }
  });

  client.send({ type: "ready" });
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
