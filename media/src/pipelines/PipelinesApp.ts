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
  PoolBlock,
  RunId,
  RunState,
  Trigger,
  WorkerBlock,
} from "../../../src/features/pipelines/domain/types";
import { toBlockId, toPipelineId, clampConcurrency } from "../../../src/features/pipelines/domain/types";
import { assertNeverPipelines } from "../../../src/features/pipelines/protocol";
import type {
  PipelinesHostToWebview,
  PipelinesWebviewToHost,
  RunSummary,
} from "../../../src/features/pipelines/protocol";
import {
  ICON_PLUS,
  ICON_ZAP,
} from "./pipelineIcons.js";
import { createBlock, defaultWorker } from "./pipelineBlockMeta.js";
import { PipelineInspectors } from "./pipelineInspectors.js";
import { RunDetailPanel } from "./runDetailPanel.js";
import { renderTriggersBody } from "./triggersPanel.js";
import { renderRunsListPage } from "./runsListView.js";
import { renderLibraryBody } from "./libraryPanelView.js";
import { PipelineCanvas } from "./pipelineCanvas.js";
import {
  renderCanvasOnly as renderCanvasOnlyView,
  renderEditor as renderEditorView,
  renderEmpty as renderEmptyView,
  renderRunDetail as renderRunDetailView,
  renderRunLoading as renderRunLoadingView,
  wirePanelResizer as wirePanelResizerView,
  type AppViewHost,
} from "./appCanvasViews.js";
import { PipelineSidebar } from "./pipelineSidebar.js";
import { PipelineToolbar } from "./pipelineToolbar.js";
import { WorkflowAssistantPanel } from "./workflowAssistantPanel.js";

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

