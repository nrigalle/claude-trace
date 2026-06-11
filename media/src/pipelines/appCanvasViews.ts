import { h, clear } from "../ui/h.js";
import type { Pipeline, RunState } from "../../../src/features/pipelines/domain/types";
import type { PipelineCanvas } from "./pipelineCanvas.js";
import type { PipelineToolbar } from "./pipelineToolbar.js";
import { ICON_END, ICON_START } from "./pipelineIcons.js";
import { buildRunBlockState, computeRunSignature, startEndState } from "./pipelineRunState.js";
import { orchStatusFor } from "./pipelineBlockMeta.js";
import { renderRunResults } from "./runsListView.js";

export interface AppViewHost {
  readonly canvasToolbar: HTMLElement;
  readonly canvasEl: HTMLElement;
  readonly canvasArea: HTMLElement;
  readonly panelEl: HTMLElement;
  readonly canvas: PipelineCanvas;
  readonly toolbar: PipelineToolbar;
  assistantElement(): HTMLElement;
  editorSelection(): { draft: Pipeline; view: "editor" | "runs" } | null;
  loopDefineMode(): string | null;
  exitLoopDefineMode(): void;
  renderPipelineRunsList(pipelineId: string): void;
  applyZoom(): void;
  syncAssistant(): void;
  getRenderedRunSignature(): string | null;
  setRenderedRunSignature(sig: string | null): void;
  showNotice(level: "info" | "warning" | "error", message: string): void;
}

export const wirePanelResizer = (host: AppViewHost, handle: HTMLElement): void => {
  const MIN = 280;
  const MAX_PX_FALLBACK = 900;
  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const dx = startX - e.clientX;
    const body = host.panelEl.parentElement;
    const containerW = body ? body.getBoundingClientRect().width : window.innerWidth;
    const asst = host.assistantElement();
    const asstW = asst.classList.contains("hidden") ? 0 : asst.getBoundingClientRect().width;
    const cap = Math.max(MIN, Math.min(MAX_PX_FALLBACK, containerW - asstW - 320));
    const next = Math.max(MIN, Math.min(cap, startWidth + dx));
    host.canvasArea.style.setProperty("--pl-panel-width", `${next}px`);
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.classList.remove("pl-resizing");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };

  handle.addEventListener("mousedown", (e) => {
      dragging = true;
      startX = e.clientX;
      startWidth = host.panelEl.getBoundingClientRect().width;
      handle.classList.add("dragging");
      document.body.classList.add("pl-resizing");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      e.preventDefault();
    });

  handle.addEventListener("dblclick", () => {
      host.canvasArea.style.setProperty("--pl-panel-width", "360px");
    });
};


export const renderEmpty = (host: AppViewHost): void => {
  host.setRenderedRunSignature(null);
  clear(host.canvasToolbar);
  clear(host.canvasEl);
  host.canvas.clearStack();
  host.canvasEl.appendChild(
    h(
      "div",
      { className: "pl-empty" },
      h("div", { className: "pl-empty-title", textContent: "No workflow selected" }),
      h("div", {
          className: "pl-empty-hint",
          textContent:
          "Create a workflow with + New workflow or pick one from the sidebar. Each Worker block becomes an interactive Claude Code session in bypassPermissions mode; the Orchestrator decides when each block is done or needs your input.",
        }),
    ),
  );
  host.syncAssistant();
};


export const renderEditor = (host: AppViewHost): void => {
  const sel = host.editorSelection();
  if (sel === null) return;
  host.setRenderedRunSignature(null);
  const draft = sel.draft;
  const view = sel.view;
  host.toolbar.render(draft, view);
  host.syncAssistant();
  clear(host.canvasEl);

  if (view === "runs") {
    host.renderPipelineRunsList(draft.id);
    host.canvas.clearStack();
    return;
  }

  if (host.loopDefineMode()) {
    const banner = h(
      "div",
      { className: "pl-loop-banner" },
      h("span", {
          textContent: "Pick the block to loop back to. Click any block earlier in the workflow.",
        }),
      h("button", {
          className: "pl-btn",
          attrs: { type: "button" },
          textContent: "Cancel",
          on: { click: () => host.exitLoopDefineMode() },
        }),
    );
    host.canvasEl.appendChild(banner);
  }

  const stack = h("div", { className: "pl-canvas-stack" });
  stack.appendChild(host.canvas.renderStaticNode("start", "Start", "Workflow entry", ICON_START));
  stack.appendChild(host.canvas.renderConnector({ insertIndex: 0 }));

  draft.blocks.forEach((block, index) => {
      if (block.kind === "parallel") {
        stack.appendChild(host.canvas.renderParallelExpanded(block));
      } else if (block.kind === "pool") {
        stack.appendChild(host.canvas.renderPoolExpanded(block));
      } else {
        stack.appendChild(host.canvas.renderBlockRowWithOrch(host.canvas.renderBlockNode(block)));
      }
      stack.appendChild(host.canvas.renderConnector({ insertIndex: index + 1 }));
    });

  stack.appendChild(host.canvas.renderStaticNode("end", "End", "Workflow complete", ICON_END));
  host.canvasEl.appendChild(stack);
  host.canvas.setStack(stack);
  host.applyZoom();
  requestAnimationFrame(() => host.canvas.drawLoopArrows());
};


