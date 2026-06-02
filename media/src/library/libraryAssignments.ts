import { h } from "../ui/h.js";
import {
  toProjectPath,
  toSkillName,
  type ProjectEntry,
  type ProjectPath,
  type Scope,
  type SkillItem,
  type SkillName,
} from "../../../src/features/library/domain/types";
import { sourceLabel } from "./libraryHelpers.js";

export const renderAttachedSkillsPicker = (
  skills: readonly SkillItem[],
  attached: readonly SkillName[],
  onChange: (next: readonly SkillName[]) => void,
): HTMLElement => {
  const section = h("div", { className: "lib-section" },
    h("div", { className: "lib-section-head", textContent: "Attached skills" }),
    h("div", { className: "lib-section-sub", textContent:
      "Claude preloads each attached skill into this agent's context at startup. Edit a skill once, every agent using it sees the change." }),
  );
  if (skills.length === 0) {
    section.appendChild(h("div", { className: "lib-hint", textContent: "Create a skill first to attach it here." }));
    return section;
  }
  const chips = h("div", { className: "lib-chip-grid" });
  const selected = new Set(attached as readonly string[]);
  for (const skill of skills) {
    const isOn = selected.has(skill.name as string);
    const chip = h("button", {
      className: `lib-chip${isOn ? " on" : ""}`,
      attrs: { type: "button" },
      textContent: skill.name as string,
      on: {
        click: () => {
          const next = new Set(selected);
          if (isOn) next.delete(skill.name as string);
          else next.add(skill.name as string);
          onChange(Array.from(next).map(toSkillName));
          chip.classList.toggle("on", !isOn);
          if (isOn) selected.delete(skill.name as string);
          else selected.add(skill.name as string);
        },
      },
    });
    chips.appendChild(chip);
  }
  section.appendChild(chips);
  return section;
};

export const renderAssignmentsPanel = (
  scope: Scope,
  projects: readonly ProjectEntry[],
  onChange: (next: Scope) => void,
  onAddProject: () => void,
): HTMLElement => {
  const section = h("div", { className: "lib-section" },
    h("div", { className: "lib-section-head", textContent: "Where this is available" }),
    h("div", { className: "lib-section-sub", textContent:
      "Pick global to make it available everywhere, or specific projects to scope it. Trace writes real files into each target and tracks everything it touches." }),
  );

  const scopeRow = h("div", { className: "lib-scope-row" });
  const radio = (label: string, value: Scope["kind"], description: string): HTMLElement => {
    const id = `lib-scope-${value}-${Math.random().toString(36).slice(2, 8)}`;
    const input = h("input", {
      attrs: {
        type: "radio",
        id,
        name: "lib-scope",
        ...(scope.kind === value ? { checked: "" } : {}),
      },
      on: {
        change: () => {
          if (value === "global") onChange({ kind: "global" });
          else if (value === "unassigned") onChange({ kind: "unassigned" });
          else onChange({ kind: "projects", paths: scope.kind === "projects" ? scope.paths : [] });
        },
      },
    });
    return h("label", { className: "lib-scope-opt", attrs: { for: id } },
      input,
      h("div", { className: "lib-scope-opt-text" },
        h("div", { className: "lib-scope-opt-title", textContent: label }),
        h("div", { className: "lib-scope-opt-desc", textContent: description }),
      ),
    );
  };
  scopeRow.appendChild(radio("Unassigned", "unassigned", "Stays in the library, not written anywhere."));
  scopeRow.appendChild(radio("Global", "global", "Goes to ~/.claude. Available in every Claude session."));
  scopeRow.appendChild(radio("Specific projects", "projects", "Goes only to the projects you pick below."));
  section.appendChild(scopeRow);

  if (scope.kind === "projects") {
    section.appendChild(renderProjectChecklist(scope.paths, projects, (paths) => onChange({ kind: "projects", paths }), onAddProject));
  }
  return section;
};

const renderProjectChecklist = (
  selected: readonly ProjectPath[],
  projects: readonly ProjectEntry[],
  onChange: (paths: readonly ProjectPath[]) => void,
  onAddProject: () => void,
): HTMLElement => {
  const wrap = h("div", { className: "lib-project-list" });
  const selectedSet = new Set(selected as readonly string[]);
  if (projects.length === 0) {
    wrap.appendChild(h("div", { className: "lib-hint", textContent:
      "No projects detected yet. Open a workspace folder in VS Code or add one manually below." }));
  }
  for (const p of projects) {
    const id = `lib-proj-${(p.path as string).replace(/[^a-z0-9]/gi, "-")}`;
    const isOn = selectedSet.has(p.path as string);
    const cb = h("input", {
      attrs: {
        type: "checkbox",
        id,
        ...(isOn ? { checked: "" } : {}),
      },
      on: {
        change: () => {
          if (cb.checked) selectedSet.add(p.path as string);
          else selectedSet.delete(p.path as string);
          onChange(Array.from(selectedSet).map(toProjectPath));
        },
      },
    });
    const row = h("label", { className: "lib-project-row", attrs: { for: id } },
      cb,
      h("div", { className: "lib-project-text" },
        h("div", { className: "lib-project-label", textContent: p.label }),
        h("div", { className: "lib-project-path", textContent: p.path as string }),
      ),
      h("span", { className: `lib-source-pill source-${p.source}`, textContent: sourceLabel(p.source) }),
    );
    wrap.appendChild(row);
  }
  const addBtn = h("button", {
    className: "lib-ghost-btn lib-add-project-btn",
    attrs: { type: "button" },
    textContent: "Add a project folder",
    on: { click: onAddProject },
  });
  wrap.appendChild(addBtn);
  return wrap;
};
