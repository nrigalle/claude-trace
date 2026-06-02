import { h, clear } from "../ui/h.js";
import { SidebarResizer } from "../ui/layout/SidebarResizer.js";
import { SIDEBAR_DEFAULT_PX } from "../ui/layout/sidebarWidth.js";
import type {
  Block,
  BlockKind,
  LoopBlock,
  ParallelBlock,
  Pipeline,
  PipelineId,
  RunId,
  RunState,
  Trigger,
  WorkerBlock,
} from "../../../src/features/pipelines/domain/types";
import { toBlockId } from "../../../src/features/pipelines/domain/types";
import { assertNeverPipelines } from "../../../src/features/pipelines/protocol";
import type {
  PipelinesHostToWebview,
  PipelinesWebviewToHost,
  RunSummary,
} from "../../../src/features/pipelines/protocol";
import {
  ICON_END,
  ICON_HTTP,
  ICON_PLAY,
  ICON_PLUS,
  ICON_START,
  ICON_WAIT,
  ICON_ZAP,
} from "./pipelineIcons.js";
import {
  LIBRARY,
} from "./pipelineCatalog.js";
import {
  buildRunBlockState,
  computeRunSignature,
  startEndState,
} from "./pipelineRunState.js";
import { createBlock, defaultWorker, makeId, orchStatusFor } from "./pipelineBlockMeta.js";
import {
  bareTextInput,
  inspectorSection,
} from "./inspectorFields.js";
import { PipelineInspectors } from "./pipelineInspectors.js";
import { RunDetailPanel } from "./runDetailPanel.js";
import { PipelineCanvas } from "./pipelineCanvas.js";
import { PipelineSidebar } from "./pipelineSidebar.js";
import { PipelineToolbar } from "./pipelineToolbar.js";

export interface PipelinesAppDeps {
  send(msg: PipelinesWebviewToHost): void;
}

type PipelineView = "editor" | "runs";
type Selection =
  | { kind: "none" }
  | { kind: "pipeline"; draft: Pipeline; dirty: boolean; view?: PipelineView }
  | { kind: "run"; runId: RunId; latest: RunState | null };

type PanelMode =
  | { kind: "none" }
  | { kind: "library"; insertAtIndex: number }
  | { kind: "inspector"; blockId: string }
  | { kind: "run-block-detail"; blockId: string }
  | { kind: "triggers" };

const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;

export class PipelinesApp {
  private readonly root: HTMLElement;
  private readonly sidebarListEl: HTMLElement;
  private readonly canvasArea: HTMLElement;
  private readonly canvasToolbar: HTMLElement;
  private readonly canvasEl: HTMLElement;
  private readonly panelEl: HTMLElement;
  private readonly panelHeader: HTMLElement;
  private readonly panelBody: HTMLElement;
  private readonly zoomReadout: HTMLElement;

  private pipelines: readonly Pipeline[] = [];
  private runs: readonly RunSummary[] = [];
  private selection: Selection = { kind: "none" };
  private panel: PanelMode = { kind: "none" };
  private zoom = 1;
  private loopDefineMode: string | null = null;
  private readonly activeParallelWorker = new Map<string, string>();
  private renderedRunSignature: string | null = null;
  private readonly inspectors: PipelineInspectors;
  private readonly runDetail: RunDetailPanel;
  private readonly canvas: PipelineCanvas;
  private readonly sidebar: PipelineSidebar;
  private readonly toolbar: PipelineToolbar;

