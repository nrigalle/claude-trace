import type {
  GlobalStats,
  SessionDetail,
  SessionId,
  SessionSummary,
} from "./domain/types";

export type HostToWebview =
  | {
      readonly type: "update";
      readonly sessions: readonly SessionSummary[];
      readonly stats: GlobalStats;
      readonly changedIds: readonly SessionId[];
      readonly removedIds: readonly SessionId[];
    }
  | {
      readonly type: "sessionDetail";
      readonly sessionId: SessionId;
      readonly detail: SessionDetail;
    };

export type WebviewToHost =
  | { readonly type: "ready" }
  | { readonly type: "selectSession"; readonly sessionId: SessionId | null }
  | { readonly type: "renameSession"; readonly sessionId: SessionId }
  | { readonly type: "resumeSession"; readonly sessionId: SessionId };

export const assertNever = (x: never): never => {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
};
