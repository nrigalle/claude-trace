import { h } from "../ui/h.js";
import type { FileBlock, FileOperation, HttpBlock, HttpMethod, Interpreter, ScriptBlock } from "../../../src/features/pipelines/domain/types";
import { ICON_FILE, ICON_FILE_TEXT, ICON_HTTP, ICON_SCRIPT, ICON_SLIDERS, ICON_TAG } from "./pipelineIcons.js";
import { FILE_OP_OPTIONS, HTTP_METHOD_OPTIONS, INTERPRETER_OPTIONS } from "./pipelineCatalog.js";
import {
  boundTextarea,
  bareTextInput,
  dangerRemoveSection,
  identitySection,
  inspectorSection,
  outputVarField,
  refHint,
  selectFromOptions,
} from "./inspectorFields.js";
import type { InspectorHost } from "./pipelineInspectors.js";

export const renderScriptInspector = (host: InspectorHost, block: ScriptBlock): void => {
  const form = h("div", { className: "pl-inspector-form" });
  form.appendChild(identitySection(block.name, "Name", (v) =>
      host.updateBlock(block.id, (b) => ({ ...(b as ScriptBlock), name: v })),
    ));

  form.appendChild(
    inspectorSection(
      ICON_SLIDERS,
      "Interpreter",
      h(
        "div",
        { className: "pl-field" },
        h("label", { className: "pl-field-label", textContent: "Run with" }),
        selectFromOptions(INTERPRETER_OPTIONS, block.interpreter, (v) =>
          host.updateBlock(block.id, (b) => ({ ...(b as ScriptBlock), interpreter: v as Interpreter })),
        ),
      ),
    ),
  );

  const code = boundTextarea(block.code, "echo \"Hello from ${workspace}\"", "pl-block-prompt pl-code", (v) =>
    host.updateBlock(block.id, (b) => ({ ...(b as ScriptBlock), code: v })),
  );
  form.appendChild(inspectorSection(ICON_SCRIPT, "Code", h("div", {}, code, refHint())));

  form.appendChild(
    inspectorSection(
      ICON_TAG,
      "Output",
      outputVarField(block.outputVar, (v) =>
        host.updateBlock(block.id, (b) => ({ ...(b as ScriptBlock), outputVar: v })),
      ),
    ),
  );

  form.appendChild(dangerRemoveSection(() => host.removeBlock(block.id)));
  host.panelBody.appendChild(form);
};

export const renderHttpInspector = (host: InspectorHost, block: HttpBlock): void => {
  const form = h("div", { className: "pl-inspector-form" });
  form.appendChild(identitySection(block.name, "Name", (v) =>
      host.updateBlock(block.id, (b) => ({ ...(b as HttpBlock), name: v })),
    ));

  form.appendChild(
    inspectorSection(
      ICON_HTTP,
      "Request",
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "12px" } },
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "Method" }),
          selectFromOptions(HTTP_METHOD_OPTIONS, block.method, (v) =>
            host.updateBlock(block.id, (b) => ({ ...(b as HttpBlock), method: v as HttpMethod })),
          ),
        ),
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "URL" }),
          bareTextInput(block.url, (v) =>
            host.updateBlock(block.id, (b) => ({ ...(b as HttpBlock), url: v })),
          ),
          refHint(),
        ),
      ),
    ),
  );

  form.appendChild(inspectorSection(ICON_SLIDERS, "Headers", httpHeadersEditor(host, block)));

  const body = boundTextarea(block.body ?? "", "Request body (JSON, form data, …)", "pl-block-prompt", (v) =>
    host.updateBlock(block.id, (b) => ({ ...(b as HttpBlock), body: v === "" ? null : v })),
  );
  form.appendChild(inspectorSection(ICON_FILE_TEXT, "Body", body));

  form.appendChild(
    inspectorSection(
      ICON_TAG,
      "Output",
      outputVarField(block.outputVar, (v) =>
        host.updateBlock(block.id, (b) => ({ ...(b as HttpBlock), outputVar: v })),
      ),
    ),
  );

  form.appendChild(dangerRemoveSection(() => host.removeBlock(block.id)));
  host.panelBody.appendChild(form);
};

const httpHeadersEditor = (host: InspectorHost, block: HttpBlock): HTMLElement => {
  const container = h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } });
  block.headers.forEach((header, index) => {
      container.appendChild(
        h(
          "div",
          { style: { display: "flex", gap: "8px", alignItems: "center" } },
          bareTextInput(header.name, (v) =>
            host.updateBlock(block.id, (b) => ({
                  ...(b as HttpBlock),
                  headers: (b as HttpBlock).headers.map((hd, i) => (i === index ? { ...hd, name: v } : hd)),
                })),
          ),
          bareTextInput(header.value, (v) =>
            host.updateBlock(block.id, (b) => ({
                  ...(b as HttpBlock),
                  headers: (b as HttpBlock).headers.map((hd, i) => (i === index ? { ...hd, value: v } : hd)),
                })),
          ),
          h("button", {
              className: "pl-btn ghost",
              attrs: { type: "button" },
              textContent: "✕",
              on: {
                click: () =>
                host.updateBlock(block.id, (b) => ({
                      ...(b as HttpBlock),
                      headers: (b as HttpBlock).headers.filter((_, i) => i !== index),
                    })),
              },
            }),
        ),
      );
    });
  container.appendChild(
    h("button", {
        className: "pl-btn ghost",
        attrs: { type: "button" },
        textContent: "+ Add header",
        on: {
          click: () =>
          host.updateBlock(block.id, (b) => ({
                ...(b as HttpBlock),
                headers: [...(b as HttpBlock).headers, { name: "", value: "" }],
              })),
        },
      }),
  );
  return container;
};

export const renderFileInspector = (host: InspectorHost, block: FileBlock): void => {
  const form = h("div", { className: "pl-inspector-form" });
  form.appendChild(identitySection(block.name, "Name", (v) =>
      host.updateBlock(block.id, (b) => ({ ...(b as FileBlock), name: v })),
    ));

  form.appendChild(
    inspectorSection(
      ICON_FILE,
      "Operation",
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "12px" } },
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "Operation" }),
          selectFromOptions(FILE_OP_OPTIONS, block.operation, (v) =>
            host.updateBlock(block.id, (b) => ({ ...(b as FileBlock), operation: v as FileOperation })),
          ),
        ),
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "Path (relative to workspace)" }),
          bareTextInput(block.path, (v) =>
            host.updateBlock(block.id, (b) => ({ ...(b as FileBlock), path: v })),
          ),
        ),
      ),
    ),
  );

  if (block.operation === "write") {
    const content = boundTextarea(block.content, "File contents…", "pl-block-prompt", (v) =>
      host.updateBlock(block.id, (b) => ({ ...(b as FileBlock), content: v })),
    );
    form.appendChild(inspectorSection(ICON_FILE_TEXT, "Content", h("div", {}, content, refHint())));
  } else {
    form.appendChild(
      inspectorSection(
        ICON_TAG,
        "Output",
        outputVarField(block.outputVar, (v) =>
          host.updateBlock(block.id, (b) => ({ ...(b as FileBlock), outputVar: v })),
        ),
      ),
    );
  }

  form.appendChild(dangerRemoveSection(() => host.removeBlock(block.id)));
  host.panelBody.appendChild(form);
};
