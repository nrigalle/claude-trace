import { h } from "../ui/h.js";
import type {
  Frontmatter,
  ProjectEntry,
  Scope,
} from "../../../src/features/library/domain/types";

export const descriptionOf = (fm: Frontmatter): string => {
  const v = fm["description"];
  return typeof v === "string" ? v : "";
};

export const renderScopeChip = (scope: Scope, projects: readonly ProjectEntry[]): HTMLElement => {
  if (scope.kind === "global") {
    return h("span", { className: "lib-chip-pill lib-chip-pill-global", textContent: "Global" });
  }
  if (scope.kind === "projects") {
    const n = scope.paths.length;
    if (n === 0) return h("span", { className: "lib-chip-pill lib-chip-pill-unassigned", textContent: "0 projects" });
    if (n === 1) {
      const match = projects.find((p) => (p.path as string) === (scope.paths[0] as string));
      const label = match ? match.label : "1 project";
      return h("span", { className: "lib-chip-pill lib-chip-pill-project", textContent: label });
    }
    return h("span", { className: "lib-chip-pill lib-chip-pill-project", textContent: `${n} projects` });
  }
  return h("span", { className: "lib-chip-pill lib-chip-pill-unassigned", textContent: "Unassigned" });
};

export const sourceLabel = (s: ProjectEntry["source"]): string => {
  if (s === "workspace") return "workspace";
  if (s === "tracked") return "tracked";
  return "added";
};

export const prettyBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

export const normalizeName = (raw: string): string =>
  raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
