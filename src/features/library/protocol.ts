import type {
  AgentItem,
  AgentName,
  Frontmatter,
  LibrarySnapshot,
  ProjectEntry,
  ProjectPath,
  Scope,
  SkillItem,
  SkillName,
} from "./domain/types";
import type { EffortChoice, ModelChoice } from "../../shared/models";
import type { ReplayTurn } from "../../shared/assistant/timeline";

export type LibraryNotice = {
  readonly level: "info" | "warning" | "error";
  readonly message: string;
};

export interface ImportCandidate {
  readonly kind: "skill" | "agent";
  readonly name: string;
  readonly origin: "global" | { readonly path: ProjectPath; readonly label: string };
  readonly description: string;
  readonly sourcePath: string;
}

export interface AssistantContext {
  readonly itemKey: string;
  readonly kind: "skill" | "agent";
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly attachedSkills: readonly string[];
}

export interface AssistantTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface AssistantConversationMeta {
  readonly id: string;
  readonly title: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly mode?: AssistantMode;
}

export type LibraryHostToWebview =
  | { readonly type: "librarySnapshot"; readonly snapshot: LibrarySnapshot }
  | { readonly type: "libraryNotice"; readonly notice: LibraryNotice }
  | { readonly type: "libraryImportCandidates"; readonly candidates: readonly ImportCandidate[] }
  | { readonly type: "librarySyncProgress"; readonly working: boolean }
  | { readonly type: "assistantReply"; readonly itemKey: string; readonly conversationId: string; readonly events: readonly TimelineEvent[]; readonly text: string; readonly suggestedDescription: string | null }
  | { readonly type: "assistantProgress"; readonly itemKey: string; readonly conversationId: string; readonly events: readonly TimelineEvent[] }
  | { readonly type: "assistantHistory"; readonly itemKey: string; readonly conversationId: string; readonly turns: readonly ReplayTurn[] }
  | { readonly type: "assistantError"; readonly itemKey: string; readonly conversationId: string; readonly message: string }
  | { readonly type: "assistantBusy"; readonly itemKey: string; readonly conversationId: string; readonly busy: boolean }
  | { readonly type: "assistantConversations"; readonly itemKey: string; readonly conversations: readonly AssistantConversationMeta[] };

export type TimelineEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool_use"; readonly id: string; readonly name: string; readonly input: string }
  | { readonly kind: "tool_result"; readonly toolUseId: string; readonly preview: string; readonly isError: boolean };

export type AssistantMode = "writeBody" | "discuss";

export type LibraryWebviewToHost =
  | { readonly type: "ready" }
  | { readonly type: "createSkill"; readonly name: string }
  | { readonly type: "createAgent"; readonly name: string }
  | { readonly type: "deleteSkill"; readonly name: SkillName }
  | { readonly type: "deleteAgent"; readonly name: AgentName }
  | { readonly type: "deleteSkillsBulk"; readonly names: readonly SkillName[] }
  | { readonly type: "deleteAgentsBulk"; readonly names: readonly AgentName[] }
  | { readonly type: "renameSkill"; readonly from: SkillName; readonly to: string }
  | { readonly type: "renameAgent"; readonly from: AgentName; readonly to: string }
  | {
      readonly type: "saveSkill";
      readonly name: SkillName;
      readonly frontmatter: Frontmatter;
      readonly body: string;
    }
  | {
      readonly type: "saveAgent";
      readonly name: AgentName;
      readonly frontmatter: Frontmatter;
      readonly body: string;
      readonly attachedSkills: readonly SkillName[];
    }
  | { readonly type: "setSkillScope"; readonly name: SkillName; readonly scope: Scope }
  | { readonly type: "setAgentScope"; readonly name: AgentName; readonly scope: Scope }
  | { readonly type: "addProject" }
  | { readonly type: "removeProject"; readonly path: ProjectPath }
  | { readonly type: "scanForImports" }
  | { readonly type: "importCandidates"; readonly items: readonly ImportCandidate[] }
  | { readonly type: "syncNow" }
  | { readonly type: "openLibraryDir" }
  | { readonly type: "assistantAsk"; readonly context: AssistantContext; readonly conversationId: string; readonly message: string; readonly mode: AssistantMode; readonly model: ModelChoice; readonly effort: EffortChoice }
  | { readonly type: "assistantListConversations"; readonly itemKey: string }
  | { readonly type: "assistantLoadHistory"; readonly itemKey: string; readonly conversationId: string }
  | { readonly type: "assistantCancel"; readonly conversationId: string }
  | { readonly type: "assistantRenameConversation"; readonly itemKey: string; readonly conversationId: string; readonly title: string }
  | { readonly type: "assistantDeleteConversation"; readonly itemKey: string; readonly conversationId: string };

export interface LibrarySaveRequest {
  readonly skill?: SkillItem;
  readonly agent?: AgentItem;
}

export type { ProjectEntry };
