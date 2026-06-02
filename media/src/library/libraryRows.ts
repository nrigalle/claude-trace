import { h, clear } from "../ui/h.js";
import { attachTip } from "../ui/tooltip.js";
import type {
  AgentItem,
  AgentName,
  ProjectEntry,
  SkillItem,
  SkillName,
} from "../../../src/features/library/domain/types";
import { descriptionOf, renderScopeChip } from "./libraryHelpers.js";

export interface RowContext {
  readonly selectMode: boolean;
  readonly projects: readonly ProjectEntry[];
  readonly selectedSkill: SkillName | null;
  readonly selectedAgent: AgentName | null;
  isRowChecked(name: string): boolean;
  onToggleRow(name: string): void;
  onSelectSkill(name: SkillName): void;
  onSelectAgent(name: AgentName): void;
  onDeleteSkill(skill: SkillItem): void;
  onDeleteAgent(agent: AgentItem): void;
}

const renderRowCheckbox = (name: string, ctx: RowContext): HTMLElement => {
  const checked = ctx.isRowChecked(name);
  return h("button", {
    className: `lib-row-check${checked ? " checked" : ""}`,
    attrs: { type: "button", "aria-label": checked ? `Deselect ${name}` : `Select ${name}`, "aria-pressed": checked ? "true" : "false" },
    on: {
      click: (e: Event) => {
        e.stopPropagation();
        ctx.onToggleRow(name);
      },
    },
  });
};

const renderRowDelete = (name: string, onConfirm: () => void): HTMLElement => {
  const btn = h("button", {
    className: "lib-row-delete",
    attrs: {
      type: "button",
      "aria-label": `Delete ${name}`,
      "data-tip": "Delete this item from the library and every assigned target",
    },
    innerHTML: "&times;",
    on: {
      click: (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        onConfirm();
      },
    },
  });
  attachTip(btn);
  return btn;
};

export const renderSkillRow = (skill: SkillItem, ctx: RowContext): HTMLElement => {
  const selected = ctx.selectedSkill === skill.name;
  const inBulk = ctx.selectMode && ctx.isRowChecked(skill.name as string);
  return h("div", {
    className: `lib-row${selected ? " selected" : ""}${ctx.selectMode ? " select-mode" : ""}${inBulk ? " bulk-checked" : ""}`,
    attrs: { role: "listitem" },
  },
    ctx.selectMode ? renderRowCheckbox(skill.name as string, ctx) : null,
    h("button", {
      className: "lib-row-main",
      attrs: { type: "button" },
      on: {
        click: () => {
          if (ctx.selectMode) ctx.onToggleRow(skill.name as string);
          else ctx.onSelectSkill(skill.name);
        },
      },
    },
      h("div", { className: "lib-row-title", textContent: skill.name as string }),
      h("div", { className: "lib-row-desc", textContent: descriptionOf(skill.frontmatter) || "No description yet" }),
      h("div", { className: "lib-row-meta" },
        renderScopeChip(skill.scope, ctx.projects),
        skill.resources.length > 0
          ? h("span", { className: "lib-row-extra", textContent: `${skill.resources.length} resource${skill.resources.length === 1 ? "" : "s"}` })
          : null,
      ),
    ),
    renderRowDelete(skill.name as string, () => ctx.onDeleteSkill(skill)),
  );
};

export const renderAgentRow = (agent: AgentItem, ctx: RowContext): HTMLElement => {
  const selected = ctx.selectedAgent === agent.name;
  const inBulk = ctx.selectMode && ctx.isRowChecked(agent.name as string);
  return h("div", {
    className: `lib-row${selected ? " selected" : ""}${ctx.selectMode ? " select-mode" : ""}${inBulk ? " bulk-checked" : ""}`,
    attrs: { role: "listitem" },
  },
    ctx.selectMode ? renderRowCheckbox(agent.name as string, ctx) : null,
    h("button", {
      className: "lib-row-main",
      attrs: { type: "button" },
      on: {
        click: () => {
          if (ctx.selectMode) ctx.onToggleRow(agent.name as string);
          else ctx.onSelectAgent(agent.name);
        },
      },
    },
      h("div", { className: "lib-row-title", textContent: agent.name as string }),
      h("div", { className: "lib-row-desc", textContent: descriptionOf(agent.frontmatter) || "No description yet" }),
      h("div", { className: "lib-row-meta" },
        renderScopeChip(agent.scope, ctx.projects),
        agent.attachedSkills.length > 0
          ? h("span", { className: "lib-row-extra", textContent: `${agent.attachedSkills.length} skill${agent.attachedSkills.length === 1 ? "" : "s"} attached` })
          : null,
      ),
    ),
    renderRowDelete(agent.name as string, () => ctx.onDeleteAgent(agent)),
  );
};

