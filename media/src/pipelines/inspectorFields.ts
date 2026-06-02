import { h } from "../ui/h.js";
import { decorateTextarea } from "../ui/textarea.js";
import { EFFORT_OPTIONS } from "../../../src/features/pipelines/domain/thinkingLevels";
import type { EffortLevel } from "../../../src/features/pipelines/domain/types";
import { MODEL_OPTIONS } from "../../../src/shared/models";
import type { ModelChoice } from "../../../src/shared/models";
import { ICON_TAG, ICON_TRASH } from "./pipelineIcons.js";

export const inspectorSection = (
  iconSvg: string,
  title: string,
  body: HTMLElement,
  opts?: { readonly meta?: string; readonly danger?: boolean },
): HTMLElement => {
  const header = h(
    "div",
    { className: "pl-section-header" },
    h("div", { className: "pl-section-icon", innerHTML: iconSvg }),
    h("div", { className: "pl-section-title", textContent: title }),
    opts?.meta ? h("div", { className: "pl-section-meta", textContent: opts.meta }) : null,
  );
  return h(
    "div",
    { className: opts?.danger ? "pl-section danger" : "pl-section" },
    header,
    body,
  );
};

export const bareTextInput = (value: string, onInput: (v: string) => void): HTMLInputElement => {
  const input = h("input", {
    className: "pl-field-input",
    attrs: { type: "text" },
    on: {
      input: (e) => {
        const target = e.currentTarget as HTMLInputElement;
        onInput(target.value);
      },
    },
  });
  input.value = value;
  return input;
};

export const boundTextarea = (
  value: string,
  placeholder: string,
  className: string,
  onInput: (v: string) => void,
): HTMLElement => {
  const { element, textarea } = decorateTextarea({
    className,
    placeholder,
    value,
    mono: true,
    expandTitle: placeholder,
    ariaLabel: placeholder,
  });
  textarea.addEventListener("input", () => onInput(textarea.value));
  return element;
};

export const fieldRestartToggle = (value: boolean, onChange: (v: boolean) => void): HTMLElement => {
  const checkboxId = `pl-restart-${Math.random().toString(36).slice(2, 8)}`;
  const cb = h("input", {
    attrs: { type: "checkbox", id: checkboxId },
    on: {
      change: (e) => {
        const target = e.currentTarget as HTMLInputElement;
        onChange(target.checked);
      },
    },
  }) as HTMLInputElement;
  cb.checked = value;
  return h(
    "div",
    { className: "pl-field" },
    h("label", { className: "pl-field-label", textContent: "Restart each iteration" }),
    h(
      "label",
      { attrs: { for: checkboxId }, style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" } },
      cb,
      h("span", {
        className: "pl-field-hint",
        style: { margin: "0" },
        textContent: value
          ? "On. Each loop iteration starts a FRESH claude session (no memory of prior iterations)."
          : "Off. Each loop iteration RESUMES the prior session (claude remembers prior context).",
      }),
    ),
  );
};

export const identitySection = (
  name: string,
  label: string,
  onChange: (v: string) => void,
): HTMLElement =>
  inspectorSection(
    ICON_TAG,
    "Identity",
    h(
      "div",
      { className: "pl-field" },
      h("label", { className: "pl-field-label", textContent: label }),
      bareTextInput(name, onChange),
    ),
  );

export const outputVarField = (
  value: string | null,
  onChange: (v: string | null) => void,
): HTMLElement =>
  h(
    "div",
    { className: "pl-field" },
    h("label", { className: "pl-field-label", textContent: "Store output in variable (optional)" }),
    bareTextInput(value ?? "", (v) => onChange(v.trim() === "" ? null : v.trim())),
    h("div", {
      className: "pl-field-hint",
      textContent: "Later blocks can reference it as ${vars.NAME}. Leave empty to skip.",
    }),
  );

export const dangerRemoveSection = (onRemove: () => void): HTMLElement =>
  inspectorSection(
    ICON_TRASH,
    "Danger zone",
    h("button", {
      className: "pl-btn danger",
      attrs: { type: "button" },
      textContent: "Remove this block",
      on: { click: onRemove },
    }),
    { danger: true },
  );

export const refHint = (): HTMLElement =>
  h("div", {
    className: "pl-field-hint",
    textContent:
      "References: ${workspace} = run folder · ${vars.NAME} = a stored variable · ${blocks.ID.output} = an earlier block's output.",
  });

export const flatField = (label: string, control: HTMLElement): HTMLElement =>
  h(
    "div",
    { className: "pl-field" },
    h("label", { className: "pl-field-label", textContent: label }),
    control,
  );

export const selectFromOptions = <T extends string>(
  options: readonly { readonly id: T; readonly label: string }[],
  value: T,
  onChange: (v: string) => void,
): HTMLSelectElement => {
  const select = h("select", {
    className: "pl-field-select",
    on: {
      change: (e) => {
        const target = e.currentTarget as HTMLSelectElement;
        onChange(target.value);
      },
    },
  });
  for (const opt of options) {
    select.appendChild(h("option", { attrs: { value: opt.id }, textContent: opt.label }));
  }
  select.value = value;
  return select;
};

export const fieldModel = (value: ModelChoice, onChange: (v: ModelChoice) => void): HTMLElement =>
  h(
    "div",
    { className: "pl-field" },
    h("label", { className: "pl-field-label", textContent: "Model" }),
    selectFromOptions(MODEL_OPTIONS, value, (v) => onChange(v as ModelChoice)),
  );

export const fieldEffort = (value: EffortLevel, onChange: (v: EffortLevel) => void): HTMLElement =>
  h(
    "div",
    { className: "pl-field" },
    h("label", { className: "pl-field-label", textContent: "Effort" }),
    selectFromOptions(EFFORT_OPTIONS, value, (v) => onChange(v as EffortLevel)),
    h("div", { className: "pl-field-hint", textContent: "Controls /effort level: Low → Max. Higher = deeper reasoning, more tokens." }),
  );
