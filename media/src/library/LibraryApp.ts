import {
  toAgentName,
  toSkillName,
  type AgentItem,
  type AgentName,
  type Frontmatter,
  type LibrarySnapshot,
  type ProjectPath,
  type Scope,
  type SkillItem,
  type SkillName,
} from "../../../src/features/library/domain/types";
import type {
  AssistantContext,
  ImportCandidate,
  LibraryHostToWebview,
  LibraryWebviewToHost,
} from "../../../src/features/library/protocol";
import { assertNever } from "../../../src/shared/assertNever";
import { clear, h } from "../ui/h.js";
import { attachTip } from "../ui/tooltip.js";
import { askConfirm, askName } from "../ui/modal.js";
import { AssistantPanel } from "./AssistantPanel.js";
import { descriptionOf } from "./libraryHelpers.js";
import { renderAgentHotReloadWarning, renderEditorTabs, renderEmptyHelp, renderResourceList, renderSkillHotReloadHint } from "./libraryEditorParts.js";
import { buildImportSheet } from "./libraryImport.js";
import { renderBodyEditor, renderFrontmatterForm } from "./libraryFrontmatterForm.js";
import { renderAssignmentsPanel, renderAttachedSkillsPicker } from "./libraryAssignments.js";
import {
  renderAgentRow,
  renderBulkBar,
  renderEmptyState,
  renderSkillRow,
  type RowContext,
} from "./libraryRows.js";

type Send = (msg: LibraryWebviewToHost) => void;

type Tab = "skills" | "agents";
type EditorTab = "edit" | "assignments";
type ProjectFilter =
  | { readonly kind: "all" }
  | { readonly kind: "global" }
  | { readonly kind: "unassigned" }
  | { readonly kind: "project"; readonly path: ProjectPath };

interface LibraryAppDeps {
  readonly send: Send;
}

export class LibraryApp {
  private readonly root: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly listEl: HTMLElement;
  private readonly editorEl: HTMLElement;
  private readonly skillsTabBtn: HTMLButtonElement;
  private readonly agentsTabBtn: HTMLButtonElement;
  private emptyHelpEl: HTMLElement;
  private snapshot: LibrarySnapshot = { skills: [], agents: [], projects: [] };
  private tab: Tab = "skills";
  private query = "";
  private projectFilter: ProjectFilter = { kind: "all" };
  private filterSelect: HTMLSelectElement | null = null;
  private selectedSkill: SkillName | null = null;
  private selectedAgent: AgentName | null = null;
  private selectMode = false;
  private selectedSkillKeys = new Set<string>();
  private selectedAgentKeys = new Set<string>();
  private selectBtn!: HTMLButtonElement;
  private bulkBar!: HTMLElement;
  private editorTab: EditorTab = "edit";
  private pendingFrontmatter: Frontmatter | null = null;
  private pendingBody: string | null = null;
  private pendingAttachedSkills: readonly SkillName[] | null = null;
  private dirty = false;
  private importBanner: HTMLElement | null = null;
  private hasReceivedFirstSnapshot = false;
  private autoScanFired = false;
  private autoScanInProgress = false;
  private lastImportCandidateCount = 0;
  private readonly assistantPanel: AssistantPanel;
  private bodyTextarea: HTMLTextAreaElement | null = null;
  private descriptionTextarea: HTMLTextAreaElement | null = null;

