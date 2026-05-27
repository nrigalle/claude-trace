import type {
  ProfileId,
  ProfileValidationError,
  SessionProfile,
  Space,
  SpaceId,
} from "./domain/profiles";
import type { ModelChoice } from "../../shared/models";
import type { PermissionMode } from "../../shared/permissionModes";

export interface TerminalSession {
  readonly sessionId: string;
  readonly windowId: string;
  readonly name: string;
  readonly spaceId: string | null;
  readonly cwd: string | null;
  readonly alive: boolean;
  readonly exitCode: number | null;
  readonly startedAtMs: number;
}

export interface CockpitState {
  readonly profiles: readonly SessionProfile[];
  readonly spaces: readonly Space[];
  readonly terminals: readonly TerminalSession[];
}

export interface CockpitLayout {
  readonly columns: Record<string, number>;
  readonly spans: Record<string, { readonly cols: number; readonly rows: number }>;
  readonly order: readonly string[];
}

export type CockpitHostToWebview =
  | { readonly type: "cockpitState"; readonly state: CockpitState }
  | { readonly type: "terminalData"; readonly sessionId: string; readonly data: string }
  | { readonly type: "terminalExit"; readonly sessionId: string; readonly exitCode: number }
  | { readonly type: "terminalAttention"; readonly sessionId: string; readonly reason: "stop" | "notify" }
  | { readonly type: "terminalActive"; readonly sessionId: string }
  | { readonly type: "cockpitLayout"; readonly layout: CockpitLayout }
  | { readonly type: "cockpitProfileInvalid"; readonly errors: readonly ProfileValidationError[] }
  | { readonly type: "cockpitNotice"; readonly level: "info" | "warning" | "error"; readonly message: string };

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
  | { readonly type: "terminalInput"; readonly sessionId: string; readonly data: string }
  | { readonly type: "terminalResize"; readonly sessionId: string; readonly cols: number; readonly rows: number }
  | { readonly type: "terminalClose"; readonly sessionId: string }
  | { readonly type: "cockpitResumeSession"; readonly sessionId: string }
  | { readonly type: "cockpitAddTab"; readonly windowId: string }
  | { readonly type: "cockpitMoveSession"; readonly sessionId: string; readonly spaceId: string | null }
  | {
      readonly type: "cockpitAdoptSession";
      readonly sessionId: string;
      readonly name: string;
      readonly cwd: string | null;
    }
  | { readonly type: "cockpitAttention"; readonly sessionId: string; readonly name: string }
  | {
      readonly type: "cockpitDropImage";
      readonly sessionId: string;
      readonly fileName: string;
      readonly dataBase64: string;
    }
  | { readonly type: "cockpitSaveLayout"; readonly layout: CockpitLayout };

export { assertNever as assertNeverCockpit } from "../../shared/assertNever";