export interface EmptyStateContext {
  readonly isSkills: boolean;
  readonly autoScanInProgress: boolean;
  readonly autoScanFired: boolean;
  readonly importCandidateCount: number;
  onCreate(): void;
  onScan(): void;
}

export const renderEmptyState = (ctx: EmptyStateContext): HTMLElement => {
  const label = ctx.isSkills ? "No skills yet" : "No agents yet";
  if (ctx.autoScanInProgress) {
    return h("div", { className: "lib-list-empty" },
      h("div", { className: "lib-list-empty-title", textContent: "Looking on your machine…" }),
      h("div", { className: "lib-list-empty-hint", textContent:
        "Scanning ~/.claude and your known projects for skills and agents you can adopt into the library." }),
    );
  }
  if (ctx.autoScanFired && ctx.importCandidateCount > 0) {
    return h("div", { className: "lib-list-empty" },
      h("div", { className: "lib-list-empty-title", textContent: `Found ${ctx.importCandidateCount} on your machine` }),
      h("div", { className: "lib-list-empty-hint", textContent:
        "Skills and agents you already created live at ~/.claude and in project .claude folders. Import them to manage them here." }),
      h("button", {
        className: "lib-primary-btn",
        attrs: { type: "button" },
        textContent: "Import them all",
        on: { click: () => ctx.onScan() },
      }),
    );
  }
  const hint = ctx.isSkills
    ? "Skills bundle instructions Claude loads on demand. Create one, or import what you already have."
    : "Agents are dedicated personalities Claude can hand work to. Create one, or import what you already have.";
  return h("div", { className: "lib-list-empty" },
    h("div", { className: "lib-list-empty-title", textContent: label }),
    h("div", { className: "lib-list-empty-hint", textContent: hint }),
    h("div", { className: "lib-list-empty-actions" },
      h("button", {
        className: "lib-primary-btn",
        attrs: { type: "button" },
        textContent: ctx.isSkills ? "Create a skill" : "Create an agent",
        on: { click: () => ctx.onCreate() },
      }),
      h("button", {
        className: "lib-ghost-btn",
        attrs: { type: "button" },
        textContent: "Scan for existing",
        on: { click: () => ctx.onScan() },
      }),
    ),
  );
};

export interface BulkBarContext {
  readonly selectMode: boolean;
  readonly selectedCount: number;
  readonly allVisibleSelected: boolean;
  readonly someVisibleSelected: boolean;
  onToggleSelectAll(): void;
  onDeleteSelected(): void;
}

export const renderBulkBar = (bulkBar: HTMLElement, ctx: BulkBarContext): void => {
  clear(bulkBar);
  if (!ctx.selectMode) {
    bulkBar.setAttribute("hidden", "true");
    return;
  }
  bulkBar.removeAttribute("hidden");
  const checkboxState = ctx.allVisibleSelected ? "all" : ctx.someVisibleSelected ? "some" : "none";
  const checkbox = h("button", {
    className: `lib-bulk-checkall lib-bulk-state-${checkboxState}`,
    attrs: { type: "button", "aria-label": ctx.allVisibleSelected ? "Deselect all visible" : "Select all visible" },
    on: { click: () => ctx.onToggleSelectAll() },
  });
  const label = h("span", {
    className: "lib-bulk-count",
    textContent: ctx.selectedCount === 0 ? "Select items to delete" : `${ctx.selectedCount} selected`,
  });
  const deleteBtn = h("button", {
    className: "lib-bulk-delete-btn",
    attrs: { type: "button" },
    textContent: `Delete ${ctx.selectedCount > 0 ? ctx.selectedCount : ""}`.trim(),
    on: { click: () => ctx.onDeleteSelected() },
  });
  if (ctx.selectedCount === 0) deleteBtn.setAttribute("disabled", "true");
  bulkBar.appendChild(checkbox);
  bulkBar.appendChild(label);
  bulkBar.appendChild(h("div", { className: "lib-bulk-spacer" }));
  bulkBar.appendChild(deleteBtn);
};
