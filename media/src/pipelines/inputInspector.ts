import { h } from "../ui/h.js";
import type { InputBlock, InputColumnType } from "../../../src/features/pipelines/domain/types";
import { ICON_INPUT, ICON_SLIDERS, ICON_TAG } from "./pipelineIcons.js";
import { INPUT_COLUMN_TYPE_OPTIONS } from "./pipelineCatalog.js";
import {
  bareTextInput,
  boundTextarea,
  dangerRemoveSection,
  identitySection,
  inspectorSection,
  outputVarField,
  refHint,
  selectFromOptions,
} from "./inspectorFields.js";
import type { InspectorHost } from "./pipelineInspectors.js";

export const renderInputInspector = (host: InspectorHost, block: InputBlock): void => {
  const form = h("div", { className: "pl-inspector-form" });
  form.appendChild(identitySection(block.name, "Name", (v) =>
    host.updateBlock(block.id, (b) => ({ ...(b as InputBlock), name: v })),
  ));

  const message = boundTextarea(block.message, "Message shown above the table when the run pauses…", "pl-block-prompt", (v) =>
    host.updateBlock(block.id, (b) => ({ ...(b as InputBlock), message: v })),
  );
  form.appendChild(inspectorSection(ICON_INPUT, "Prompt", h("div", {}, message, refHint())));

  form.appendChild(
    inspectorSection(ICON_SLIDERS, "Columns", inputColumnsEditor(host, block), { meta: String(block.columns.length) }),
  );

  form.appendChild(
    inspectorSection(
      ICON_TAG,
      "Output",
      outputVarField(block.outputVar, (v) =>
        host.updateBlock(block.id, (b) => ({ ...(b as InputBlock), outputVar: v })),
      ),
    ),
  );

  form.appendChild(dangerRemoveSection(() => host.removeBlock(block.id)));
  host.panelBody.appendChild(form);
};

const inputColumnsEditor = (host: InspectorHost, block: InputBlock): HTMLElement => {
  const container = h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } });
  block.columns.forEach((column, index) => {
    const row = h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } });
    row.appendChild(
      h(
        "div",
        { style: { display: "flex", gap: "8px", alignItems: "center" } },
        bareTextInput(column.key, (v) =>
          host.updateBlock(block.id, (b) => ({
            ...(b as InputBlock),
            columns: (b as InputBlock).columns.map((c, i) => (i === index ? { ...c, key: v } : c)),
          })),
        ),
        bareTextInput(column.label, (v) =>
          host.updateBlock(block.id, (b) => ({
            ...(b as InputBlock),
            columns: (b as InputBlock).columns.map((c, i) => (i === index ? { ...c, label: v } : c)),
          })),
        ),
        selectFromOptions(INPUT_COLUMN_TYPE_OPTIONS, column.type, (v) => {
          host.updateBlock(block.id, (b) => ({
            ...(b as InputBlock),
            columns: (b as InputBlock).columns.map((c, i) => (i === index ? { ...c, type: v as InputColumnType } : c)),
          }));
          host.refreshInspectorOnly();
        }),
        h("button", {
          className: "pl-btn ghost",
          attrs: { type: "button", title: "Remove column" },
          textContent: "✕",
          on: {
            click: () => {
              host.updateBlock(block.id, (b) => ({
                ...(b as InputBlock),
                columns: (b as InputBlock).columns.filter((_, i) => i !== index),
              }));
              host.refreshInspectorOnly();
            },
          },
        }),
      ),
    );
    const requiredLabel = h(
      "label",
      { style: { display: "flex", gap: "6px", alignItems: "center", fontSize: "12px", opacity: "0.85" } },
      h("input", {
        attrs: { type: "checkbox", ...(column.required ? { checked: "" } : {}) },
        on: {
          change: (e) =>
            host.updateBlock(block.id, (b) => ({
              ...(b as InputBlock),
              columns: (b as InputBlock).columns.map((c, i) =>
                i === index ? { ...c, required: (e.currentTarget as HTMLInputElement).checked } : c,
              ),
            })),
        },
      }),
      h("span", { textContent: "Required" }),
    );
    row.appendChild(requiredLabel);
    if (column.type === "enum") {
      const opts = h(
        "div",
        { className: "pl-field" },
        h("label", { className: "pl-field-label", textContent: "Dropdown options (comma separated)" }),
        bareTextInput(column.options.join(", "), (v) =>
          host.updateBlock(block.id, (b) => ({
            ...(b as InputBlock),
            columns: (b as InputBlock).columns.map((c, i) =>
              i === index
                ? { ...c, options: v.split(",").map((s) => s.trim()).filter((s) => s.length > 0) }
                : c,
            ),
          })),
        ),
      );
      row.appendChild(opts);
    }
    container.appendChild(row);
  });
  container.appendChild(
    h("button", {
      className: "pl-btn ghost",
      attrs: { type: "button" },
      textContent: "+ Add column",
      on: {
        click: () => {
          host.updateBlock(block.id, (b) => ({
            ...(b as InputBlock),
            columns: [...(b as InputBlock).columns, { key: "", label: "", type: "text", options: [], required: false, help: null }],
          }));
          host.refreshInspectorOnly();
        },
      },
    }),
  );
  return container;
};
