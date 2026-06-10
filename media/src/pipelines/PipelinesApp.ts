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
  ScheduleRecurrence,
  Trigger,
  WorkerBlock,
} from "../../../src/features/pipelines/domain/types";
import { toBlockId, clampConcurrency } from "../../../src/features/pipelines/domain/types";
import {
  INTERVAL_UNITS,
  WEEKDAY_LABELS,
  describeRecurrence,
  formatMinute,
  intervalToMs,
  splitInterval,
} from "../../../src/features/pipelines/domain/schedule.js";
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
  runDisplayName,
  runDateGroup,
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
    const MIN = 280;
    const MAX_PX_FALLBACK = 900;
    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const dx = startX - e.clientX;
      const body = this.panelEl.parentElement;
      const containerW = body ? body.getBoundingClientRect().width : window.innerWidth;
      const asst = this.assistant.element();
      const asstW = asst.classList.contains("hidden") ? 0 : asst.getBoundingClientRect().width;
      const cap = Math.max(MIN, Math.min(MAX_PX_FALLBACK, containerW - asstW - 320));
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
    this.renderedRunSignature = null;
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
    this.syncAssistant();
  }

  private renderEditor(): void {
    if (this.selection.kind !== "pipeline") return;
    this.renderedRunSignature = null;
    const draft = this.selection.draft;
    const view = this.selection.view ?? "editor";
    this.toolbar.render(draft, view);
    this.syncAssistant();
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
      } else if (block.kind === "pool") {
        stack.appendChild(this.canvas.renderPoolExpanded(block));
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
    const allRuns = this.runs
      .filter((r) => r.pipelineId === pipelineId)
      .sort((a, b) => b.startedAtMs - a.startedAtMs);

    const container = h("div", { className: "pl-runs-page" });

    if (allRuns.length === 0) {
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
      this.canvasEl.appendChild(container);
      return;
    }

    const listEl = h("div", { className: "pl-runs-list" });
    const refresh = (): void => {
      clear(listEl);
      const q = this.runsSearchQuery.trim().toLowerCase();
      const filtered = allRuns.filter(
        (r) =>
          (this.runsStatusFilter === "all" || r.status === this.runsStatusFilter) &&
          (q === "" || runDisplayName(r.name, r.pipelineName, r.startedAtMs).toLowerCase().includes(q)),
      );
      if (filtered.length === 0) {
        listEl.appendChild(h("div", { className: "pl-runs-empty-filter", textContent: "No runs match." }));
        return;
      }
      const now = Date.now();
      let currentGroup = "";
      for (const r of filtered) {
        const group = runDateGroup(r.startedAtMs, now);
        if (group !== currentGroup) {
          currentGroup = group;
          listEl.appendChild(h("div", { className: "pl-runs-group-label", textContent: group }));
        }
        const selected = this.selection.kind === "run" && this.selection.runId === r.runId;
        listEl.appendChild(this.sidebar.renderRunRow(r, selected));
      }
    };

    const searchInput = h("input", {
      className: "pl-runs-search",
      attrs: { type: "search", placeholder: "Search runs by name…", spellcheck: "false" },
      on: {
        input: (e) => {
          this.runsSearchQuery = (e.currentTarget as HTMLInputElement).value;
          refresh();
        },
      },
    }) as HTMLInputElement;
    searchInput.value = this.runsSearchQuery;

    const chipsRow = h("div", { className: "pl-runs-filters" });
    const renderChips = (): void => {
      clear(chipsRow);
      const statuses = ["all", "running", "paused-needs-input", "completed", "failed", "interrupted"];
      for (const s of statuses) {
        const count = s === "all" ? allRuns.length : allRuns.filter((r) => r.status === s).length;
        if (s !== "all" && count === 0) continue;
        const label = s === "all" ? "All" : s === "paused-needs-input" ? "Paused" : s.charAt(0).toUpperCase() + s.slice(1);
        chipsRow.appendChild(
          h("button", {
            className: `pl-runs-chip${this.runsStatusFilter === s ? " active" : ""}${s !== "all" ? ` pl-status-${s}` : ""}`,
            attrs: { type: "button" },
            on: {
              click: () => {
                this.runsStatusFilter = s;
                renderChips();
                refresh();
              },
            },
          }, h("span", { textContent: label }), h("span", { className: "pl-runs-chip-count", textContent: String(count) })),
        );
      }
    };

    container.appendChild(h("div", { className: "pl-runs-header" }, searchInput, chipsRow));
    container.appendChild(listEl);
    renderChips();
    refresh();
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
    this.renderedRunSignature = null;
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
    this.syncAssistant();
    const signature = computeRunSignature(run);
    if (signature === this.renderedRunSignature && this.canvas.hasStack()) {
      this.updateRunResults(run);
      this.canvas.updateRunInPlace(run);
      return;
    }
    clear(this.canvasEl);
    this.updateRunResults(run);
    const stack = h("div", { className: "pl-canvas-stack" });
    stack.appendChild(this.canvas.renderStaticNode("start", "Start", "Workflow entry", ICON_START, startEndState(run.status, "start")));
    stack.appendChild(this.canvas.renderConnector(null));

    run.blocks.forEach((blockRun, index) => {
      const definition = run.pipelineSnapshot.blocks[index];
      if (!definition) return;
      const runState = buildRunBlockState(run.runId, blockRun, definition);
      if (definition.kind === "parallel") {
        stack.appendChild(this.canvas.renderParallelExpanded(definition, runState));
      } else if (definition.kind === "pool") {
        stack.appendChild(this.canvas.renderPoolExpanded(definition, runState));
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

  private updateRunResults(run: RunState): void {
    const existing = this.canvasEl.querySelector<HTMLElement>(".pl-run-results");
    const next = this.renderRunResults(run);
    if (!next) {
      existing?.remove();
      return;
    }
    if (existing) {
      existing.replaceWith(next);
      return;
    }
    this.canvasEl.insertBefore(next, this.canvasEl.firstChild);
  }

  private renderRunResults(run: RunState): HTMLElement | null {
    if (run.status === "running" || run.status === "paused-needs-input") return null;
    let found: { name: string; output: string } | null = null;
    run.blocks.forEach((br, i) => {
      const def = run.pipelineSnapshot.blocks[i];
      if (def && br.output && br.output.trim().length > 0) {
        found = { name: def.name || def.kind, output: br.output };
      }
    });
    if (!found) return null;
    const result: { name: string; output: string } = found;
    const copyBtn = h("button", {
      className: "pl-btn",
      attrs: { type: "button", title: "Copy results" },
      textContent: "Copy",
      on: {
        click: () => {
          void navigator.clipboard?.writeText(result.output);
          this.showNotice("info", "Results copied to clipboard.");
        },
      },
    });
    return h(
      "div",
      { className: "pl-run-results" },
      h(
        "div",
        { className: "pl-run-results-head" },
        h("span", { className: "pl-run-results-title", textContent: "Results" }),
        h("span", { className: "pl-run-results-src", textContent: `from "${result.name}"` }),
        copyBtn,
      ),
      h("pre", { className: "pl-run-results-body", textContent: result.output }),
    );
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
        rows.push(...this.scheduleEditorRows(trigger.recurrence, index));
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
        on: { click: () => this.updateTriggers((ts) => [...ts, { kind: "schedule", enabled: true, recurrence: { type: "weekly", weekdays: [1], atMinute: 540 } }]) },
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

  private setRecurrence(index: number, recurrence: ScheduleRecurrence): void {
    this.updateTriggers((ts) => ts.map((t, i) => (i === index && t.kind === "schedule" ? { ...t, recurrence } : t)));
  }

  private scheduleEditorRows(recurrence: ScheduleRecurrence, index: number): HTMLElement[] {
    const rows: HTMLElement[] = [];
    const atMinute = recurrence.type === "interval" ? 540 : recurrence.atMinute;

    const typeSel = h("select", { className: "pl-field-input" },
      ...(["interval", "daily", "weekly", "monthly"] as const).map((tp) =>
        h("option", { attrs: { value: tp, ...(recurrence.type === tp ? { selected: "selected" } : {}) }, textContent: `${tp[0]!.toUpperCase()}${tp.slice(1)}` }),
      ),
    ) as HTMLSelectElement;
    typeSel.addEventListener("change", () => this.setRecurrence(index, defaultRecurrenceOfType(typeSel.value, atMinute)));
    rows.push(h("div", { className: "pl-field" }, h("label", { className: "pl-field-label", textContent: "Repeat" }), typeSel));

    if (recurrence.type === "interval") {
      const { value, unit } = splitInterval(recurrence.everyMs);
      const valInput = h("input", { className: "pl-field-input", attrs: { type: "number", min: "1", step: "1" } }) as HTMLInputElement;
      valInput.value = String(value);
      const unitSel = h("select", { className: "pl-field-input" },
        ...INTERVAL_UNITS.map((u) => h("option", { attrs: { value: u.id, ...(u.id === unit ? { selected: "selected" } : {}) }, textContent: u.label })),
      ) as HTMLSelectElement;
      const apply = (): void => this.setRecurrence(index, { type: "interval", everyMs: intervalToMs(Number(valInput.value) || 1, unitSel.value) });
      valInput.addEventListener("input", apply);
      unitSel.addEventListener("change", apply);
      rows.push(h("div", { className: "pl-field" }, h("label", { className: "pl-field-label", textContent: "Every" }), h("div", { style: { display: "flex", gap: "8px" } }, valInput, unitSel)));
    } else {
      if (recurrence.type === "weekly") {
        const chips = h("div", { style: { display: "flex", gap: "4px", flexWrap: "wrap" } });
        WEEKDAY_LABELS.forEach((label, d) => {
          const on = recurrence.weekdays.includes(d);
          chips.appendChild(h("button", {
            className: `pl-btn ghost${on ? " primary" : ""}`,
            attrs: { type: "button", "aria-pressed": on ? "true" : "false" },
            textContent: label,
            on: { click: () => {
              const set = new Set(recurrence.weekdays);
              if (set.has(d)) set.delete(d); else set.add(d);
              const weekdays = [...set].sort((a, b) => a - b);
              this.setRecurrence(index, { type: "weekly", weekdays: weekdays.length > 0 ? weekdays : [d], atMinute });
            } },
          }));
        });
        rows.push(h("div", { className: "pl-field" }, h("label", { className: "pl-field-label", textContent: "On days" }), chips));
      }
      if (recurrence.type === "monthly") {
        const dayInput = h("input", { className: "pl-field-input", attrs: { type: "number", min: "1", max: "31", step: "1" } }) as HTMLInputElement;
        dayInput.value = String(recurrence.day);
        dayInput.addEventListener("input", () => {
          const d = Math.min(31, Math.max(1, Math.round(Number(dayInput.value) || 1)));
          this.setRecurrence(index, { type: "monthly", day: d, atMinute });
        });
        rows.push(h("div", { className: "pl-field" }, h("label", { className: "pl-field-label", textContent: "Day of month" }), dayInput));
      }
      const timeInput = h("input", { className: "pl-field-input", attrs: { type: "time" } }) as HTMLInputElement;
      timeInput.value = formatMinute(atMinute);
      timeInput.addEventListener("input", () => {
        const m = timeToMinute(timeInput.value);
        if (m !== null) this.setRecurrence(index, withAtMinute(recurrence, m));
      });
      rows.push(h("div", { className: "pl-field" }, h("label", { className: "pl-field-label", textContent: "At time" }), timeInput));
    }

    rows.push(h("div", { className: "pl-field-hint", textContent: `Runs ${describeRecurrence(recurrence)}, while the Claude Trace tab is open and the computer is awake.` }));
    return rows;
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
      } else if (block.kind === "pool") {
        stack.appendChild(this.canvas.renderPoolExpanded(block));
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

const timeToMinute = (v: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
};

const withAtMinute = (r: ScheduleRecurrence, atMinute: number): ScheduleRecurrence => {
  switch (r.type) {
    case "interval": return r;
    case "daily": return { type: "daily", atMinute };
    case "weekly": return { type: "weekly", weekdays: r.weekdays, atMinute };
    case "monthly": return { type: "monthly", day: r.day, atMinute };
  }
};

const defaultRecurrenceOfType = (type: string, atMinute: number): ScheduleRecurrence => {
  switch (type) {
    case "daily": return { type: "daily", atMinute };
    case "weekly": return { type: "weekly", weekdays: [1], atMinute };
    case "monthly": return { type: "monthly", day: 1, atMinute };
    default: return { type: "interval", everyMs: 3_600_000 };
  }
};
