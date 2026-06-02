import { h } from "../ui/h.js";
import type { SkillItem } from "../../../src/features/library/domain/types";
import { prettyBytes } from "./libraryHelpers.js";

export const renderEmptyHelp = (): HTMLElement =>
  h("div", { className: "lib-empty" },
    h("div", { className: "lib-empty-art" }),
    h("div", { className: "lib-empty-title", textContent: "Your library, in one place" }),
    h("div", { className: "lib-empty-sub", innerHTML:
      "Skills give Claude a focused playbook. Agents are dedicated personalities for specific work." +
      " Edit once here, push to every project that needs it." }),
  );

export const renderResourceList = (skill: SkillItem): HTMLElement => {
  const section = h("div", { className: "lib-section" },
    h("div", { className: "lib-section-head", textContent: "Bundled resources" }),
  );
  if (skill.resources.length === 0) {
    section.appendChild(h("div", { className: "lib-hint", textContent:
      "Drop scripts, references, or assets into the skill's folder. Claude reads them on demand." }));
    return section;
  }
  const list = h("ul", { className: "lib-resource-list" });
  for (const r of skill.resources) {
    list.appendChild(h("li", { className: "lib-resource-item" },
      h("span", { className: "lib-mono", textContent: r.relativePath }),
      h("span", { className: "lib-resource-size", textContent: prettyBytes(r.bytes) }),
    ));
  }
  section.appendChild(list);
  return section;
};

export const renderSkillHotReloadHint = (): HTMLElement =>
  h("div", { className: "lib-inline-tip lib-inline-tip-info", textContent:
    "Skills hot-reload. Edits become active in any running Claude session next time the skill is invoked." });

export const renderAgentHotReloadWarning = (): HTMLElement =>
  h("div", { className: "lib-inline-tip lib-inline-tip-warn", textContent:
    "Agent edits do not hot-reload. Restart sessions, or run /agents in Claude to pick up changes immediately." });

export interface EditorTabsContext {
  readonly editorTab: "edit" | "assignments";
  readonly assistantOpen: boolean;
  onTab(tab: "edit" | "assignments"): void;
  onSave(): void;
  onRename(): void;
  onDelete(): void;
  onAssist(): void;
}

export const renderEditorTabs = (title: string, ctx: EditorTabsContext): HTMLElement => {
  const editBtn = h("button", {
    className: `lib-editor-tab${ctx.editorTab === "edit" ? " active" : ""}`,
    attrs: { type: "button" },
    textContent: "Edit",
    on: { click: () => ctx.onTab("edit") },
  });
  const assignBtn = h("button", {
    className: `lib-editor-tab${ctx.editorTab === "assignments" ? " active" : ""}`,
    attrs: { type: "button" },
    textContent: "Assignments",
    on: { click: () => ctx.onTab("assignments") },
  });
  const saveBtn = h("button", {
    className: "lib-primary-btn lib-save-btn",
    attrs: { type: "button", disabled: "true" },
    textContent: "Save",
    on: { click: () => ctx.onSave() },
  });
  const renameBtn = h("button", {
    className: "lib-ghost-btn",
    attrs: { type: "button" },
    textContent: "Rename",
    on: { click: () => ctx.onRename() },
  });
  const deleteBtn = h("button", {
    className: "lib-danger-btn",
    attrs: { type: "button" },
    textContent: "Delete",
    on: { click: () => ctx.onDelete() },
  });
  const assistBtn = h("button", {
    className: `lib-assist-btn${ctx.assistantOpen ? " active" : ""}`,
    attrs: { type: "button", title: "Chat with Claude to draft this body" },
    textContent: "Help me write",
    on: { click: () => ctx.onAssist() },
  });
  return h("div", { className: "lib-editor-head" },
    h("div", { className: "lib-editor-title", textContent: title }),
    h("div", { className: "lib-editor-tabs", attrs: { role: "tablist" } }, editBtn, assignBtn),
    h("div", { className: "lib-editor-actions" }, assistBtn, renameBtn, deleteBtn, saveBtn),
  );
};