export const renderRunLoading = (host: AppViewHost): void => {
  host.setRenderedRunSignature(null);
  clear(host.canvasToolbar);
  clear(host.canvasEl);
  host.canvas.clearStack();
  host.canvasEl.appendChild(
    h(
      "div",
      { className: "pl-empty" },
      h("div", { className: "pl-empty-title", textContent: "Loading run…" }),
    ),
  );
};


export const renderRunDetail = (host: AppViewHost, run: RunState): void => {
  host.toolbar.renderRunHeader(run);
  host.syncAssistant();
  const signature = computeRunSignature(run);
  if (signature === host.getRenderedRunSignature() && host.canvas.hasStack()) {
    updateRunResults(host, run);
    host.canvas.updateRunInPlace(run);
    return;
  }
  clear(host.canvasEl);
  updateRunResults(host, run);
  const stack = h("div", { className: "pl-canvas-stack" });
  stack.appendChild(host.canvas.renderStaticNode("start", "Start", "Workflow entry", ICON_START, startEndState(run.status, "start")));
  stack.appendChild(host.canvas.renderConnector(null));

  run.blocks.forEach((blockRun, index) => {
      const definition = run.pipelineSnapshot.blocks[index];
      if (!definition) return;
      const runState = buildRunBlockState(run.runId, blockRun, definition);
      if (definition.kind === "parallel") {
        stack.appendChild(host.canvas.renderParallelExpanded(definition, runState));
      } else if (definition.kind === "pool") {
        stack.appendChild(host.canvas.renderPoolExpanded(definition, runState));
      } else {
        stack.appendChild(
          host.canvas.renderBlockRowWithOrch(
            host.canvas.renderBlockNode(definition, runState),
            orchStatusFor(blockRun.status),
          ),
        );
      }
      stack.appendChild(host.canvas.renderConnector(null));
    });

  stack.appendChild(host.canvas.renderStaticNode("end", "End", "Workflow complete", ICON_END, startEndState(run.status, "end")));
  host.canvasEl.appendChild(stack);
  host.canvas.setStack(stack);
  host.setRenderedRunSignature(signature);
  host.applyZoom();
  requestAnimationFrame(() => host.canvas.drawLoopArrows());
};


export const updateRunResults = (host: AppViewHost, run: RunState): void => {
  const existing = host.canvasEl.querySelector<HTMLElement>(".pl-run-results");
  const next = renderRunResults(run, () => host.showNotice("info", "Results copied to clipboard."));
  if (!next) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.replaceWith(next);
    return;
  }
  host.canvasEl.insertBefore(next, host.canvasEl.firstChild);
};


export const renderCanvasOnly = (host: AppViewHost): void => {
  const sel = host.editorSelection();
  if (sel === null) return;
  const draft = sel.draft;
  clear(host.canvasEl);
  const stack = h("div", { className: "pl-canvas-stack" });
  stack.appendChild(host.canvas.renderStaticNode("start", "Start", "Workflow entry", ICON_START));
  stack.appendChild(host.canvas.renderConnector({ insertIndex: 0 }));
  draft.blocks.forEach((block, index) => {
      if (block.kind === "parallel") {
        stack.appendChild(host.canvas.renderParallelExpanded(block));
      } else if (block.kind === "pool") {
        stack.appendChild(host.canvas.renderPoolExpanded(block));
      } else {
        stack.appendChild(host.canvas.renderBlockRowWithOrch(host.canvas.renderBlockNode(block)));
      }
      stack.appendChild(host.canvas.renderConnector({ insertIndex: index + 1 }));
    });
  stack.appendChild(host.canvas.renderStaticNode("end", "End", "Workflow complete", ICON_END));
  host.canvasEl.appendChild(stack);
  host.canvas.setStack(stack);
  host.applyZoom();
  requestAnimationFrame(() => host.canvas.drawLoopArrows());
};
