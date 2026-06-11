import { clear } from "../ui/h.js";
import type {
  AgentItem,
  LibrarySnapshot,
  ProjectPath,
  Scope,
  SkillItem,
} from "../../../src/features/library/domain/types";
import { descriptionOf } from "./libraryHelpers.js";

export type ProjectFilter =
  | { readonly kind: "all" }
  | { readonly kind: "global" }
  | { readonly kind: "unassigned" }
  | { readonly kind: "project"; readonly path: ProjectPath };

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


export const filteredSkills = (snapshot: LibrarySnapshot, projectFilter: ProjectFilter, query: string): readonly SkillItem[] => {
  return snapshot.skills.filter((s) =>
    scopeMatches(projectFilter, s.scope) &&
    (query === "" || matchesQuery(query, [s.name as string, descriptionOf(s.frontmatter), s.body])),
  );
};

export const filteredAgents = (snapshot: LibrarySnapshot, projectFilter: ProjectFilter, query: string): readonly AgentItem[] => {
  return snapshot.agents.filter((a) =>
    scopeMatches(projectFilter, a.scope) &&
    (query === "" || matchesQuery(query, [a.name as string, descriptionOf(a.frontmatter), a.body])),
  );
};

export const rebuildFilterOptions = (select: HTMLSelectElement, snapshot: LibrarySnapshot, projectFilter: ProjectFilter): void => {
  const current = select.value;
  clear(select);
  select.appendChild(makeOption("all", "All"));
  select.appendChild(makeOption("global", "Global (~/.claude)"));
  select.appendChild(makeOption("unassigned", "Unassigned"));
  if (snapshot.projects.length > 0) {
    const group = document.createElement("optgroup");
    group.label = "Projects";
    for (const p of snapshot.projects) {
      const o = makeOption(`project:${p.path as string}`, p.label);
      o.title = p.path as string;
      group.appendChild(o);
    }
    select.appendChild(group);
  }
  const desired = filterToOptionValue(projectFilter);
  if (current && [...select.options].some((o) => o.value === desired)) {
    select.value = desired;
  } else {
    select.value = "all";
  }
};

export const reconcileFilter = (snapshot: LibrarySnapshot, projectFilter: ProjectFilter): ProjectFilter => {
  if (projectFilter.kind !== "project") return projectFilter;
  const stillExists = snapshot.projects.some(
    (p) => (p.path as string) === projectFilter.path as string,
  );
  return stillExists ? projectFilter : { kind: "all" };
};

export const filterFromOptionValue = (v: string, current: ProjectFilter): ProjectFilter => {
  if (v === "all") return { kind: "all" };
  if (v === "global") return { kind: "global" };
  if (v === "unassigned") return { kind: "unassigned" };
  if (v.startsWith("project:")) return { kind: "project", path: v.slice("project:".length) as ProjectPath };
  return current;
};
