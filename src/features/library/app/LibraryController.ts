import { assertNever } from "../../../shared/assertNever";
import {
  isValidLibraryName,
  toAgentName,
  toSkillName,
  type LibrarySnapshot,
  type ProjectEntry,
  type ProjectPath,
} from "../domain/types";
import type { TargetLocation } from "../domain/materialize";
import type {
  AssistantContext,
  AssistantMode,
  ImportCandidate,
  LibraryHostToWebview,
  LibraryNotice,
  LibraryWebviewToHost,
} from "../protocol";
import type { EffortChoice, ModelChoice } from "../../../shared/models";
import type { ConversationStore } from "../../../shared/infra/assistant/conversationStore";
import type { ImportScanner } from "../infra/ImportScanner";
import type { LibraryAssistant, LibraryCatalog } from "../infra/LibraryAssistant";
import type { LibraryImporter } from "../infra/LibraryImporter";
import type { LibraryStore } from "../infra/LibraryStore";
import type { Materializer } from "../infra/Materializer";

export interface LibraryHost {
  postMessage(msg: LibraryHostToWebview): void;
  onMessage(listener: (msg: LibraryWebviewToHost) => void): { dispose(): void };
}

export interface LibraryActions {
  pickProjectFolder(): Promise<ProjectPath | null>;
  showInfo(message: string): void;
  showWarning(message: string): void;
  showError(message: string): void;
  workspaceProjects(): readonly ProjectEntry[];
  trackedProjects(): readonly ProjectEntry[];
  openLibraryDir(): void;
  workspaceCwd?(): string | undefined;
}

export interface LibraryControllerDeps {
  readonly host: LibraryHost;
  readonly store: LibraryStore;
  readonly materializer: Materializer;
  readonly scanner: ImportScanner;
  readonly importer: LibraryImporter;
  readonly actions: LibraryActions;
  readonly assistant?: LibraryAssistant;
  readonly assistantSessions?: ConversationStore;
  readonly clock: () => number;
}

export class LibraryController {
  private readonly disposables: { dispose(): void }[] = [];

  constructor(private readonly deps: LibraryControllerDeps) {
    this.disposables.push(deps.host.onMessage((m) => this.onMessage(m)));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.deps.assistant?.dispose();
  }

  pushSnapshot(): void {
    this.deps.host.postMessage({ type: "librarySnapshot", snapshot: this.snapshot() });
  }

  private snapshot(): LibrarySnapshot {
    const skills = this.deps.store.listSkills();
    const agents = this.deps.store.listAgents();
    const projects = this.mergedProjects();
    return { skills, agents, projects };
  }

