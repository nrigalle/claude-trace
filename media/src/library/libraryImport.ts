import { h } from "../ui/h.js";
import type { ImportCandidate } from "../../../src/features/library/protocol";

const describeOriginShort = (origin: ImportCandidate["origin"]): string => {
  if (origin === "global") return "~/.claude";
  return origin.label;
};

export const buildImportSheet = (
  candidates: readonly ImportCandidate[],
  onImport: (items: readonly ImportCandidate[]) => void,
  onCancel: () => void,
): HTMLElement => {
  const checks = new Map<string, ImportCandidate>();
  const list = h("ul", { className: "lib-import-list" });
  for (const c of candidates) {
    const key = `${c.kind}:${c.name}:${describeOriginShort(c.origin)}`;
    checks.set(key, c);
    const id = `lib-imp-${key.replace(/[^a-z0-9]/gi, "-")}`;
    const cb = h("input", {
      attrs: { type: "checkbox", id, checked: "" },
      on: {
        change: () => {
          if (cb.checked) checks.set(key, c);
          else checks.delete(key);
        },
      },
    });
    list.appendChild(h("li", { className: "lib-import-item" },
      cb,
      h("label", { attrs: { for: id }, className: "lib-import-label" },
        h("span", { className: "lib-import-kind", textContent: c.kind === "skill" ? "Skill" : "Agent" }),
        h("span", { className: "lib-import-name", textContent: c.name }),
        h("span", { className: "lib-import-origin", textContent: describeOriginShort(c.origin) }),
      ),
    ));
  }
  const cancelBtn = h("button", {
    className: "lib-ghost-btn",
    attrs: { type: "button" },
    textContent: "Cancel",
    on: { click: onCancel },
  });
  const importBtn = h("button", {
    className: "lib-primary-btn",
    attrs: { type: "button" },
    textContent: "Import selected",
    on: { click: () => onImport([...checks.values()]) },
  });
  return h("div", { className: "lib-import-sheet" },
    h("div", { className: "lib-import-head", textContent: `${candidates.length} found in ~/.claude and known projects` }),
    list,
    h("div", { className: "lib-import-foot" }, cancelBtn, importBtn),
  );
};
