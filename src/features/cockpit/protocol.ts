import type {
  ProfileId,
  ProfileValidationError,
  SessionProfile,
  Space,
  SpaceId,
} from "./domain/profiles";
import type { EffortChoice, ModelChoice } from "../../shared/models";
import type { PermissionMode } from "../../shared/permissionModes";
import type { LayoutNode } from "./domain/splitTree";

export type TerminalKind = "claude" | "shell";

export interface TerminalSession {
  readonly sessionId: string;
  readonly windowId: string;
  readonly name: string;
  readonly spaceId: string | null;
  readonly cwd: string | null;
  readonly alive: boolean;
  readonly exitCode: number | null;
  readonly startedAtMs: number;
  readonly kind: TerminalKind;
}

export interface CockpitState {
  readonly profiles: readonly SessionProfile[];
  readonly spaces: readonly Space[];
  readonly terminals: readonly TerminalSession[];
}

export interface CockpitLayout {
  readonly trees: Record<string, LayoutNode>;
}

export type CockpitHostToWebview =
  | { readonly type: "cockpitState"; readonly state: CockpitState }
  | { readonly type: "terminalData"; readonly sessionId: string; readonly data: string; readonly replay?: boolean }
  | { readonly type: "terminalExit"; readonly sessionId: string; readonly exitCode: number }
  | { readonly type: "terminalAttention"; readonly sessionId: string; readonly reason: "stop" | "notify" }
  | { readonly type: "terminalActive"; readonly sessionId: string }
  | { readonly type: "cockpitLayout"; readonly layout: CockpitLayout }
  | { readonly type: "cockpitProfileInvalid"; readonly errors: readonly ProfileValidationError[] }
  | { readonly type: "cockpitNotice"; readonly level: "info" | "warning" | "error"; readonly message: string }
  | { readonly type: "cockpitFolderPicked"; readonly context: string; readonly path: string | null };

export type CockpitWebviewToHost =
  | { readonly type: "cockpitReady" }
  | {
      readonly type: "cockpitLaunch";
      readonly profileId: ProfileId;
      readonly count: number;
      readonly promptOverride: string | null;
    }
  | {
      readonly type: "cockpitQuickLaunch";
      readonly name: string;
      readonly model: ModelChoice;
      readonly effort: EffortChoice;
      readonly permissionMode: PermissionMode;
      readonly cwd: string | null;
      readonly spaceId: string | null;
      readonly count: number;
      readonly prompt: string | null;
    }
  | { readonly type: "cockpitSaveProfile"; readonly profile: SessionProfile }
  | { readonly type: "cockpitDeleteProfile"; readonly profileId: ProfileId }
  | { readonly type: "cockpitSaveSpace"; readonly space: Space }
  | { readonly type: "cockpitDeleteSpace"; readonly spaceId: SpaceId }
  | { readonly type: "cockpitNewTerminal"; readonly spaceId: string | null }
  | { readonly type: "cockpitDetachTab"; readonly sessionId: string }
  | { readonly type: "cockpitPickFolder"; readonly context: string }
  | { readonly type: "terminalInput"; readonly sessionId: string; readonly data: string }
  | { readonly type: "terminalResize"; readonly sessionId: string; readonly cols: number; readonly rows: number }
  | { readonly type: "terminalClose"; readonly sessionId: string }
  | { readonly type: "cockpitResumeSession"; readonly sessionId: string }
  | { readonly type: "cockpitPauseSession"; readonly sessionId: string }
  | { readonly type: "cockpitAddTab"; readonly windowId: string }
  | { readonly type: "cockpitMoveSession"; readonly sessionId: string; readonly spaceId: string | null }
  | {
      readonly type: "cockpitAdoptSession";
      readonly sessionId: string;
      readonly name: string;
      readonly cwd: string | null;
      readonly spaceId: string | null;
    }
  | {
      readonly type: "cockpitDropImage";
      readonly sessionId: string;
      readonly fileName: string;
      readonly dataBase64: string;
    }
  | { readonly type: "cockpitSaveLayout"; readonly layout: CockpitLayout };

export { assertNever as assertNeverCockpit } from "../../shared/assertNever";
