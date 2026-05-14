import type { SessionId } from "../../../src/domain/types";
import type { HostToWebview, WebviewToHost } from "../../../src/protocol";
import type { Store } from "../state/Store";

type Handler = (msg: HostToWebview) => void;

export class MessageClient {
  private buffer: HostToWebview[] = [];
  private rafScheduled = false;
  private handler: Handler | null = null;

  constructor(private readonly store: Store) {
    window.addEventListener("message", (e: MessageEvent<unknown>) => {
      const data = e.data;
      if (!data || typeof data !== "object" || !("type" in data)) return;
      this.enqueue(data as HostToWebview);
    });
  }

  onUpdate(handler: Handler): void {
    this.handler = handler;
  }

  send(msg: WebviewToHost): void {
    this.store.vscode.postMessage(msg);
  }

  private enqueue(msg: HostToWebview): void {
    this.buffer.push(msg);
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => {
      this.rafScheduled = false;
      this.flush();
    });
  }

  private flush(): void {
    const coalesced = this.coalesce(this.buffer);
    this.buffer = [];
    if (!this.handler) return;
    for (const msg of coalesced) {
      try { this.handler(msg); } catch (err) { console.error("handler error", err); }
    }
  }

  private coalesce(msgs: HostToWebview[]): HostToWebview[] {
    if (msgs.length <= 1) return msgs;

    const updates: Extract<HostToWebview, { type: "update" }>[] = [];
    const detailLatest = new Map<SessionId, Extract<HostToWebview, { type: "sessionDetail" }>>();
    for (const m of msgs) {
      if (m.type === "update") updates.push(m);
      else if (m.type === "sessionDetail") detailLatest.set(m.sessionId, m);
    }

    const out: HostToWebview[] = [];

    if (updates.length === 0) {
      for (const d of detailLatest.values()) out.push(d);
      return out;
    }

    const last = updates[updates.length - 1]!;
    const changedSet = new Set<SessionId>();
    const removedSet = new Set<SessionId>();
    for (const u of updates) {
      for (const id of u.changedIds) changedSet.add(id);
      for (const id of u.removedIds) removedSet.add(id);
    }
    out.push({
      type: "update",
      sessions: last.sessions,
      stats: last.stats,
      changedIds: [...changedSet],
      removedIds: [...removedSet],
    });

    const alive = new Set<SessionId>(last.sessions.map((s) => s.session_id));
    for (const d of detailLatest.values()) {
      if (alive.has(d.sessionId)) out.push(d);
    }
    return out;
  }
}
