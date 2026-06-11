import type {
  GlobalStats,
  SessionDetail,
  SessionId,
  SessionSummary,
} from "./domain/types";

export interface DetailLayoutEntry {
  readonly id: string;
  readonly visible: boolean;
  readonly span?: 1 | 2;
}

export type HostToWebview =
  | {
      readonly type: "update";
      readonly sessions: readonly SessionSummary[];
      readonly stats: GlobalStats;
      readonly changedIds: readonly SessionId[];
      readonly removedIds: readonly SessionId[];
    }
  | {
      readonly type: "updateDelta";
      readonly changed: readonly SessionSummary[];
      readonly stats: GlobalStats;
      readonly removedIds: readonly SessionId[];
    }
  | {
      readonly type: "sessionDetail";
      readonly sessionId: SessionId;
      readonly detail: SessionDetail;
    }
  | {
      readonly type: "detailLayout";
      readonly layout: readonly DetailLayoutEntry[];
    };

export type WebviewToHost =
  | { readonly type: "ready" }
  | { readonly type: "sessionsViewVisible"; readonly visible: boolean }
  | { readonly type: "selectSession"; readonly sessionId: SessionId | null }
  | { readonly type: "renameSession"; readonly sessionId: SessionId }
  | { readonly type: "resumeSession"; readonly sessionId: SessionId }
  | { readonly type: "openMemoryFile"; readonly filePath: string }
  | { readonly type: "openMemoryFolder"; readonly sessionId: SessionId }
  | { readonly type: "openFile"; readonly filePath: string }
  | { readonly type: "viewFileDiff"; readonly sessionId: SessionId; readonly filePath: string }
  | { readonly type: "exportChatMarkdown"; readonly sessionId: SessionId }
  | { readonly type: "copyConversation"; readonly sessionId: SessionId }
  | { readonly type: "togglePin"; readonly sessionId: SessionId }
  | { readonly type: "deleteSessions"; readonly sessionIds: readonly SessionId[] }
  | { readonly type: "saveDetailLayout"; readonly layout: readonly DetailLayoutEntry[] };

export { assertNever } from "../../shared/assertNever";