  constructor(private readonly deps: LibraryAppDeps) {
    this.skillsTabBtn = h("button", {
      className: "lib-seg active",
      attrs: { type: "button" },
      textContent: "Skills",
      on: { click: () => this.setTab("skills") },
    });
    this.agentsTabBtn = h("button", {
      className: "lib-seg",
      attrs: { type: "button" },
      textContent: "Agents",
      on: { click: () => this.setTab("agents") },
    });
    const seg = h("div", { className: "lib-segctl", attrs: { role: "tablist" } },
      this.skillsTabBtn,
      this.agentsTabBtn,
    );

    this.searchInput = h("input", {
      className: "lib-search",
      attrs: { type: "search", placeholder: "Search…", "aria-label": "Search library" },
      on: {
        input: () => {
          this.query = this.searchInput.value.trim().toLowerCase();
          this.renderList();
        },
      },
    });

    const newBtn = h("button", {
      className: "lib-new-btn",
      attrs: { type: "button", "data-tip": "Create a new skill or agent in your library" },
      textContent: "New",
      on: { click: () => this.startNew() },
    });
    attachTip(newBtn);

    const syncBtn = h("button", {
      className: "lib-ghost-btn",
      attrs: { type: "button", "data-tip": "Re-sync the library to every assigned target. Trace only touches files it created." },
      textContent: "Sync",
      on: { click: () => this.deps.send({ type: "syncNow" }) },
    });
    attachTip(syncBtn);

    const importBtn = h("button", {
      className: "lib-ghost-btn",
      attrs: { type: "button", "data-tip": "Scan ~/.claude and known projects for existing skills and agents you can bring into the library" },
      textContent: "Import…",
      on: { click: () => this.deps.send({ type: "scanForImports" }) },
    });
    attachTip(importBtn);

    const openDirBtn = h("button", {
      className: "lib-ghost-btn",
      attrs: { type: "button", "data-tip": "Open ~/.claude-trace/library in your file manager" },
      textContent: "Open folder",
      on: { click: () => this.deps.send({ type: "openLibraryDir" }) },
    });
    attachTip(openDirBtn);

    const toolbar = h("div", { className: "lib-toolbar" },
      seg,
      h("div", { className: "lib-toolbar-spacer" }),
      importBtn,
      syncBtn,
      openDirBtn,
    );

    this.listEl = h("div", { className: "lib-list", attrs: { role: "list" } });

    this.filterSelect = h("select", {
      className: "lib-filter-select",
      attrs: { "aria-label": "Filter by scope or project" },
      on: { change: () => this.applyFilterFromSelect() },
    });
    this.rebuildFilterOptions();

    this.selectBtn = h("button", {
      className: "lib-ghost-btn lib-select-btn",
      attrs: { type: "button", "data-tip": "Select multiple items to delete in bulk" },
      textContent: "Select",
      on: { click: () => this.toggleSelectMode() },
    });
    attachTip(this.selectBtn);

    this.bulkBar = h("div", { className: "lib-bulk-bar", attrs: { hidden: "true" } });

    const sidebar = h("div", { className: "lib-sidebar" },
      h("div", { className: "lib-sidebar-head" },
        this.searchInput,
        this.selectBtn,
        newBtn,
      ),
      h("div", { className: "lib-sidebar-filter" },
        h("span", { className: "lib-filter-label", textContent: "Show" }),
        this.filterSelect,
      ),
      this.bulkBar,
      this.listEl,
    );

    this.editorEl = h("div", { className: "lib-editor" });
    this.emptyHelpEl = h("div", { className: "lib-empty" });
    this.editorEl.appendChild(this.emptyHelpEl);

    this.assistantPanel = new AssistantPanel({
      send: (m) => this.deps.send(m),
      getContext: () => this.currentAssistantContext(),
      onApplyBody: (text) => this.applyAssistantBody(text, "replace"),
      onApplyDescription: (text) => this.applyAssistantDescription(text),
    });

    const main = h("div", { className: "lib-main" },
      sidebar,
      h("div", { className: "lib-divider" }),
      this.editorEl,
      this.assistantPanel.element(),
    );

    this.root = h("div", { className: "lib-root" }, toolbar, main);
    renderEmptyHelp();
  }

  element(): HTMLElement {
    return this.root;
  }

