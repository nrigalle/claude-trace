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
import type { ImportScanner } from "../infra/ImportScanner";
import type { LibraryAssistant } from "../infra/LibraryAssistant";
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
}

export class LibraryController {
  private readonly disposables: { dispose(): void }[] = [];

  constructor(private readonly deps: LibraryControllerDeps) {
    this.disposables.push(deps.host.onMessage((m) => this.onMessage(m)));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
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
        this.afterMutation();
        return;
      case "deleteAgent":
        store.deleteAgent(msg.name);
        this.afterMutation();
        return;
      case "deleteSkillsBulk":
        for (const n of msg.names) store.deleteSkill(n);
        this.afterMutation();
        return;
      case "deleteAgentsBulk":
        for (const n of msg.names) store.deleteAgent(n);
        this.afterMutation();
        return;
      case "renameSkill":
        store.renameSkill(msg.from, msg.to);
        this.afterMutation();
        return;
      case "renameAgent":
        store.renameAgent(msg.from, msg.to);
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
        await this.handleAssistantAsk(msg.context, msg.message, msg.mode, msg.model, msg.effort);
        return;
      case "assistantReset":
        this.deps.assistant?.resetItem(msg.itemKey);
        return;
      case "assistantCancel":
        this.deps.assistant?.cancel(msg.itemKey);
        return;
      default:
        return assertNever(msg);
    }
  }

  private async handleAssistantAsk(
    context: AssistantContext,
    message: string,
    mode: AssistantMode,
    model: ModelChoice,
    effort: EffortChoice,
  ): Promise<void> {
    if (!this.deps.assistant) {
      this.deps.host.postMessage({
        type: "assistantError",
        itemKey: context.itemKey,
        message: "Assistant is not available on this build.",
      });
      return;
    }
    this.deps.host.postMessage({ type: "assistantBusy", itemKey: context.itemKey, busy: true });
    try {
      const result = await this.deps.assistant.ask(context, message, {
        cwd: this.deps.actions.workspaceCwd?.(),
        mode,
        model,
        effort,
        onProgress: (events) => {
          this.deps.host.postMessage({
            type: "assistantProgress",
            itemKey: context.itemKey,
            events,
          });
        },
      });
      this.deps.host.postMessage({
        type: "assistantReply",
        itemKey: context.itemKey,
        events: result.events,
        text: result.text,
        suggestedDescription: result.suggestedDescription,
      });
    } catch (err) {
      this.deps.host.postMessage({
        type: "assistantError",
        itemKey: context.itemKey,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.deps.host.postMessage({ type: "assistantBusy", itemKey: context.itemKey, busy: false });
    }
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