  constructor(private readonly deps: PipelinesAppDeps) {
    this.sidebarListEl = h("div", { className: "pl-sidebar-list" });

    const sidebarHeader = h(
      "div",
      { className: "sidebar-header" },
      h(
        "div",
        { className: "brand" },
        h("div", { className: "brand-icon", innerHTML: ICON_ZAP }),
        h("span", { className: "brand-title", textContent: "Claude Trace" }),
      ),
    );

    const newWorkflowBtn = h(
      "button",
      {
        className: "start-session-btn",
        attrs: { type: "button", "aria-label": "Create a new workflow" },
        on: { click: () => this.deps.send({ type: "createPipeline" }) },
      },
      h("span", { innerHTML: ICON_PLUS, style: { display: "inline-flex", width: "14px", height: "14px" } }),
      h("span", { textContent: "New workflow" }),
    );

    const sidebar = h(
      "aside",
      { className: "pl-sidebar" },
      sidebarHeader,
      newWorkflowBtn,
      h("div", { className: "pl-sidebar-section-title", textContent: "Workflows" }),
      this.sidebarListEl,
    );

    this.canvasToolbar = h("div", { className: "pl-canvas-toolbar" });
    this.canvasEl = h("div", { className: "pl-canvas" });

    this.panelHeader = h("div", { className: "pl-panel-header" });
    this.panelBody = h("div", { className: "pl-panel-body" });
    const panelResizer = h("div", {
      className: "pl-panel-resizer",
      attrs: { role: "separator", "aria-orientation": "vertical", "aria-label": "Resize panel" },
    });
    this.panelEl = h("aside", { className: "pl-panel" }, panelResizer, this.panelHeader, this.panelBody);
    this.wirePanelResizer(panelResizer);

    this.zoomReadout = h("span", { className: "pl-zoom-readout", textContent: "100%" });
    const zoomControls = h(
      "div",
      { className: "pl-zoom-controls" },
      h("button", {
        className: "pl-zoom-btn",
        attrs: { type: "button", title: "Zoom out" },
        textContent: "−",
        on: { click: () => this.setZoom(this.zoom - ZOOM_STEP) },
      }),
      this.zoomReadout,
      h("button", {
        className: "pl-zoom-btn",
        attrs: { type: "button", title: "Zoom in" },
        textContent: "+",
        on: { click: () => this.setZoom(this.zoom + ZOOM_STEP) },
      }),
      h("button", {
        className: "pl-zoom-btn",
        attrs: { type: "button", title: "Reset zoom" },
        textContent: "⊙",
        on: { click: () => this.setZoom(1) },
      }),
    );
    const zoomHost = h("div", { className: "pl-zoom-controls-host" }, zoomControls);

    const canvasBody = h(
      "div",
      { className: "pl-canvas-body" },
      this.canvasEl,
      zoomHost,
      this.panelEl,
    );

    this.canvasArea = h(
      "div",
      { className: "pl-canvas-area" },
      this.canvasToolbar,
      canvasBody,
    );

    this.root = h("div", { className: "pl-shell" }, sidebar, this.canvasArea);
    const sidebarResizer = new SidebarResizer({
      target: this.root,
      initialPx: SIDEBAR_DEFAULT_PX,
      onCommitPx: () => {},
    });
    sidebar.appendChild(sidebarResizer.element);
    this.inspectors = new PipelineInspectors({
      panelBody: this.panelBody,
      activeParallelWorker: this.activeParallelWorker,
      getDraftBlocks: () => (this.selection.kind === "pipeline" ? this.selection.draft.blocks : []),
      findBlockName: (blockId) => this.findBlockName(blockId),
      updateBlock: (blockId, fn) => this.updateBlock(blockId, fn),
      removeBlock: (blockId) => this.removeBlock(blockId),
      updateParallelWorker: (blockId, workerId, patch) => this.updateParallelWorker(blockId, workerId, patch),
      addParallelWorker: (blockId) => this.addParallelWorker(blockId),
      removeParallelWorker: (blockId, workerId) => this.removeParallelWorker(blockId, workerId),
      refreshInspectorOnly: () => this.refreshInspectorOnly(),
      enterLoopDefineMode: (loopBlockId) => this.enterLoopDefineMode(loopBlockId),
    });
    this.runDetail = new RunDetailPanel({
      panelHeader: this.panelHeader,
      panelBody: this.panelBody,
      getRun: () => (this.selection.kind === "run" ? this.selection.latest : null),
      clearPanel: () => {
        this.panel = { kind: "none" };
        this.canvasArea.classList.remove("panel-open");
      },
      showNotice: (level, message) => this.showNotice(level, message),
      send: (msg) => this.deps.send(msg),
    });
    this.canvas = new PipelineCanvas({
      getZoom: () => this.zoom,
      getLoopDefineMode: () => this.loopDefineMode,
      getBlocksForArrows: () =>
        this.selection.kind === "pipeline"
          ? this.selection.draft.blocks
          : this.selection.kind === "run" && this.selection.latest
            ? this.selection.latest.pipelineSnapshot.blocks
            : [],
      isBlockSelected: (blockId) =>
        (this.panel.kind === "inspector" || this.panel.kind === "run-block-detail") &&
        this.panel.blockId === blockId,
      isLibraryInsertActive: (index) =>
        this.panel.kind === "library" && this.panel.insertAtIndex === index,
      isLoopAnchorCandidate: (blockId) => this.isLoopAnchorCandidate(blockId),
      pickLoopTarget: (blockId) => this.pickLoopTarget(blockId),
      openInspector: (blockId) => this.openInspector(blockId),
      openRunBlockDetail: (blockId) => this.openRunBlockDetail(blockId),
      openLibraryAt: (index) => this.openLibraryAt(index),
      findBlockName: (blockId) => this.findBlockName(blockId),
      addParallelWorker: (blockId) => this.addParallelWorker(blockId),
      removeParallelWorker: (blockId, workerId) => this.removeParallelWorker(blockId, workerId),
      removeBlock: (blockId) => this.removeBlock(blockId),
      send: (msg) => this.deps.send(msg),
    });
    this.sidebar = new PipelineSidebar(this.sidebarListEl, {
      getPipelines: () => this.pipelines,
      getRuns: () => this.runs,
      getSelectedPipelineId: () => (this.selection.kind === "pipeline" ? this.selection.draft.id : null),
      loadPipeline: (pipelineId) => this.deps.send({ type: "loadPipeline", pipelineId }),
      deleteRun: (runId) => this.deps.send({ type: "deleteRun", runId }),
      selectRun: (runId) => this.handleSelectRun(runId),
    });
    this.toolbar = new PipelineToolbar({
      canvasToolbar: this.canvasToolbar,
      getRuns: () => this.runs,
      getPipelines: () => this.pipelines,
      updateDraft: (patch) => this.updateDraft(patch),
      setPipelineView: (view) => this.setPipelineView(view),
      openTriggers: () => this.openTriggers(),
      handleSave: () => this.handleSave(),
      handleRun: () => this.handleRun(),
      handleDelete: () => this.handleDelete(),
      killRun: (runId) => this.deps.send({ type: "killRun", runId }),
      resumeRun: (runId) => this.deps.send({ type: "resumeRun", runId }),
      navigateToPipeline: (draft, view) => {
        this.selection = { kind: "pipeline", draft, dirty: false, view };
        this.panel = { kind: "none" };
        this.sidebar.render();
        this.renderEditor();
        this.renderPanel();
      },
    });
    this.renderEmpty();
    this.renderPanel();
  }

