import { h } from "../ui/h.js";
import { decorateTextarea } from "../ui/textarea.js";
import type { Frontmatter, FrontmatterValue } from "../../../src/features/library/domain/types";

const KEY_ORDER_SKILL: readonly string[] = [
  "name",
  "description",
  "when_to_use",
  "allowed-tools",
  "argument-hint",
  "model",
  "effort",
  "disable-model-invocation",
  "user-invocable",
];

const KEY_ORDER_AGENT: readonly string[] = [
  "name",
  "description",
  "tools",
  "disallowedTools",
  "model",
  "permissionMode",
  "maxTurns",
  "color",
];

export const renderFrontmatterForm = (
  fm: Frontmatter,
  kind: "skill" | "agent",
  onChange: (next: Frontmatter) => void,
): HTMLElement => {
  const section = h("div", { className: "lib-section" },
    h("div", { className: "lib-section-head", textContent: "Metadata" }),
  );
  const ordered = (kind === "skill" ? KEY_ORDER_SKILL : KEY_ORDER_AGENT);
  const primaryKeys = ["name", "description", kind === "skill" ? "when_to_use" : "tools"];
  const primaryGrid = h("div", { className: "lib-form-grid" });
  for (const key of primaryKeys) {
    primaryGrid.appendChild(renderField(key, fm[key], (v) => onChange({ ...fm, [key]: v })));
  }
  section.appendChild(primaryGrid);

  const others = ordered.filter((k) => !primaryKeys.includes(k));
  const disclosure = h("details", { className: "lib-disclosure" },
    h("summary", { className: "lib-disclosure-summary", textContent: "More options" }),
  );
  const optGrid = h("div", { className: "lib-form-grid" });
  for (const key of others) {
    optGrid.appendChild(renderField(key, fm[key], (v) => onChange({ ...fm, [key]: v })));
  }
  disclosure.appendChild(optGrid);
  section.appendChild(disclosure);
  return section;
};

const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: "Name",
  description: "Description",
  when_to_use: "When to use",
  "allowed-tools": "Allowed tools",
  "argument-hint": "Argument hint",
  model: "Model",
  effort: "Effort",
  "disable-model-invocation": "Manual only",
  "user-invocable": "Show in slash menu",
  tools: "Tools (comma-separated)",
  disallowedTools: "Disallowed tools",
  permissionMode: "Permission mode",
  maxTurns: "Max turns",
  color: "Color",
};

const renderField = (
  key: string,
  current: FrontmatterValue | undefined,
  onChange: (v: FrontmatterValue) => void,
): HTMLElement => {
  const label = FIELD_LABELS[key] ?? key;
  if (key === "description" || key === "when_to_use") {
    const { element, textarea } = decorateTextarea({
      className: "lib-textarea-sm",
      rows: 2,
      value: typeof current === "string" ? current : "",
      expandTitle: label,
      ariaLabel: label,
    });
    textarea.addEventListener("input", () => onChange(textarea.value));
    const wrap = h("label", {
      className: "lib-field lib-field-wide",
      attrs: { "data-field": key },
    },
      h("span", { className: "lib-field-label", textContent: label }),
      element,
    );
    return wrap;
  }
  if (key === "disable-model-invocation" || key === "user-invocable") {
    const cb = h("input", { attrs: { type: "checkbox" }, on: { change: () => onChange(cb.checked) } });
    cb.checked = current === true;
    return h("label", { className: "lib-field lib-field-check" },
      cb,
      h("span", { className: "lib-field-label", textContent: label }),
    );
  }
  const input = h("input", {
    className: "lib-input",
    attrs: { type: "text" },
    on: { input: () => onChange(input.value) },
  });
  input.value = scalarToString(current);
  return h("label", { className: "lib-field" },
    h("span", { className: "lib-field-label", textContent: label }),
    input,
  );
};

export const renderBodyEditor = (
  label: string,
  body: string,
  onChange: (next: string) => void,
): HTMLElement => {
  const { element, textarea } = decorateTextarea({
    className: "lib-textarea-lg",
    rows: 14,
    spellcheck: false,
    mono: true,
    value: body,
    expandTitle: label,
    ariaLabel: label,
  });
  textarea.addEventListener("input", () => onChange(textarea.value));
  return h("div", { className: "lib-section", attrs: { "data-section": "body" } },
    h("div", { className: "lib-section-head", textContent: label }),
    element,
  );
};

const scalarToString = (v: FrontmatterValue | undefined): string => {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.join(", ");
  return Object.entries(v).map(([k, val]) => `${k}: ${val}`).join("\n");
};
