import { h } from "../ui/h.js";
import { EFFORT_OPTIONS } from "../../../src/features/pipelines/domain/thinkingLevels";
import { MODEL_OPTIONS } from "../../../src/shared/models";
import type { ModelChoice } from "../../../src/shared/models";
import type { EffortLevel, ParallelBlock, WorkerBlock } from "../../../src/features/pipelines/domain/types";
import { ICON_PLUS } from "./pipelineIcons.js";
import { boundTextarea, flatField, selectFromOptions } from "./inspectorFields.js";
import type { InspectorHost } from "./pipelineInspectors.js";

export const renderParallelWorkers = (host: InspectorHost, block: ParallelBlock): HTMLElement => {
    const body = h("div", { className: "pl-tabs-pane" });

    if (block.workers.length === 0) {
      body.appendChild(
        h("div", {
          className: "pl-field-hint",
          style: { padding: "12px 0" },
          textContent: "No parallel workers yet. Click + to add the first one.",
        }),
      );
      body.appendChild(renderAddWorkerButton(host, block.id));
      return body;
    }

    const activeId = getActiveParallelWorker(host, block);
    const activeWorker = block.workers.find((w) => w.id === activeId) ?? block.workers[0]!;

    const tabStrip = h("div", { className: "pl-tabs-strip" });
    block.workers.forEach((worker, idx) => {
      const isActive = worker.id === activeWorker.id;
      tabStrip.appendChild(
        h("button", {
          className: `pl-tab${isActive ? " active" : ""}`,
          attrs: { type: "button", title: worker.name || `Worker ${idx + 1}` },
          textContent: worker.name || `Worker ${idx + 1}`,
          on: {
            click: () => {
              host.activeParallelWorker.set(block.id, worker.id);
              host.refreshInspectorOnly();
            },
          },
        }),
      );
    });
    tabStrip.appendChild(
      h("button", {
        className: "pl-tab-add",
        attrs: { type: "button", title: "Add parallel worker", "aria-label": "Add parallel worker" },
        innerHTML: ICON_PLUS,
        on: { click: () => host.addParallelWorker(block.id) },
      }),
    );

    body.appendChild(tabStrip);
    body.appendChild(renderActiveParallelWorker(host, block, activeWorker));

    return body;
  }

const renderActiveParallelWorker = (host: InspectorHost, parent: ParallelBlock, worker: WorkerBlock): HTMLElement => {
    const editor = h("div", { className: "pl-tab-editor" });

    const nameInput = h("input", {
      className: "pl-field-input",
      attrs: { type: "text", placeholder: "Worker name" },
      on: {
        input: (e) => {
          const target = e.currentTarget as HTMLInputElement;
          host.updateParallelWorker(parent.id, worker.id, { name: target.value });
        },
      },
    });
    nameInput.value = worker.name;
    editor.appendChild(flatField("Name", nameInput));

    const promptInput = boundTextarea(
      worker.prompt,
      "Prompt sent to this Claude session…",
      "pl-block-prompt",
      (v) => host.updateParallelWorker(parent.id, worker.id, { prompt: v }),
    );
    editor.appendChild(flatField("Prompt", promptInput));

    const modelSelect = selectFromOptions(MODEL_OPTIONS, worker.model, (v) =>
      host.updateParallelWorker(parent.id, worker.id, { model: v as ModelChoice }),
    );
    const effortSelect = selectFromOptions(EFFORT_OPTIONS, worker.effort, (v) =>
      host.updateParallelWorker(parent.id, worker.id, { effort: v as EffortLevel }),
    );
    editor.appendChild(
      h(
        "div",
        { className: "pl-flat-row" },
        flatField("Model", modelSelect),
        flatField("Effort", effortSelect),
      ),
    );

    editor.appendChild(
      h(
        "div",
        { style: { display: "flex", justifyContent: "flex-end", marginTop: "4px" } },
        h("button", {
          className: "pl-btn danger",
          attrs: { type: "button" },
          textContent: "Remove this worker",
          on: { click: () => host.removeParallelWorker(parent.id, worker.id) },
        }),
      ),
    );

    return editor;
  }

const renderAddWorkerButton = (host: InspectorHost, blockId: string): HTMLElement => {
    return h("button", {
      className: "pl-add-row",
      attrs: { type: "button" },
      textContent: "+ Add parallel worker",
      on: { click: () => host.addParallelWorker(blockId) },
    });
  }

const getActiveParallelWorker = (host: InspectorHost, block: ParallelBlock): string => {
    const stored = host.activeParallelWorker.get(block.id);
    if (stored && block.workers.some((w) => w.id === stored)) return stored;
    return block.workers[0]?.id ?? "";
  }