  private mergedProjects(): readonly ProjectEntry[] {
    const seen = new Map<string, ProjectEntry>();
    const add = (entries: readonly ProjectEntry[]): void => {
      for (const e of entries) {
        const key = e.path as string;
        if (!seen.has(key)) seen.set(key, e);
      }
    };
    add(this.deps.actions.workspaceProjects());
    add(this.deps.actions.trackedProjects());
    add(this.deps.store.listProjects());
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  private notify(notice: LibraryNotice): void {
    this.deps.host.postMessage({ type: "libraryNotice", notice });
    if (notice.level === "error") this.deps.actions.showError(notice.message);
    else if (notice.level === "warning") this.deps.actions.showWarning(notice.message);
    else this.deps.actions.showInfo(notice.message);
  }

  private async onMessage(msg: LibraryWebviewToHost): Promise<void> {
    try {
      await this.handle(msg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.notify({ level: "error", message });
    }
  }

  private async handle(msg: LibraryWebviewToHost): Promise<void> {
    const store = this.deps.store;
    switch (msg.type) {
      case "ready":
        this.pushSnapshot();
        return;
      case "createSkill": {
        const trimmed = msg.name.trim();
        if (!isValidLibraryName(trimmed)) throw new Error(`invalid skill name: ${trimmed}`);
        store.writeSkill(
          toSkillName(trimmed),
          { name: trimmed, description: "" },
          "Describe what this skill does and when to use it.\n",
        );
        this.pushSnapshot();
        return;
      }
      case "createAgent": {
        const trimmed = msg.name.trim();
        if (!isValidLibraryName(trimmed)) throw new Error(`invalid agent name: ${trimmed}`);
        store.writeAgent(
          toAgentName(trimmed),
          { name: trimmed, description: "" },
          "Write the agent's system prompt here.\n",
        );
        this.pushSnapshot();
        return;
      }
      case "deleteSkill":
        store.deleteSkill(msg.name);
        this.deps.assistantSessions?.dropKey(`skill:${msg.name}`);
        this.afterMutation();
        return;
      case "deleteAgent":
        store.deleteAgent(msg.name);
        this.deps.assistantSessions?.dropKey(`agent:${msg.name}`);
        this.afterMutation();
        return;
      case "deleteSkillsBulk":
        for (const n of msg.names) {
          store.deleteSkill(n);
          this.deps.assistantSessions?.dropKey(`skill:${n}`);
        }
        this.afterMutation();
        return;
      case "deleteAgentsBulk":
        for (const n of msg.names) {
          store.deleteAgent(n);
          this.deps.assistantSessions?.dropKey(`agent:${n}`);
        }
        this.afterMutation();
        return;
      case "renameSkill":
        store.renameSkill(msg.from, msg.to);
        this.deps.assistantSessions?.move(`skill:${msg.from}`, `skill:${msg.to}`);
        this.afterMutation();
        return;
      case "renameAgent":
        store.renameAgent(msg.from, msg.to);
        this.deps.assistantSessions?.move(`agent:${msg.from}`, `agent:${msg.to}`);
        this.afterMutation();
        return;
      case "saveSkill":
        store.writeSkill(msg.name, msg.frontmatter, msg.body);
        this.afterMutation();
        return;
      case "saveAgent":
        store.writeAgent(msg.name, msg.frontmatter, msg.body);
        store.setAgentAttachedSkills(msg.name, msg.attachedSkills);
        this.afterMutation();
        return;
      case "setSkillScope":
        store.setSkillScope(msg.name, msg.scope);
        this.afterMutation();
        return;
      case "setAgentScope":
        store.setAgentScope(msg.name, msg.scope);
        this.afterMutation();
        return;
      case "addProject": {
        const picked = await this.deps.actions.pickProjectFolder();
        if (!picked) return;
        const all = store.listProjects().slice();
        if (all.some((p) => (p.path as string) === (picked as string))) {
          this.pushSnapshot();
          return;
        }
        const segments = (picked as string).split(/[/\\]/).filter((s) => s !== "");
        const label = segments[segments.length - 1] ?? (picked as string);
        all.push({ path: picked, label, source: "manual" });
        store.writeProjects(all);
        this.pushSnapshot();
        return;
      }
      case "removeProject": {
        const next = store.listProjects().filter((p) => (p.path as string) !== (msg.path as string));
        store.writeProjects(next);
        this.pushSnapshot();
        return;
      }
      case "scanForImports": {
        const candidates = this.deps.scanner.scan(this.mergedProjects());
        this.deps.host.postMessage({ type: "libraryImportCandidates", candidates });
        return;
      }
      case "importCandidates":
        this.importCandidates(msg.items);
        return;
      case "syncNow":
        this.runSync();
        return;
      case "openLibraryDir":
        this.deps.actions.openLibraryDir();
        return;
      case "assistantAsk":
        await this.handleAssistantAsk(msg.context, msg.conversationId, msg.message, msg.mode, msg.model, msg.effort);
        return;
      case "assistantListConversations":
        this.handleAssistantListConversations(msg.itemKey);
        return;
      case "assistantLoadHistory":
        this.handleAssistantHistory(msg.itemKey, msg.conversationId);
        return;
      case "assistantCancel":
        this.deps.assistant?.cancel(msg.conversationId);
        return;
      case "assistantRenameConversation":
        this.deps.assistantSessions?.rename(msg.itemKey, msg.conversationId, conversationTitle(msg.title));
        this.handleAssistantListConversations(msg.itemKey);
        return;
      case "assistantDeleteConversation":
        this.deps.assistant?.reset(msg.conversationId);
        this.deps.assistantSessions?.delete(msg.itemKey, msg.conversationId);
        this.handleAssistantListConversations(msg.itemKey);
        return;
      default:
        return assertNever(msg);
    }
  }

  private adoptIfSaved(itemKey: string, conversationId: string): void {
    const assistant = this.deps.assistant;
    if (!assistant || assistant.sessionInfo(conversationId)) return;
    const saved = this.deps.assistantSessions?.get(itemKey, conversationId);
    if (saved) assistant.adopt(conversationId, saved.sessionId, saved.cwd);
  }

  private handleAssistantListConversations(itemKey: string): void {
    const conversations = (this.deps.assistantSessions?.list(itemKey) ?? []).map((c) => ({
      id: c.id,
      title: c.title,
      createdAtMs: c.createdAtMs,
      updatedAtMs: c.updatedAtMs,
      mode: asMode(c.mode),
    }));
    this.deps.host.postMessage({ type: "assistantConversations", itemKey, conversations });
  }

  private handleAssistantHistory(itemKey: string, conversationId: string): void {
    const assistant = this.deps.assistant;
    if (!assistant) return;
    this.adoptIfSaved(itemKey, conversationId);
    this.deps.host.postMessage({
      type: "assistantHistory",
      itemKey,
      conversationId,
      turns: assistant.historyTurns(conversationId),
    });
  }

  private persistConversation(itemKey: string, conversationId: string, latestMessage: string, mode: AssistantMode): void {
    const assistant = this.deps.assistant;
    const store = this.deps.assistantSessions;
    if (!assistant || !store) return;
    const info = assistant.sessionInfo(conversationId);
    if (!info) return;
    const now = this.deps.clock();
    const existing = store.get(itemKey, conversationId);
    store.upsert(itemKey, {
      id: conversationId,
      sessionId: info.sessionId,
      cwd: info.cwd,
      title: existing?.title ?? conversationTitle(latestMessage),
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
      mode,
    });
  }

  private async handleAssistantAsk(
    context: AssistantContext,
    conversationId: string,
    message: string,
    mode: AssistantMode,
    model: ModelChoice,
    effort: EffortChoice,
  ): Promise<void> {
    const itemKey = context.itemKey;
    if (!this.deps.assistant) {
      this.deps.host.postMessage({
        type: "assistantError",
        itemKey,
        conversationId,
        message: "Assistant is not available on this build.",
      });
      return;
    }
    this.adoptIfSaved(itemKey, conversationId);
    this.deps.host.postMessage({ type: "assistantBusy", itemKey, conversationId, busy: true });
    try {
      const result = await this.deps.assistant.ask(context, message, {
        conversationId,
        cwd: this.deps.actions.workspaceCwd?.(),
        mode,
        model,
        effort,
        catalog: this.assistantCatalog(context),
        onProgress: (events) => {
          this.deps.host.postMessage({ type: "assistantProgress", itemKey, conversationId, events });
        },
      });
      this.persistConversation(itemKey, conversationId, message, mode);
      this.deps.host.postMessage({
        type: "assistantReply",
        itemKey,
        conversationId,
        events: result.events,
        text: result.text,
        suggestedDescription: result.suggestedDescription,
      });
      this.handleAssistantListConversations(itemKey);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (text !== "Cancelled.") {
        this.deps.host.postMessage({ type: "assistantError", itemKey, conversationId, message: text });
      }
    } finally {
      this.deps.host.postMessage({ type: "assistantBusy", itemKey, conversationId, busy: false });
    }
  }

  private assistantCatalog(context: AssistantContext): LibraryCatalog {
    const descOf = (fm: Readonly<Record<string, unknown>>): string => {
      const d = fm["description"];
      return typeof d === "string" ? d : "";
    };
    return {
      skills: this.deps.store
        .listSkills()
        .filter((s) => !(context.kind === "skill" && (s.name as string) === context.name))
        .map((s) => ({ name: s.name as string, description: descOf(s.frontmatter) })),
      agents: this.deps.store
        .listAgents()
        .filter((a) => !(context.kind === "agent" && (a.name as string) === context.name))
        .map((a) => ({ name: a.name as string, description: descOf(a.frontmatter) })),
    };
  }

  private afterMutation(): void {
    this.runSync();
    this.pushSnapshot();
  }

  private runSync(): void {
    this.deps.host.postMessage({ type: "librarySyncProgress", working: true });
    try {
      const snapshot = this.snapshot();
      const report = this.deps.materializer.syncAll(snapshot);
      if (report.errors.length > 0) {
        const first = report.errors[0];
        if (first) {
          this.notify({
            level: "warning",
            message: `Sync partially failed for ${describeTarget(first.target)}: ${first.message}`,
          });
        }
      }
    } finally {
      this.deps.host.postMessage({ type: "librarySyncProgress", working: false });
    }
  }

  private importCandidates(items: readonly ImportCandidate[]): void {
    let skillCount = 0;
    let agentCount = 0;
    let skipped = 0;
    for (const c of items) {
      const ok = this.deps.importer.importCandidate(c);
      if (!ok) {
        skipped += 1;
        continue;
      }
      if (c.kind === "skill") skillCount += 1;
      else agentCount += 1;
    }
    if (skillCount + agentCount === 0 && skipped === 0) {
      this.notify({ level: "info", message: "Nothing imported." });
      return;
    }
    const parts: string[] = [];
    if (skillCount > 0) parts.push(`${skillCount} skill${skillCount === 1 ? "" : "s"}`);
    if (agentCount > 0) parts.push(`${agentCount} agent${agentCount === 1 ? "" : "s"}`);
    const main = parts.length > 0 ? `Imported ${parts.join(" and ")}.` : "Nothing imported.";
    const suffix = skipped > 0 ? ` Skipped ${skipped} (already exists or unreadable).` : "";
    this.notify({ level: skipped > 0 ? "warning" : "info", message: `${main}${suffix}` });
    this.pushSnapshot();
  }
}

const describeTarget = (target: TargetLocation): string => {
  if (target.kind === "global") return "global (~/.claude)";
  return target.path as string;
};

const asMode = (m: string | undefined): AssistantMode | undefined =>
  m === "discuss" || m === "writeBody" ? m : undefined;

const conversationTitle = (firstMessage: string): string => {
  const oneLine = firstMessage.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return "New chat";
  return oneLine.length > 48 ? `${oneLine.slice(0, 45)}...` : oneLine;
};