  element(): HTMLElement {
    return this.root;
  }

  receive(msg: PipelinesHostToWebview): void {
    switch (msg.type) {
      case "pipelinesList":
        this.pipelines = msg.payload.pipelines;
        this.runs = msg.payload.runs;
        if (this.selection.kind === "pipeline") {
          const selectedId = this.selection.draft.id;
          const stillExists = this.pipelines.some((p) => p.id === selectedId);
          if (!stillExists) {
            this.selection = { kind: "none" };
            this.panel = { kind: "none" };
            this.renderEmpty();
            this.renderPanel();
          } else {
            this.renderEditor();
          }
        } else if (this.selection.kind === "run") {
          const currentRunId = this.selection.runId;
          const stillExists = this.runs.some((r) => r.runId === currentRunId);
          if (!stillExists) {
            this.selection = { kind: "none" };
            this.panel = { kind: "none" };
            this.renderEmpty();
            this.renderPanel();
          }
        }
        this.sidebar.render();
        return;
      case "pipelineDetail":
        this.selection = { kind: "pipeline", draft: msg.pipeline, dirty: false };
        this.panel = { kind: "none" };
        this.sidebar.render();
        this.renderEditor();
        this.renderPanel();
        return;
      case "runUpdate":
        if (this.selection.kind === "run" && this.selection.runId === msg.run.runId) {
          this.selection = { kind: "run", runId: msg.run.runId, latest: msg.run };
          this.renderRunDetail(msg.run);
        }
        this.sidebar.render();
        return;
      case "validationFailed":
        this.showNotice("error", msg.errors.map((e) => `• ${e.message}`).join("\n"));
        return;
      case "notice":
        this.showNotice(msg.level, msg.message);
        return;
      default:
        assertNeverPipelines(msg);
    }
  }

