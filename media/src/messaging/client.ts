import type { SessionId } from "../../../src/features/dashboard/domain/types";
import type {
  PipelinesHostToWebview,
  PipelinesWebviewToHost,
} from "../../../src/features/pipelines/protocol";
import type {
  CockpitHostToWebview,
  CockpitWebviewToHost,
} from "../../../src/features/cockpit/protocol";
import type {
  LibraryHostToWebview,
  LibraryWebviewToHost,
} from "../../../src/features/library/protocol";
import type { HostToWebview, WebviewToHost } from "../../../src/features/dashboard/protocol";
import type { Store } from "../state/Store";

type SessionHandler = (msg: HostToWebview) => void;
type PipelinesHandler = (msg: PipelinesHostToWebview) => void;
type CockpitHandler = (msg: CockpitHostToWebview) => void;
type LibraryHandler = (msg: LibraryHostToWebview) => void;

const SESSION_MESSAGE_TYPE_TABLE: Record<HostToWebview["type"], true> = {
  update: true,
  updateDelta: true,
  sessionDetail: true,
  detailLayout: true,
};
const SESSION_MESSAGE_TYPES: ReadonlySet<HostToWebview["type"]> = new Set(
  Object.keys(SESSION_MESSAGE_TYPE_TABLE) as HostToWebview["type"][],
);

const PIPELINES_MESSAGE_TYPE_TABLE: Record<PipelinesHostToWebview["type"], true> = {
  pipelinesList: true,
  pipelineDetail: true,
  runUpdate: true,
  sessionTranscript: true,
  validationFailed: true,
  notice: true,
  pipelineAssistantReply: true,
  pipelineAssistantProgress: true,
  pipelineAssistantHistory: true,
  pipelineAssistantError: true,
  pipelineAssistantBusy: true,
  pipelineAssistantConversations: true,
};
const PIPELINES_MESSAGE_TYPES: ReadonlySet<PipelinesHostToWebview["type"]> = new Set(
  Object.keys(PIPELINES_MESSAGE_TYPE_TABLE) as PipelinesHostToWebview["type"][],
);

const COCKPIT_MESSAGE_TYPE_TABLE: Record<CockpitHostToWebview["type"], true> = {
  cockpitState: true,
  terminalData: true,
  terminalExit: true,
  terminalAttention: true,
  terminalActive: true,
  cockpitLayout: true,
  cockpitProfileInvalid: true,
  cockpitNotice: true,
  cockpitFolderPicked: true,
};
const COCKPIT_MESSAGE_TYPES: ReadonlySet<CockpitHostToWebview["type"]> = new Set(
  Object.keys(COCKPIT_MESSAGE_TYPE_TABLE) as CockpitHostToWebview["type"][],
);

const LIBRARY_MESSAGE_TYPE_TABLE: Record<LibraryHostToWebview["type"], true> = {
  librarySnapshot: true,
  libraryNotice: true,
  libraryImportCandidates: true,
  librarySyncProgress: true,
  assistantReply: true,
  assistantProgress: true,
  assistantHistory: true,
  assistantError: true,
  assistantBusy: true,
  assistantConversations: true,
};
const LIBRARY_MESSAGE_TYPES: ReadonlySet<LibraryHostToWebview["type"]> = new Set(
  Object.keys(LIBRARY_MESSAGE_TYPE_TABLE) as LibraryHostToWebview["type"][],
);

export class MessageClient {
  private buffer: HostToWebview[] = [];
  private rafScheduled = false;
  private sessionHandler: SessionHandler | null = null;
  private pipelinesHandler: PipelinesHandler | null = null;
  private cockpitHandler: CockpitHandler | null = null;
  private libraryHandler: LibraryHandler | null = null;

  constructor(private readonly store: Store) {
    window.addEventListener("message", (e: MessageEvent<unknown>) => {
      const data = e.data;
      if (!data || typeof data !== "object" || !("type" in data)) return;
      const type = (data as { type: string }).type;
      if (SESSION_MESSAGE_TYPES.has(type as HostToWebview["type"])) {
        this.enqueue(data as HostToWebview);
      } else if (PIPELINES_MESSAGE_TYPES.has(type as PipelinesHostToWebview["type"])) {
        this.pipelinesHandler?.(data as PipelinesHostToWebview);
      } else if (COCKPIT_MESSAGE_TYPES.has(type as CockpitHostToWebview["type"])) {
        this.cockpitHandler?.(data as CockpitHostToWebview);
      } else if (LIBRARY_MESSAGE_TYPES.has(type as LibraryHostToWebview["type"])) {
        this.libraryHandler?.(data as LibraryHostToWebview);
      }
    });
  }

  onUpdate(handler: SessionHandler): void {
    this.sessionHandler = handler;
  }

  onPipelinesUpdate(handler: PipelinesHandler): void {
    this.pipelinesHandler = handler;
  }

  onCockpitUpdate(handler: CockpitHandler): void {
    this.cockpitHandler = handler;
  }

  onLibraryUpdate(handler: LibraryHandler): void {
    this.libraryHandler = handler;
  }

  send(
    msg:
      | WebviewToHost
      | PipelinesWebviewToHost
      | CockpitWebviewToHost
      | LibraryWebviewToHost,
  ): void {
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
    if (!this.sessionHandler) return;
    for (const msg of coalesced) {
      try { this.sessionHandler(msg); } catch (err) { console.error("handler error", err); }
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