  receive(msg: LibraryHostToWebview): void {
    switch (msg.type) {
      case "librarySnapshot": {
        const previousSelectionStillExists = this.selectionStillExists(msg.snapshot);
        const wasFirst = !this.hasReceivedFirstSnapshot;
        this.hasReceivedFirstSnapshot = true;
        this.snapshot = msg.snapshot;
        if (!previousSelectionStillExists) this.clearSelection();
        this.pruneBulkSelections();
        this.rebuildFilterOptions();
        this.reconcileFilter();
        this.renderList();
        this.renderEditor();
        if (wasFirst && this.libraryIsEmpty() && !this.autoScanFired) {
          this.autoScanFired = true;
          this.autoScanInProgress = true;
          this.deps.send({ type: "scanForImports" });
          this.renderList();
        }
        return;
      }
      case "libraryImportCandidates":
        this.autoScanInProgress = false;
        this.lastImportCandidateCount = msg.candidates.length;
        if (msg.candidates.length > 0) this.showImportSheet(msg.candidates);
        if (this.libraryIsEmpty()) this.renderList();
        return;
      case "librarySyncProgress":
        this.root.classList.toggle("syncing", msg.working);
        return;
      case "libraryNotice":
        this.flashNotice(msg.notice.level, msg.notice.message);
        return;
      case "assistantReply":
      case "assistantProgress":
      case "assistantHistory":
      case "assistantError":
      case "assistantBusy":
      case "assistantConversations":
        this.assistantPanel.receive(msg);
        return;
      default:
        assertNever(msg);
    }
  }

  private libraryIsEmpty(): boolean {
    return this.snapshot.skills.length === 0 && this.snapshot.agents.length === 0;
  }

  private currentAssistantContext(): AssistantContext | null {
    if (this.tab === "skills" && this.selectedSkill) {
      const skill = this.snapshot.skills.find((s) => s.name === this.selectedSkill);
      if (!skill) return null;
      const fm = this.pendingFrontmatter ?? skill.frontmatter;
      const body = this.pendingBody ?? skill.body;
      return {
        itemKey: `skill:${skill.name as string}`,
        kind: "skill",
        name: skill.name as string,
        description: typeof fm["description"] === "string" ? (fm["description"] as string) : "",
        body,
        attachedSkills: [],
      };
    }
    if (this.tab === "agents" && this.selectedAgent) {
      const agent = this.snapshot.agents.find((a) => a.name === this.selectedAgent);
      if (!agent) return null;
      const fm = this.pendingFrontmatter ?? agent.frontmatter;
      const body = this.pendingBody ?? agent.body;
      const attached = (this.pendingAttachedSkills ?? agent.attachedSkills).map((s) => s as string);
      return {
        itemKey: `agent:${agent.name as string}`,
        kind: "agent",
        name: agent.name as string,
        description: typeof fm["description"] === "string" ? (fm["description"] as string) : "",
        body,
        attachedSkills: attached,
      };
    }
    return null;
  }