  private wirePanelResizer(handle: HTMLElement): void {
    const MIN = 280;
    const MAX_PX_FALLBACK = 900;
    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const dx = startX - e.clientX;
      const cap = Math.min(MAX_PX_FALLBACK, Math.floor(window.innerWidth * 0.8));
      const next = Math.max(MIN, Math.min(cap, startWidth + dx));
      this.canvasArea.style.setProperty("--pl-panel-width", `${next}px`);
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
      startWidth = this.panelEl.getBoundingClientRect().width;
      handle.classList.add("dragging");
      document.body.classList.add("pl-resizing");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      e.preventDefault();
    });

    handle.addEventListener("dblclick", () => {
      this.canvasArea.style.setProperty("--pl-panel-width", "360px");
    });
  }

  private setZoom(next: number): void {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(next * 100) / 100));
    if (clamped === this.zoom) return;
    this.zoom = clamped;
    this.applyZoom();
  }

  private applyZoom(): void {
    this.canvas.applyZoom(this.zoom);
    this.zoomReadout.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  private renderEmpty(): void {
    clear(this.canvasToolbar);
    clear(this.canvasEl);
    this.canvas.clearStack();
    this.canvasEl.appendChild(
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
  }

  private renderEditor(): void {
    if (this.selection.kind !== "pipeline") return;
    const draft = this.selection.draft;
    const view = this.selection.view ?? "editor";
    this.toolbar.render(draft, view);
    clear(this.canvasEl);

    if (view === "runs") {
      this.renderPipelineRunsList(draft.id);
      this.canvas.clearStack();
      return;
    }

    if (this.loopDefineMode) {
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
          on: { click: () => this.exitLoopDefineMode() },
        }),
      );
      this.canvasEl.appendChild(banner);
    }

    const stack = h("div", { className: "pl-canvas-stack" });
    stack.appendChild(this.canvas.renderStaticNode("start", "Start", "Workflow entry", ICON_START));
    stack.appendChild(this.canvas.renderConnector({ insertIndex: 0 }));

    draft.blocks.forEach((block, index) => {
      if (block.kind === "parallel") {
        stack.appendChild(this.canvas.renderParallelExpanded(block));
      } else {
        stack.appendChild(this.canvas.renderBlockRowWithOrch(this.canvas.renderBlockNode(block)));
      }
      stack.appendChild(this.canvas.renderConnector({ insertIndex: index + 1 }));
    });

    stack.appendChild(this.canvas.renderStaticNode("end", "End", "Workflow complete", ICON_END));
    this.canvasEl.appendChild(stack);
    this.canvas.setStack(stack);
    this.applyZoom();
    requestAnimationFrame(() => this.canvas.drawLoopArrows());
  }

  private renderPipelineRunsList(pipelineId: PipelineId): void {
    const pipelineRuns = this.runs
      .filter((r) => r.pipelineId === pipelineId)
      .sort((a, b) => b.startedAtMs - a.startedAtMs);

    const container = h("div", { className: "pl-runs-page" });

    if (pipelineRuns.length === 0) {
      container.appendChild(
        h(
          "div",
          { className: "pl-empty" },
          h("div", { className: "pl-empty-title", textContent: "No runs yet" }),
          h("div", {
            className: "pl-empty-hint",
            textContent: "Click \"Run workflow\" to start this pipeline. Past runs will appear here.",
          }),
        ),
      );
    } else {
      const list = h("div", { className: "pl-runs-list" });
      for (const r of pipelineRuns) {
        list.appendChild(this.sidebar.renderRunRow(r, false));
      }
      container.appendChild(list);
    }

    this.canvasEl.appendChild(container);
  }

  private setPipelineView(view: PipelineView): void {
    if (this.selection.kind !== "pipeline") return;
    this.selection = { ...this.selection, view };
    this.renderEditor();
  }

  private handleSelectRun(runId: RunId): void {
    this.selection = { kind: "run", runId, latest: null };
    this.panel = { kind: "none" };
    this.deps.send({ type: "loadRun", runId });
    this.sidebar.render();
    this.renderRunLoading();
    this.renderPanel();
  }

  private renderRunLoading(): void {
    clear(this.canvasToolbar);
    clear(this.canvasEl);
    this.canvas.clearStack();
    this.canvasEl.appendChild(
      h(
        "div",
        { className: "pl-empty" },
        h("div", { className: "pl-empty-title", textContent: "Loading run…" }),
      ),
    );
  }

  private renderRunDetail(run: RunState): void {
    this.toolbar.renderRunHeader(run);
    const signature = computeRunSignature(run);
    if (signature === this.renderedRunSignature && this.canvas.hasStack()) {
      this.canvas.updateRunInPlace(run);
      return;
    }
    clear(this.canvasEl);
    const stack = h("div", { className: "pl-canvas-stack" });
    stack.appendChild(this.canvas.renderStaticNode("start", "Start", "Workflow entry", ICON_START, startEndState(run.status, "start")));
    stack.appendChild(this.canvas.renderConnector(null));

    run.blocks.forEach((blockRun, index) => {
      const definition = run.pipelineSnapshot.blocks[index];
      if (!definition) return;
      const runState = buildRunBlockState(run.runId, blockRun, definition);
      if (definition.kind === "parallel") {
        stack.appendChild(this.canvas.renderParallelExpanded(definition, runState));
      } else {
        stack.appendChild(
          this.canvas.renderBlockRowWithOrch(
            this.canvas.renderBlockNode(definition, runState),
            orchStatusFor(blockRun.status),
          ),
        );
      }
      stack.appendChild(this.canvas.renderConnector(null));
    });

    stack.appendChild(this.canvas.renderStaticNode("end", "End", "Workflow complete", ICON_END, startEndState(run.status, "end")));
    this.canvasEl.appendChild(stack);
    this.canvas.setStack(stack);
    this.renderedRunSignature = signature;
    this.applyZoom();
    requestAnimationFrame(() => this.canvas.drawLoopArrows());
  }

  private openLibraryAt(index: number): void {
    this.panel = { kind: "library", insertAtIndex: index };
    this.renderEditor();
    this.renderPanel();
  }

  private openInspector(blockId: string): void {
    this.panel = { kind: "inspector", blockId };
    this.renderEditor();
    this.renderPanel();
  }

  private openRunBlockDetail(blockId: string): void {
    this.panel = { kind: "run-block-detail", blockId };
    if (this.selection.kind === "run" && this.selection.latest) {
      this.renderRunDetail(this.selection.latest);
    }
    this.renderPanel();
  }

  private closePanel(): void {
    this.panel = { kind: "none" };
    if (this.selection.kind === "pipeline") this.renderEditor();
    this.renderPanel();
  }

  private renderPanel(): void {
    clear(this.panelHeader);
    clear(this.panelBody);
    this.canvasArea.classList.toggle("panel-open", this.panel.kind !== "none");

    if (this.panel.kind === "none") return;

    const closeBtn = h("button", {
      className: "pl-panel-close",
      attrs: { type: "button", "aria-label": "Close panel" },
      textContent: "×",
      on: { click: () => this.closePanel() },
    });

    if (this.panel.kind === "library") {
      this.panelHeader.appendChild(h("div", { className: "pl-panel-title", textContent: "Add a block" }));
      this.panelHeader.appendChild(closeBtn);
      this.renderLibraryBody();
      return;
    }

    if (this.panel.kind === "run-block-detail") {
      this.runDetail.render(this.panel.blockId, closeBtn);
      return;
    }

    if (this.panel.kind === "triggers") {
      this.panelHeader.appendChild(h("div", { className: "pl-panel-title", textContent: "Triggers" }));
      this.panelHeader.appendChild(closeBtn);
      this.renderTriggersBody();
      return;
    }

    const block = this.findBlock(this.panel.blockId);
    if (!block) {
      this.panel = { kind: "none" };
      this.canvasArea.classList.remove("panel-open");
      return;
    }
    this.panelHeader.appendChild(h("div", { className: "pl-panel-title", textContent: "Block settings" }));
    this.panelHeader.appendChild(closeBtn);
    this.inspectors.render(block);
  }

  private renderLibraryBody(): void {
    for (const entry of LIBRARY) {
      this.panelBody.appendChild(
        h(
          "button",
          {
            className: "pl-library-item",
            attrs: { type: "button" },
            on: { click: () => this.insertBlockAt(entry.kind, this.libraryInsertIndex()) },
          },
          h("div", {
            className: `pl-library-icon kind-${entry.kind}`,
            innerHTML: entry.icon,
          }),
          h(
            "div",
            {},
            h("div", { className: "pl-library-name" }, h("span", { textContent: entry.label })),
            h("div", { className: "pl-library-desc", textContent: entry.description }),
          ),
        ),
      );
    }
    this.panelBody.appendChild(
      h(
        "div",
        { className: "pl-field-hint", style: { marginTop: "12px" } },
        h("span", {
          textContent:
            "An Orchestrator is automatically inserted after every block. It judges whether the step finished or needs your input.",
        }),
      ),
    );
  }

  private findBlockName(blockId: string | null): string | null {
    if (!blockId || this.selection.kind !== "pipeline") return null;
    const block = this.selection.draft.blocks.find((b) => b.id === blockId);
    return block ? block.name : null;
  }

  private enterLoopDefineMode(loopBlockId: string): void {
    this.loopDefineMode = loopBlockId;
    this.panel = { kind: "none" };
    this.renderEditor();
    this.renderPanel();
  }

  private exitLoopDefineMode(reopenInspectorFor?: string): void {
    this.loopDefineMode = null;
    if (reopenInspectorFor) {
      this.panel = { kind: "inspector", blockId: reopenInspectorFor };
    }
    this.renderEditor();
    this.renderPanel();
  }

  private pickLoopTarget(targetBlockId: string): void {
    if (!this.loopDefineMode) return;
    const loopId = this.loopDefineMode;
    this.updateBlock<LoopBlock>(loopId, (b) => ({ ...b, loopBackToBlockId: toBlockId(targetBlockId) }));
    this.exitLoopDefineMode(loopId);
  }

  private isLoopAnchorCandidate(blockId: string): boolean {
    if (!this.loopDefineMode) return false;
    if (this.selection.kind !== "pipeline") return false;
    const blocks = this.selection.draft.blocks;
    const loopIdx = blocks.findIndex((b) => b.id === this.loopDefineMode);
    const targetIdx = blocks.findIndex((b) => b.id === blockId);
    return loopIdx > 0 && targetIdx >= 0 && targetIdx < loopIdx;
  }

  private updateDraft(patch: Partial<Pipeline>): void {
    if (this.selection.kind !== "pipeline") return;
    this.selection = {
      kind: "pipeline",
      draft: { ...this.selection.draft, ...patch },
      dirty: true,
    };
  }

  private openTriggers(): void {
    this.panel = { kind: "triggers" };
    this.renderPanel();
  }

  private updateTriggers(fn: (triggers: readonly Trigger[]) => readonly Trigger[]): void {
    if (this.selection.kind !== "pipeline") return;
    const draft = { ...this.selection.draft, triggers: fn(this.selection.draft.triggers) };
    this.selection = { kind: "pipeline", draft, dirty: true };
    this.renderEditor();
    this.renderPanel();
  }

  private renderTriggersBody(): void {
    if (this.selection.kind !== "pipeline") return;
    const triggers = this.selection.draft.triggers;
    const body = h("div", { className: "pl-inspector-form" });

    triggers.forEach((trigger, index) => {
      const rows: HTMLElement[] = [];
      const enabledCb = h("input", {
        attrs: { type: "checkbox" },
        on: {
          change: (e) =>
            this.updateTriggers((ts) =>
              ts.map((t, i) => (i === index ? { ...t, enabled: (e.currentTarget as HTMLInputElement).checked } : t)),
            ),
        },
      });
      enabledCb.checked = trigger.enabled;
      rows.push(h("label", { className: "pl-field", style: { flexDirection: "row", alignItems: "center", gap: "8px" } }, enabledCb, h("span", { textContent: "Enabled" })));

      if (trigger.kind === "schedule") {
        const input = h("input", { className: "pl-field-input", attrs: { type: "number", min: "1000", step: "1000" } });
        input.value = String(trigger.intervalMs);
        input.addEventListener("input", () => {
          const n = Number(input.value);
          this.updateTriggers((ts) => ts.map((t, i) => (i === index && t.kind === "schedule" ? { ...t, intervalMs: Number.isFinite(n) && n > 0 ? n : t.intervalMs } : t)));
        });
        rows.push(h("div", { className: "pl-field" }, h("label", { className: "pl-field-label", textContent: "Interval (ms)" }), input));
      } else {
        const input = bareTextInput(trigger.token, (v) =>
          this.updateTriggers((ts) => ts.map((t, i) => (i === index && t.kind === "webhook" ? { ...t, token: v } : t))),
        );
        rows.push(h("div", { className: "pl-field" }, h("label", { className: "pl-field-label", textContent: "Secret token" }), input, h("div", { className: "pl-field-hint", textContent: "POST to /?token=<token> on the configured webhook port." })));
      }

      rows.push(
        h("button", {
          className: "pl-btn ghost danger",
          attrs: { type: "button" },
          textContent: "Remove trigger",
          on: { click: () => this.updateTriggers((ts) => ts.filter((_, i) => i !== index)) },
        }),
      );

      body.appendChild(
        inspectorSection(
          trigger.kind === "schedule" ? ICON_WAIT : ICON_HTTP,
          trigger.kind === "schedule" ? "Schedule" : "Webhook",
          h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } }, ...rows),
        ),
      );
    });

    const addRow = h(
      "div",
      { style: { display: "flex", gap: "8px" } },
      h("button", {
        className: "pl-btn ghost",
        attrs: { type: "button" },
        textContent: "+ Schedule",
        on: { click: () => this.updateTriggers((ts) => [...ts, { kind: "schedule", intervalMs: 3600000, enabled: true }]) },
      }),
      h("button", {
        className: "pl-btn ghost",
        attrs: { type: "button" },
        textContent: "+ Webhook",
        on: { click: () => this.updateTriggers((ts) => [...ts, { kind: "webhook", token: makeId("hook"), enabled: true }]) },
      }),
    );
    body.appendChild(inspectorSection(ICON_PLAY, "Add a trigger", addRow));
    this.panelBody.appendChild(body);
  }

  private updateBlock<T extends Block>(blockId: string, fn: (b: T) => T): void {
    if (this.selection.kind !== "pipeline") return;
    const draft = this.selection.draft;
    const blocks = draft.blocks.map((b) => (b.id === blockId ? fn(b as T) : b));
    this.selection = { kind: "pipeline", draft: { ...draft, blocks }, dirty: true };
    this.renderCanvasOnly();
  }

  private renderCanvasOnly(): void {
    if (this.selection.kind !== "pipeline") return;
    const draft = this.selection.draft;
    clear(this.canvasEl);
    const stack = h("div", { className: "pl-canvas-stack" });
    stack.appendChild(this.canvas.renderStaticNode("start", "Start", "Workflow entry", ICON_START));
    stack.appendChild(this.canvas.renderConnector({ insertIndex: 0 }));
    draft.blocks.forEach((block, index) => {
      if (block.kind === "parallel") {
        stack.appendChild(this.canvas.renderParallelExpanded(block));
      } else {
        stack.appendChild(this.canvas.renderBlockRowWithOrch(this.canvas.renderBlockNode(block)));
      }
      stack.appendChild(this.canvas.renderConnector({ insertIndex: index + 1 }));
    });
    stack.appendChild(this.canvas.renderStaticNode("end", "End", "Workflow complete", ICON_END));
    this.canvasEl.appendChild(stack);
    this.canvas.setStack(stack);
    this.applyZoom();
    requestAnimationFrame(() => this.canvas.drawLoopArrows());
  }

  private updateParallelWorker(blockId: string, workerId: string, patch: Partial<WorkerBlock>): void {
    this.updateBlock<ParallelBlock>(blockId, (b) => ({
      ...b,
      workers: b.workers.map((w) => (w.id === workerId ? { ...w, ...patch } : w)),
    }));
  }

  private addParallelWorker(blockId: string): void {
    const newWorker = defaultWorker("Worker");
    this.updateBlock<ParallelBlock>(blockId, (b) => ({
      ...b,
      workers: [...b.workers, { ...newWorker, name: `Worker ${b.workers.length + 1}` }],
    }));
    this.activeParallelWorker.set(blockId, newWorker.id);
    this.refreshInspectorOnly();
  }

  private removeParallelWorker(blockId: string, workerId: string): void {
    if (this.selection.kind !== "pipeline") return;
    const block = this.selection.draft.blocks.find((b) => b.id === blockId);
    if (!block || block.kind !== "parallel") return;
    const idx = block.workers.findIndex((w) => w.id === workerId);
    const nextActive = block.workers[idx + 1]?.id ?? block.workers[idx - 1]?.id ?? "";

    this.updateBlock<ParallelBlock>(blockId, (b) => ({
      ...b,
      workers: b.workers.filter((w) => w.id !== workerId),
    }));
    if (this.activeParallelWorker.get(blockId) === workerId) {
      if (nextActive) this.activeParallelWorker.set(blockId, nextActive);
      else this.activeParallelWorker.delete(blockId);
    }
    this.refreshInspectorOnly();
  }

  private insertBlockAt(kind: BlockKind, index: number): void {
    if (this.selection.kind !== "pipeline") return;
    const draft = this.selection.draft;
    const block = createBlock(kind);
    const blocks = [...draft.blocks];
    blocks.splice(index, 0, block);
    this.selection = { kind: "pipeline", draft: { ...draft, blocks }, dirty: true };
    if (kind === "loop" && index > 0) {
      this.loopDefineMode = block.id;
      this.panel = { kind: "none" };
    } else {
      this.panel = { kind: "inspector", blockId: block.id };
    }
    this.renderEditor();
    this.renderPanel();
  }

  private removeBlock(blockId: string): void {
    if (this.selection.kind !== "pipeline") return;
    const draft = this.selection.draft;
    this.selection = {
      kind: "pipeline",
      draft: { ...draft, blocks: draft.blocks.filter((b) => b.id !== blockId) },
      dirty: true,
    };
    this.panel = { kind: "none" };
    this.renderEditor();
    this.renderPanel();
  }

  private libraryInsertIndex(): number {
    return this.panel.kind === "library" ? this.panel.insertAtIndex : 0;
  }

  private findBlock(blockId: string): Block | null {
    if (this.selection.kind !== "pipeline") return null;
    return this.selection.draft.blocks.find((b) => b.id === blockId) ?? null;
  }

  private refreshInspectorOnly(): void {
    if (this.panel.kind !== "inspector") return;
    const block = this.findBlock(this.panel.blockId);
    if (!block) return;
    clear(this.panelBody);
    this.inspectors.render(block);
  }

  private handleSave(): void {
    if (this.selection.kind !== "pipeline") return;
    this.deps.send({ type: "savePipeline", pipeline: this.selection.draft });
  }

  private handleRun(): void {
    if (this.selection.kind !== "pipeline") return;
    if (this.selection.dirty) {
      this.showNotice("warning", "Save the workflow before running it.");
      return;
    }
    this.deps.send({ type: "runPipeline", pipelineId: this.selection.draft.id });
  }

  private handleDelete(): void {
    if (this.selection.kind !== "pipeline") return;
    const id: PipelineId = this.selection.draft.id;
    this.deps.send({ type: "deletePipeline", pipelineId: id });
  }

  private showNotice(level: "info" | "warning" | "error", message: string): void {
    const existing = this.root.querySelectorAll(".pl-notice");
    existing.forEach((n) => n.remove());
    const notice = h("div", {
      className: `pl-notice ${level}`,
      textContent: message,
    });
    this.root.appendChild(notice);
    setTimeout(() => { notice.remove(); }, 6000);
  }
}