const isEditableElement = (el: HTMLElement): boolean =>
  el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";

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
  private autoOpenRunForPipeline: PipelineId | null = null;
  private runsSearchQuery = "";
  private runsStatusFilter = "all";
  private readonly deferredWhileRenaming = new Map<string, PipelinesHostToWebview>();
  private zoom = 1;
  private loopDefineMode: string | null = null;
  private readonly activeParallelWorker = new Map<string, string>();
  private renderedRunSignature: string | null = null;
  private lastAssistantGroup: string | null = null;
  private readonly inspectors: PipelineInspectors;
  private readonly runDetail: RunDetailPanel;
  private readonly canvas: PipelineCanvas;
  private readonly sidebar: PipelineSidebar;
  private readonly toolbar: PipelineToolbar;
  private readonly assistant: WorkflowAssistantPanel;

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

    this.assistant = new WorkflowAssistantPanel({
      send: (msg) => this.deps.send(msg),
      getPipeline: () => this.currentPipeline(),
      onApply: (pipeline) => this.applyProposedPipeline(pipeline),
    });

    const canvasMain = h(
      "div",
      { className: "pl-canvas-main" },
      this.canvasEl,
      zoomHost,
    );
    const canvasBody = h(
      "div",
      { className: "pl-canvas-body" },
      canvasMain,
      this.panelEl,
      this.assistant.element(),
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
      setPoolConcurrency: (blockId, concurrency) => this.setPoolConcurrency(blockId, concurrency),
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
      renameRun: (runId, name) => this.deps.send({ type: "renameRun", runId, name }),
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
      renameRun: (runId, name) => this.deps.send({ type: "renameRun", runId, name }),
      onAssistant: () => this.assistant.setOpen(!this.assistant.isOpen()),
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
    document.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key !== "Escape" || this.panel.kind === "none") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      this.closePanel();
    });
    this.root.addEventListener(
      "focusout",
      (e: FocusEvent) => {
        const left = e.target as HTMLElement | null;
        if (!left || !isEditableElement(left)) return;
        setTimeout(() => this.flushDeferredWhileRenaming(), 0);
      },
      true,
    );
  }

  private isEditingInApp(): boolean {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !isEditableElement(active) || !this.root.contains(active)) return false;
    return !this.assistant.element().contains(active);
  }

  private flushDeferredWhileRenaming(): void {
    if (this.isEditingInApp() || this.deferredWhileRenaming.size === 0) return;
    const pending = [...this.deferredWhileRenaming.values()];
    this.deferredWhileRenaming.clear();
    for (const msg of pending) this.receive(msg);
  }

  element(): HTMLElement {
    return this.root;
  }

  private currentPipeline(): Pipeline | null {
    if (this.selection.kind === "pipeline") return this.selection.draft;
    if (this.selection.kind === "run") return this.selection.latest?.pipelineSnapshot ?? null;
    return null;
  }

  private syncAssistant(): void {
    const id = (this.currentPipeline()?.id ?? null) as string | null;
    if (id === this.lastAssistantGroup) return;
    this.lastAssistantGroup = id;
    this.assistant.switchPipeline();
  }

  receive(msg: PipelinesHostToWebview): void {
    if (this.isEditingInApp() && (msg.type === "runUpdate" || msg.type === "pipelinesList")) {
      this.deferredWhileRenaming.set(msg.type, msg);
      return;
    }
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
        if (this.autoOpenRunForPipeline !== null && msg.run.pipelineId === this.autoOpenRunForPipeline) {
          this.autoOpenRunForPipeline = null;
          this.selection = { kind: "run", runId: msg.run.runId, latest: msg.run };
          this.panel = { kind: "none" };
          this.renderRunDetail(msg.run);
          this.renderPanel();
          this.sidebar.render();
          return;
        }
        if (this.selection.kind === "run" && this.selection.runId === msg.run.runId) {
          this.selection = { kind: "run", runId: msg.run.runId, latest: msg.run };
          this.renderRunDetail(msg.run);
          if (this.panel.kind === "run-block-detail") this.renderPanel();
        }
        this.sidebar.render();
        return;
      case "sessionTranscript":
        this.runDetail.cacheTranscript(msg.sessionId, msg.text);
        if (this.panel.kind === "run-block-detail") this.renderPanel();
        return;
      case "validationFailed":
        this.showNotice("error", msg.errors.map((e) => `• ${e.message}`).join("\n"));
        return;
      case "notice":
        this.showNotice(msg.level, msg.message);
        return;
      case "pipelineAssistantReply":
      case "pipelineAssistantProgress":
      case "pipelineAssistantHistory":
      case "pipelineAssistantError":
      case "pipelineAssistantBusy":
      case "pipelineAssistantConversations":
        this.assistant.receive(msg);
        return;
      default:
        assertNeverPipelines(msg);
    }
  }

  private wirePanelResizer(handle: HTMLElement): void {
    wirePanelResizerView(this.viewHost(), handle);
  }

  private renderEmpty(): void {
    renderEmptyView(this.viewHost());
  }

  private renderEditor(): void {
    renderEditorView(this.viewHost());
  }

  private renderRunLoading(): void {
    renderRunLoadingView(this.viewHost());
  }

  private renderRunDetail(run: RunState): void {
    renderRunDetailView(this.viewHost(), run);
  }

  private renderCanvasOnly(): void {
    renderCanvasOnlyView(this.viewHost());
  }

  private viewHost(): AppViewHost {
    return {
      canvasToolbar: this.canvasToolbar,
      canvasEl: this.canvasEl,
      canvasArea: this.canvasArea,
      panelEl: this.panelEl,
      canvas: this.canvas,
      toolbar: this.toolbar,
      assistantElement: () => this.assistant.element(),
      editorSelection: () => (this.selection.kind === "pipeline" ? { draft: this.selection.draft, view: this.selection.view ?? "editor" } : null),
      loopDefineMode: () => this.loopDefineMode,
      exitLoopDefineMode: () => this.exitLoopDefineMode(),
      renderPipelineRunsList: (pipelineId) => this.renderPipelineRunsList(toPipelineId(pipelineId)),
      applyZoom: () => this.applyZoom(),
      syncAssistant: () => this.syncAssistant(),
      getRenderedRunSignature: () => this.renderedRunSignature,
      setRenderedRunSignature: (sig) => { this.renderedRunSignature = sig; },
      showNotice: (level, message) => this.showNotice(level, message),
    };
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

  private renderPipelineRunsList(pipelineId: PipelineId): void {
    this.canvasEl.appendChild(renderRunsListPage({
      runs: () => this.runs,
      isRunSelected: (runId) => this.selection.kind === "run" && this.selection.runId === runId,
      getSearch: () => this.runsSearchQuery,
      setSearch: (v) => { this.runsSearchQuery = v; },
      getStatusFilter: () => this.runsStatusFilter,
      setStatusFilter: (v) => { this.runsStatusFilter = v; },
      renderRunRow: (r, selected) => this.sidebar.renderRunRow(r, selected),
    }, pipelineId));
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
    renderLibraryBody(this.panelBody, (kind) => this.insertBlockAt(kind, this.libraryInsertIndex()));
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
    const draft = this.selection.draft;
    this.panelBody.appendChild(renderTriggersBody({
      triggers: () => draft.triggers,
      updateTriggers: (fn) => this.updateTriggers(fn),
    }));
  }

  private updateBlock<T extends Block>(blockId: string, fn: (b: T) => T): void {
    if (this.selection.kind !== "pipeline") return;
    const draft = this.selection.draft;
    const blocks = draft.blocks.map((b) => (b.id === blockId ? fn(b as T) : b));
    this.selection = { kind: "pipeline", draft: { ...draft, blocks }, dirty: true };
    this.renderCanvasOnly();
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

  private setPoolConcurrency(blockId: string, concurrency: number): void {
    this.updateBlock<PoolBlock>(blockId, (b) => ({ ...b, concurrency: clampConcurrency(concurrency) }));
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

  private applyProposedPipeline(proposed: Pipeline): Pipeline | null {
    const previous = this.selection.kind === "pipeline" ? this.selection.draft : null;
    this.selection = { kind: "pipeline", draft: proposed, dirty: false };
    this.panel = { kind: "none" };
    this.deps.send({ type: "savePipeline", pipeline: proposed });
    this.sidebar.render();
    this.renderEditor();
    this.renderPanel();
    this.showNotice("info", "Workflow applied from the assistant.");
    return previous;
  }

  private handleRun(): void {
    if (this.selection.kind !== "pipeline") return;
    if (this.selection.dirty) {
      this.showNotice("warning", "Save the workflow before running it.");
      return;
    }
    this.autoOpenRunForPipeline = this.selection.draft.id;
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