  private applyAssistantBody(text: string, mode: "replace" | "append"): void {
    if (text.length === 0) return;
    if (this.editorTab !== "edit") {
      this.editorTab = "edit";
      this.renderEditor();
    }
    if (!this.bodyTextarea) return;
    const next = mode === "replace"
      ? text
      : `${this.bodyTextarea.value}${this.bodyTextarea.value.length > 0 && !this.bodyTextarea.value.endsWith("\n") ? "\n\n" : ""}${text}`;
    this.bodyTextarea.value = next;
    this.bodyTextarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private applyAssistantDescription(text: string): void {
    if (text.length === 0) return;
    if (this.editorTab !== "edit") {
      this.editorTab = "edit";
      this.renderEditor();
    }
    if (!this.descriptionTextarea) return;
    this.descriptionTextarea.value = text;
    this.descriptionTextarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private setTab(tab: Tab): void {
    if (tab === this.tab) return;
    this.tab = tab;
    this.skillsTabBtn.classList.toggle("active", tab === "skills");
    this.agentsTabBtn.classList.toggle("active", tab === "agents");
    this.discardPending();
    this.clearSelection();
    this.renderList();
    this.renderEditor();
  }

  private pruneBulkSelections(): void {
    const liveSkills = new Set(this.snapshot.skills.map((s) => s.name as string));
    for (const k of [...this.selectedSkillKeys]) if (!liveSkills.has(k)) this.selectedSkillKeys.delete(k);
    const liveAgents = new Set(this.snapshot.agents.map((a) => a.name as string));
    for (const k of [...this.selectedAgentKeys]) if (!liveAgents.has(k)) this.selectedAgentKeys.delete(k);
  }

  private discardPending(): void {
    this.pendingFrontmatter = null;
    this.pendingBody = null;
    this.pendingAttachedSkills = null;
    this.dirty = false;
  }

  private clearSelection(): void {
    this.selectedSkill = null;
    this.selectedAgent = null;
    this.discardPending();
  }

  private selectionStillExists(snapshot: LibrarySnapshot): boolean {
    if (this.tab === "skills" && this.selectedSkill) {
      return snapshot.skills.some((s) => s.name === this.selectedSkill);
    }
    if (this.tab === "agents" && this.selectedAgent) {
      return snapshot.agents.some((a) => a.name === this.selectedAgent);
    }
    return true;
  }

  private renderList(): void {
    clear(this.listEl);
    const items = this.tab === "skills" ? this.filteredSkills() : this.filteredAgents();
    if (items.length === 0) {
      this.listEl.appendChild(renderEmptyState({
        isSkills: this.tab === "skills",
        autoScanInProgress: this.autoScanInProgress,
        autoScanFired: this.autoScanFired,
        importCandidateCount: this.lastImportCandidateCount,
        onCreate: () => void this.startNew(),
        onScan: () => this.deps.send({ type: "scanForImports" }),
      }));
      this.renderBulkBar();
      return;
    }
    const ctx = this.rowContext();
    for (const item of items) {
      if (this.tab === "skills") this.listEl.appendChild(renderSkillRow(item as SkillItem, ctx));
      else this.listEl.appendChild(renderAgentRow(item as AgentItem, ctx));
    }
    this.renderBulkBar();
  }

  private rowContext(): RowContext {
    return {
      selectMode: this.selectMode,
      projects: this.snapshot.projects,
      selectedSkill: this.selectedSkill,
      selectedAgent: this.selectedAgent,
      isRowChecked: (name) => this.currentSelectionSet().has(name),
      onToggleRow: (name) => { this.toggleRowSelected(name); this.renderList(); },
      onSelectSkill: (name) => this.selectSkill(name),
      onSelectAgent: (name) => this.selectAgent(name),
      onDeleteSkill: (skill) => void this.deleteSkillWithConfirm(skill),
      onDeleteAgent: (agent) => void this.deleteAgentWithConfirm(agent),
    };
  }

  private async deleteSkillWithConfirm(skill: SkillItem): Promise<void> {
    const ok = await askConfirm(this.root, {
      title: `Delete skill "${skill.name as string}"?`,
      message: "Trace also removes it from every assigned project. Files outside the library are untouched.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    this.deps.send({ type: "deleteSkill", name: skill.name });
    if (this.selectedSkill === skill.name) this.clearSelection();
  }

  private async deleteAgentWithConfirm(agent: AgentItem): Promise<void> {
    const ok = await askConfirm(this.root, {
      title: `Delete agent "${agent.name as string}"?`,
      message: "Trace also removes it from every assigned project. Files outside the library are untouched.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    this.deps.send({ type: "deleteAgent", name: agent.name });
    if (this.selectedAgent === agent.name) this.clearSelection();
  }

  private renderBulkBar(): void {
    renderBulkBar(this.bulkBar, {
      selectMode: this.selectMode,
      selectedCount: this.currentSelectionSet().size,
      allVisibleSelected: this.currentVisibleItemNames().length > 0 && this.currentVisibleItemNames().every((n) => this.currentSelectionSet().has(n)),
      someVisibleSelected: this.currentVisibleItemNames().some((n) => this.currentSelectionSet().has(n)),
      onToggleSelectAll: () => this.toggleSelectAll(),
      onDeleteSelected: () => void this.deleteSelected(),
    });
  }

  private toggleSelectMode(): void {
    this.selectMode = !this.selectMode;
    if (!this.selectMode) {
      this.selectedSkillKeys.clear();
      this.selectedAgentKeys.clear();
    }
    this.selectBtn.classList.toggle("active", this.selectMode);
    this.selectBtn.textContent = this.selectMode ? "Done" : "Select";
    this.renderList();
  }

  private currentSelectionSet(): Set<string> {
    return this.tab === "skills" ? this.selectedSkillKeys : this.selectedAgentKeys;
  }

  private currentVisibleItemNames(): readonly string[] {
    return this.tab === "skills"
      ? this.filteredSkills().map((s) => s.name as string)
      : this.filteredAgents().map((a) => a.name as string);
  }

  private toggleRowSelected(name: string): void {
    const set = this.currentSelectionSet();
    if (set.has(name)) set.delete(name);
    else set.add(name);
    this.renderBulkBar();
  }

  private toggleSelectAll(): void {
    const set = this.currentSelectionSet();
    const visible = this.currentVisibleItemNames();
    const allSelected = visible.length > 0 && visible.every((n) => set.has(n));
    if (allSelected) {
      for (const n of visible) set.delete(n);
    } else {
      for (const n of visible) set.add(n);
    }
    this.renderList();
  }

  private async deleteSelected(): Promise<void> {
    const set = this.currentSelectionSet();
    const count = set.size;
    if (count === 0) return;
    const kindLabel = this.tab === "skills" ? (count === 1 ? "skill" : "skills") : (count === 1 ? "agent" : "agents");
    const ok = await askConfirm(this.root, {
      title: `Delete ${count} ${kindLabel}?`,
      message: "Trace also removes them from every assigned project. Files outside the library are untouched.",
      confirmLabel: `Delete ${count}`,
      destructive: true,
    });
    if (!ok) return;
    const names = [...set];
    if (this.tab === "skills") {
      this.deps.send({ type: "deleteSkillsBulk", names: names.map(toSkillName) });
      if (this.selectedSkill && set.has(this.selectedSkill as string)) this.clearSelection();
    } else {
      this.deps.send({ type: "deleteAgentsBulk", names: names.map(toAgentName) });
      if (this.selectedAgent && set.has(this.selectedAgent as string)) this.clearSelection();
    }
    set.clear();
    this.renderBulkBar();
  }

  private filteredSkills(): readonly SkillItem[] {
    return this.snapshot.skills.filter((s) =>
      scopeMatches(this.projectFilter, s.scope) &&
      (this.query === "" || matchesQuery(this.query, [s.name as string, descriptionOf(s.frontmatter), s.body])),
    );
  }

  private filteredAgents(): readonly AgentItem[] {
    return this.snapshot.agents.filter((a) =>
      scopeMatches(this.projectFilter, a.scope) &&
      (this.query === "" || matchesQuery(this.query, [a.name as string, descriptionOf(a.frontmatter), a.body])),
    );
  }

  private rebuildFilterOptions(): void {
    if (!this.filterSelect) return;
    const select = this.filterSelect;
    const current = select.value;
    clear(select);
    select.appendChild(makeOption("all", "All"));
    select.appendChild(makeOption("global", "Global (~/.claude)"));
    select.appendChild(makeOption("unassigned", "Unassigned"));
    if (this.snapshot.projects.length > 0) {
      const group = document.createElement("optgroup");
      group.label = "Projects";
      for (const p of this.snapshot.projects) {
        const o = makeOption(`project:${p.path as string}`, p.label);
        o.title = p.path as string;
        group.appendChild(o);
      }
      select.appendChild(group);
    }
    const desired = filterToOptionValue(this.projectFilter);
    if (current && [...select.options].some((o) => o.value === desired)) {
      select.value = desired;
    } else {
      select.value = "all";
    }
  }

  private reconcileFilter(): void {
    if (this.projectFilter.kind !== "project") return;
    const stillExists = this.snapshot.projects.some(
      (p) => (p.path as string) === (this.projectFilter as { readonly path: ProjectPath }).path as string,
    );
    if (!stillExists) this.projectFilter = { kind: "all" };
  }

  private applyFilterFromSelect(): void {
    if (!this.filterSelect) return;
    const v = this.filterSelect.value;
    if (v === "all") this.projectFilter = { kind: "all" };
    else if (v === "global") this.projectFilter = { kind: "global" };
    else if (v === "unassigned") this.projectFilter = { kind: "unassigned" };
    else if (v.startsWith("project:")) {
      this.projectFilter = { kind: "project", path: v.slice("project:".length) as ProjectPath };
    }
    this.renderList();
  }

  private selectSkill(name: SkillName): void {
    if (this.dirty && this.selectedSkill && this.selectedSkill !== name) {
      this.persistPending();
    }
    this.selectedSkill = name;
    this.selectedAgent = null;
    this.discardPending();
    this.renderList();
    this.renderEditor();
  }

  private selectAgent(name: AgentName): void {
    if (this.dirty && this.selectedAgent && this.selectedAgent !== name) {
      this.persistPending();
    }
    this.selectedAgent = name;
    this.selectedSkill = null;
    this.discardPending();
    this.renderList();
    this.renderEditor();
  }

  private renderEditor(): void {
    clear(this.editorEl);
    this.bodyTextarea = null;
    this.descriptionTextarea = null;
    if (this.tab === "skills") {
      const skill = this.snapshot.skills.find((s) => s.name === this.selectedSkill);
      if (!skill) {
        this.emptyHelpEl = renderEmptyHelp();
        this.editorEl.appendChild(this.emptyHelpEl);
        this.assistantPanel.switchItem();
        return;
      }
      this.editorEl.appendChild(this.renderSkillEditor(skill));
      this.captureTextareaRefs();
      this.assistantPanel.switchItem();
      return;
    }
    const agent = this.snapshot.agents.find((a) => a.name === this.selectedAgent);
    if (!agent) {
      this.emptyHelpEl = renderEmptyHelp();
      this.editorEl.appendChild(this.emptyHelpEl);
      this.assistantPanel.switchItem();
      return;
    }
    this.editorEl.appendChild(this.renderAgentEditor(agent));
    this.captureTextareaRefs();
    this.assistantPanel.switchItem();
  }

  private captureTextareaRefs(): void {
    this.bodyTextarea = this.editorEl.querySelector('[data-section="body"] .ct-ta-input') as HTMLTextAreaElement | null;
    this.descriptionTextarea = this.editorEl.querySelector('[data-field="description"] .ct-ta-input') as HTMLTextAreaElement | null;
  }

  private renderSkillEditor(skill: SkillItem): HTMLElement {
    const tabsHead = this.renderEditorTabs(skill.name as string);
    const content = h("div", { className: "lib-editor-body" });

    const currentFm = (): Frontmatter => this.pendingFrontmatter ?? skill.frontmatter;
    const currentBody = (): string => this.pendingBody ?? skill.body;
    const updateFrontmatter = (fm: Frontmatter): void => {
      this.pendingFrontmatter = fm;
      this.pendingBody = currentBody();
      this.dirty = true;
      this.toggleSaveEnabled();
    };
    const updateBody = (body: string): void => {
      this.pendingFrontmatter = currentFm();
      this.pendingBody = body;
      this.dirty = true;
      this.toggleSaveEnabled();
    };

    if (this.editorTab === "edit") {
      content.appendChild(renderFrontmatterForm(currentFm(), "skill", updateFrontmatter));
      content.appendChild(renderBodyEditor("Skill instructions", currentBody(), updateBody));
      content.appendChild(renderResourceList(skill));
      content.appendChild(renderSkillHotReloadHint());
    } else {
      content.appendChild(renderAssignmentsPanel(skill.scope, this.snapshot.projects, (next) => {
        this.deps.send({ type: "setSkillScope", name: skill.name, scope: next });
      }, () => this.deps.send({ type: "addProject" })));
    }

    return h("div", { className: "lib-editor-pane" }, tabsHead, content);
  }

  private renderAgentEditor(agent: AgentItem): HTMLElement {
    const tabsHead = this.renderEditorTabs(agent.name as string);
    const content = h("div", { className: "lib-editor-body" });

    const currentFm = (): Frontmatter => this.pendingFrontmatter ?? agent.frontmatter;
    const currentBody = (): string => this.pendingBody ?? agent.body;
    const currentAttached = (): readonly SkillName[] => this.pendingAttachedSkills ?? agent.attachedSkills;
    const updateFrontmatter = (fm: Frontmatter): void => {
      this.pendingFrontmatter = fm;
      this.pendingBody = currentBody();
      this.pendingAttachedSkills = currentAttached();
      this.dirty = true;
      this.toggleSaveEnabled();
    };
    const updateBody = (body: string): void => {
      this.pendingFrontmatter = currentFm();
      this.pendingBody = body;
      this.pendingAttachedSkills = currentAttached();
      this.dirty = true;
      this.toggleSaveEnabled();
    };
    const updateAttached = (attached: readonly SkillName[]): void => {
      this.pendingFrontmatter = currentFm();
      this.pendingBody = currentBody();
      this.pendingAttachedSkills = attached;
      this.dirty = true;
      this.toggleSaveEnabled();
    };

    if (this.editorTab === "edit") {
      content.appendChild(renderFrontmatterForm(currentFm(), "agent", updateFrontmatter));
      content.appendChild(renderBodyEditor("System prompt", currentBody(), updateBody));
      content.appendChild(renderAttachedSkillsPicker(this.snapshot.skills, currentAttached(), updateAttached));
      content.appendChild(renderAgentHotReloadWarning());
    } else {
      content.appendChild(renderAssignmentsPanel(agent.scope, this.snapshot.projects, (next) => {
        this.deps.send({ type: "setAgentScope", name: agent.name, scope: next });
      }, () => this.deps.send({ type: "addProject" })));
    }

    return h("div", { className: "lib-editor-pane" }, tabsHead, content);
  }

  private renderEditorTabs(title: string): HTMLElement {
    return renderEditorTabs(title, {
      editorTab: this.editorTab,
      assistantOpen: this.assistantPanel?.isOpen() ?? false,
      onTab: (tab) => { this.editorTab = tab; this.renderEditor(); },
      onSave: () => this.persistPending(),
      onRename: () => void this.startRename(title),
      onDelete: () => void this.confirmDelete(title),
      onAssist: () => this.toggleAssistant(),
    });
  }

  private toggleAssistant(): void {
    this.assistantPanel.setOpen(!this.assistantPanel.isOpen());
    this.root.classList.toggle("assistant-open", this.assistantPanel.isOpen());
    this.renderEditor();
  }

  private toggleSaveEnabled(): void {
    const btn = this.editorEl.querySelector(".lib-save-btn") as HTMLButtonElement | null;
    if (!btn) return;
    btn.disabled = !this.dirty;
    btn.classList.toggle("ready", this.dirty);
  }

  private persistPending(): void {
    if (this.tab === "skills" && this.selectedSkill) {
      const skill = this.snapshot.skills.find((s) => s.name === this.selectedSkill);
      if (!skill) return;
      const fm = this.pendingFrontmatter ?? skill.frontmatter;
      const body = this.pendingBody ?? skill.body;
      this.deps.send({ type: "saveSkill", name: skill.name, frontmatter: fm, body });
      this.discardPending();
      this.toggleSaveEnabled();
      return;
    }
    if (this.tab === "agents" && this.selectedAgent) {
      const agent = this.snapshot.agents.find((a) => a.name === this.selectedAgent);
      if (!agent) return;
      const fm = this.pendingFrontmatter ?? agent.frontmatter;
      const body = this.pendingBody ?? agent.body;
      const attached = this.pendingAttachedSkills ?? agent.attachedSkills;
      this.deps.send({ type: "saveAgent", name: agent.name, frontmatter: fm, body, attachedSkills: attached });
      this.discardPending();
      this.toggleSaveEnabled();
    }
  }

  private async startNew(): Promise<void> {
    const which = this.tab === "skills" ? "skill" : "agent";
    const raw = await askName(this.root, {
      title: `New ${which}`,
      description: "Lowercase letters, digits, and hyphens. This becomes the directory name and the command Claude uses.",
      placeholder: which === "skill" ? "e.g. code-review" : "e.g. reviewer",
      confirmLabel: `Create ${which}`,
      validate: (value) => {
        const n = normalizeName(value);
        if (n === "") return "Name is required.";
        if (this.tab === "skills" && this.snapshot.skills.some((s) => (s.name as string) === n)) {
          return `A skill named "${n}" already exists.`;
        }
        if (this.tab === "agents" && this.snapshot.agents.some((a) => (a.name as string) === n)) {
          return `An agent named "${n}" already exists.`;
        }
        return null;
      },
    });
    if (raw === null) return;
    const normalized = normalizeName(raw);
    if (normalized === "") return;
    if (this.tab === "skills") {
      this.selectedSkill = toSkillName(normalized);
      this.deps.send({ type: "createSkill", name: normalized });
    } else {
      this.selectedAgent = toAgentName(normalized);
      this.deps.send({ type: "createAgent", name: normalized });
    }
  }

  private async startRename(currentName: string): Promise<void> {
    const which = this.tab === "skills" ? "skill" : "agent";
    const raw = await askName(this.root, {
      title: `Rename ${which}`,
      description: "Lowercase letters, digits, and hyphens. Renaming also moves the files in every assigned target.",
      initial: currentName,
      confirmLabel: "Rename",
      validate: (value) => {
        const n = normalizeName(value);
        if (n === "") return "Name is required.";
        if (n === currentName) return "Pick a different name to rename.";
        if (this.tab === "skills" && this.snapshot.skills.some((s) => (s.name as string) === n)) {
          return `A skill named "${n}" already exists.`;
        }
        if (this.tab === "agents" && this.snapshot.agents.some((a) => (a.name as string) === n)) {
          return `An agent named "${n}" already exists.`;
        }
        return null;
      },
    });
    if (raw === null) return;
    const normalized = normalizeName(raw);
    if (normalized === "" || normalized === currentName) return;
    if (this.tab === "skills" && this.selectedSkill) {
      this.deps.send({ type: "renameSkill", from: this.selectedSkill, to: normalized });
      this.selectedSkill = toSkillName(normalized);
    } else if (this.tab === "agents" && this.selectedAgent) {
      this.deps.send({ type: "renameAgent", from: this.selectedAgent, to: normalized });
      this.selectedAgent = toAgentName(normalized);
    }
  }

  private async confirmDelete(name: string): Promise<void> {
    const which = this.tab === "skills" ? "skill" : "agent";
    const ok = await askConfirm(this.root, {
      title: `Delete ${which} "${name}"?`,
      message: "Trace also removes it from every assigned project. Files outside the library are not touched.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    if (this.tab === "skills" && this.selectedSkill) {
      this.deps.send({ type: "deleteSkill", name: this.selectedSkill });
      this.clearSelection();
    } else if (this.tab === "agents" && this.selectedAgent) {
      this.deps.send({ type: "deleteAgent", name: this.selectedAgent });
      this.clearSelection();
    }
  }

  private showImportSheet(candidates: readonly ImportCandidate[]): void {
    if (this.importBanner) {
      this.importBanner.remove();
      this.importBanner = null;
    }
    if (candidates.length === 0) {
      this.flashNotice("info", "Nothing to import. Your library is the only source.");
      return;
    }
    const close = (): void => { this.importBanner?.remove(); this.importBanner = null; };
    this.importBanner = buildImportSheet(candidates, (items) => {
      this.deps.send({ type: "importCandidates", items });
      close();
    }, close);
    this.root.appendChild(this.importBanner);
  }

  private flashNotice(level: "info" | "warning" | "error", message: string): void {
    const el = h("div", { className: `lib-toast lib-toast-${level}`, textContent: message });
    this.root.appendChild(el);
    window.setTimeout(() => el.classList.add("show"), 16);
    window.setTimeout(() => {
      el.classList.remove("show");
      window.setTimeout(() => el.remove(), 220);
    }, 2400);
  }
}

const normalizeName = (raw: string): string =>
  raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");

const makeOption = (value: string, label: string): HTMLOptionElement => {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
};

const filterToOptionValue = (f: ProjectFilter): string => {
  if (f.kind === "project") return `project:${f.path as string}`;
  return f.kind;
};

const scopeMatches = (f: ProjectFilter, scope: Scope): boolean => {
  if (f.kind === "all") return true;
  if (f.kind === "unassigned") return scope.kind === "unassigned" || (scope.kind === "projects" && scope.paths.length === 0);
  if (f.kind === "global") return scope.kind === "global";
  if (scope.kind !== "projects") return false;
  return scope.paths.some((p) => (p as string) === (f.path as string));
};


const matchesQuery = (q: string, parts: readonly string[]): boolean => {
  for (const p of parts) {
    if (typeof p === "string" && p.toLowerCase().includes(q)) return true;
  }
  return false;
};
