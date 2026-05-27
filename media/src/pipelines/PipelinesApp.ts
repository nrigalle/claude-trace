import { setIfChanged } from "../ui/dom.js";
import { h, clear } from "../ui/h.js";
import { SidebarResizer } from "../ui/layout/SidebarResizer.js";
import { SIDEBAR_DEFAULT_PX } from "../ui/layout/sidebarWidth.js";
import { MODEL_OPTIONS } from "../../../src/shared/models";
import { EFFORT_OPTIONS } from "../../../src/shared/thinkingLevels";
import type {
  ApprovalBlock,
  Block,
  BlockId,
  BlockKind,
  BlockStatus,
  ConditionBlock,
  EffortLevel,
  EvaluatorBlock,
  FileBlock,
  FileOperation,
  HttpBlock,
  HttpMethod,
  Interpreter,
  LlmBlock,
  LoopBlock,
  MapBlock,
  ParallelBlock,
  Pipeline,
  PipelineId,
  ReduceBlock,
  ReduceMode,
  RunId,
  RunState,
  ScriptBlock,
  Trigger,
  WaitBlock,
  WorkerBlock,
} from "../../../src/features/pipelines/domain/types";
import {
  latestPromptSent,
  latestSessionId,
  latestSummary,
  toBlockId,
} from "../../../src/features/pipelines/domain/types";
import type { ModelChoice } from "../../../src/shared/models";
import { assertNever } from "../../../src/shared/assertNever";
import { assertNeverPipelines } from "../../../src/features/pipelines/protocol";
import type {
  PipelinesHostToWebview,
  PipelinesWebviewToHost,
  RunSummary,
  SessionTarget,
} from "../../../src/features/pipelines/protocol";

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

interface RunBlockState {
  readonly runId?: RunId;
  readonly status: string;
  readonly summary: string | null;
  readonly stuckReason: string | null;
  readonly failureReason: string | null;
  readonly sessionId: string | null;
  readonly lastPromptSent: string | null;
  readonly iterations: number;
  readonly parallelWorkerStatuses?: ReadonlyMap<BlockId, BlockStatus>;
  readonly parallelWorkerSessionIds?: ReadonlyMap<BlockId, string | null>;
  readonly mergerStatus?: string;
  readonly mergerSessionId?: string | null;
  readonly loopMaxIterations?: number;
  readonly parallelDoneCount?: number;
  readonly parallelTotalCount?: number;
}

interface SidebarRowRefs {
  readonly nameEl: HTMLElement;
  readonly blocksEl: HTMLElement;
  readonly runBadgeEl: HTMLElement;
}
const sidebarRowRefs = new WeakMap<HTMLElement, SidebarRowRefs>();

interface StaticNodeRefs {
  readonly bubbleEl: HTMLElement;
  readonly sublabelEl: HTMLElement;
  readonly defaultSublabel: string;
  readonly kind: "start" | "end";
}
const staticNodeRefs = new WeakMap<HTMLElement, StaticNodeRefs>();

const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;

const blockCountLabel = (n: number): string => `${n} block${n === 1 ? "" : "s"}`;
const runCountLabel = (n: number): string => `${n} run${n === 1 ? "" : "s"}`;


const staticSublabel = (
  kind: "start" | "end",
  runState: "active" | "completed" | "failed" | "interrupted" | undefined,
  fallback: string,
): string => {
  if (kind !== "end") return fallback;
  if (runState === "completed") return "Pipeline complete";
  if (runState === "failed") return "Pipeline failed";
  if (runState === "interrupted") return "Pipeline interrupted";
  return fallback;
};

const startEndState = (
  status: RunState["status"],
  pos: "start" | "end",
): "active" | "completed" | "failed" | "interrupted" | undefined => {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "interrupted") return "interrupted";
  return pos === "start" ? "active" : undefined;
};

const buildRunBlockState = (
  runId: RunId,
  blockRun: RunState["blocks"][number],
  definition: Block,
): RunBlockState => {
  const parallelWorkerStatuses = blockRun.parallel
    ? new Map<BlockId, BlockStatus>(blockRun.parallel.workerRuns.map((w) => [w.workerBlockId, w.status]))
    : undefined;
  const parallelWorkerSessionIds = blockRun.parallel
    ? new Map<BlockId, string | null>(
        blockRun.parallel.workerRuns.map((w) => [w.workerBlockId, w.sessions.at(-1)?.sessionId ?? null]),
      )
    : undefined;
  const parallelTotalCount = blockRun.parallel ? blockRun.parallel.workerRuns.length : undefined;
  const parallelDoneCount = blockRun.parallel
    ? blockRun.parallel.workerRuns.filter((w) => w.status === "done").length
    : undefined;
  return {
    runId,
    status: blockRun.status,
    summary: latestSummary(blockRun),
    stuckReason: blockRun.stuckReason,
    failureReason: blockRun.failureReason,
    sessionId: latestSessionId(blockRun),
    lastPromptSent: latestPromptSent(blockRun),
    iterations: blockRun.sessions.length,
    parallelWorkerStatuses,
    parallelWorkerSessionIds,
    mergerStatus: blockRun.parallel?.mergerStatus,
    mergerSessionId: blockRun.parallel?.mergerSessions.at(-1)?.sessionId ?? null,
    loopMaxIterations: definition.kind === "loop" ? definition.maxIterations : undefined,
    parallelDoneCount,
    parallelTotalCount,
  };
};

const computeRunSignature = (run: RunState): string => {
  const parts = run.pipelineSnapshot.blocks.map((b) => {
    if (b.kind === "parallel") return `${b.id}:parallel:${b.workers.map((w) => w.id).join(",")}`;
    return `${b.id}:${b.kind}`;
  });
  return `${run.runId}::${parts.join("|")}`;
};

const ICON_WORKER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v2H7a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-9a3 3 0 0 0-3-3h-2V5a3 3 0 0 0-3-3z"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/></svg>';
const ICON_ORCHESTRATOR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3"/><path d="M12 21v-3"/><path d="M5 8l3-2"/><path d="M19 8l-3-2"/><path d="M5 16l3 2"/><path d="M19 16l-3 2"/><circle cx="12" cy="12" r="4"/></svg>';
const ICON_PARALLEL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v6"/><path d="M6 21l6-12 6 12"/><circle cx="6" cy="21" r="1.5"/><circle cx="12" cy="9" r="1.5"/><circle cx="18" cy="21" r="1.5"/></svg>';
const ICON_LOOP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7l3-3"/><path d="M21 6v6h-6"/><path d="M21 12a9 9 0 0 1-15 6.7l-3 3"/><path d="M3 18v-6h6"/></svg>';
const ICON_MERGER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4 L12 12 L20 4"/><path d="M12 12 V20"/><circle cx="4" cy="4" r="1.5"/><circle cx="20" cy="4" r="1.5"/></svg>';
const ICON_START =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
const ICON_END =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
const ICON_PLUS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
const ICON_PLAY =
  '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><polygon points="7 4 19 12 7 20 7 4"/></svg>';
const ICON_WARNING =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
const ICON_ZAP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
const ICON_TAG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>';
const ICON_FILE_TEXT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/></svg>';
const ICON_SLIDERS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>';
const ICON_REPEAT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';
const ICON_SCRIPT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';
const ICON_HTTP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
const ICON_FILE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
const ICON_CONDITION =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
const ICON_WAIT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
const ICON_REDUCE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>';
const ICON_LLM =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>';
const ICON_EVALUATOR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
const ICON_MAP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>';
const ICON_APPROVAL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';

const REDUCE_MODE_OPTIONS: readonly { readonly id: ReduceMode; readonly label: string }[] = [
  { id: "concat", label: "Concatenate lines" },
  { id: "llm", label: "Synthesize with an LLM" },
];

const INTERPRETER_OPTIONS: readonly { readonly id: Interpreter; readonly label: string }[] = [
  { id: "bash", label: "Bash" },
  { id: "sh", label: "sh" },
  { id: "python", label: "Python" },
  { id: "node", label: "Node.js" },
];

const HTTP_METHOD_OPTIONS: readonly { readonly id: HttpMethod; readonly label: string }[] = [
  { id: "GET", label: "GET" },
  { id: "POST", label: "POST" },
  { id: "PUT", label: "PUT" },
  { id: "PATCH", label: "PATCH" },
  { id: "DELETE", label: "DELETE" },
];

const FILE_OP_OPTIONS: readonly { readonly id: FileOperation; readonly label: string }[] = [
  { id: "write", label: "Write file" },
  { id: "read", label: "Read file" },
];

interface LibraryEntry {
  readonly kind: BlockKind;
  readonly label: string;
  readonly description: string;
  readonly icon: string;
}

const LIBRARY: readonly LibraryEntry[] = [
  {
    kind: "worker",
    label: "Worker",
    description: "An interactive Claude Code session with a prompt. Runs in bypassPermissions mode.",
    icon: ICON_WORKER,
  },
  {
    kind: "parallel",
    label: "Parallel",
    description: "Fan out into branches that run side by side, then a Merger combines results before the pipeline continues.",
    icon: ICON_PARALLEL,
  },
  {
    kind: "loop",
    label: "Loop",
    description: "Repeat a sequence of workers up to N times. Each iteration resumes the same Claude sessions.",
    icon: ICON_LOOP,
  },
  {
    kind: "script",
    label: "Script",
    description: "Run a shell, Python, or Node script in the run workspace. Stdout becomes the block output.",
    icon: ICON_SCRIPT,
  },
  {
    kind: "http",
    label: "HTTP request",
    description: "Call an external API or webhook. The response body becomes the block output.",
    icon: ICON_HTTP,
  },
  {
    kind: "file",
    label: "File",
    description: "Write or read a file in the shared run workspace so later blocks can use it.",
    icon: ICON_FILE,
  },
  {
    kind: "condition",
    label: "Condition",
    description: "Branch the workflow: when the expression is false, skip the blocks up to a chosen rejoin point.",
    icon: ICON_CONDITION,
  },
  {
    kind: "wait",
    label: "Wait",
    description: "Pause the pipeline for a fixed delay before continuing.",
    icon: ICON_WAIT,
  },
  {
    kind: "reduce",
    label: "Reduce",
    description: "Combine a list variable into one value — concatenate lines or synthesize with an LLM.",
    icon: ICON_REDUCE,
  },
  {
    kind: "llm",
    label: "LLM call",
    description: "A single, one-shot Claude prompt (no tool loop). The reply becomes the block output.",
    icon: ICON_LLM,
  },
  {
    kind: "evaluator",
    label: "Evaluator",
    description: "An LLM gate: judges a goal and passes or fails the run. Use it to block progress until criteria are met.",
    icon: ICON_EVALUATOR,
  },
  {
    kind: "map",
    label: "Map",
    description: "Run a prompt once per line of a list variable, collecting every result into one output.",
    icon: ICON_MAP,
  },
  {
    kind: "approval",
    label: "Approval",
    description: "Pause the run for a human to review. The pipeline continues only after you click Continue.",
    icon: ICON_APPROVAL,
  },
];

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
  private currentStack: HTMLElement | null = null;
  private loopDefineMode: string | null = null;
  private readonly activeParallelWorker = new Map<string, string>();
  private readonly sidebarNodes = new Map<string, HTMLButtonElement>();
  private renderedRunSignature: string | null = null;

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
      onLivePx: () => {},
      onCommitPx: () => {},
    });
    sidebar.appendChild(sidebarResizer.element);
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
        this.renderSidebar();
        return;
      case "pipelineDetail":
        this.selection = { kind: "pipeline", draft: msg.pipeline, dirty: false };
        this.panel = { kind: "none" };
        this.renderSidebar();
        this.renderEditor();
        this.renderPanel();
        return;
      case "runUpdate":
        if (this.selection.kind === "run" && this.selection.runId === msg.run.runId) {
          this.selection = { kind: "run", runId: msg.run.runId, latest: msg.run };
          this.renderRunDetail(msg.run);
        }
        this.renderSidebar();
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
    if (this.currentStack) this.currentStack.style.transform = `scale(${this.zoom})`;
    this.zoomReadout.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  private renderSidebar(): void {
    const emptyHint = this.sidebarListEl.querySelector<HTMLElement>(".pl-sidebar-empty");
    if (this.pipelines.length === 0) {
      for (const [, node] of this.sidebarNodes) node.remove();
      this.sidebarNodes.clear();
      if (!emptyHint) {
        this.sidebarListEl.appendChild(
          h("div", {
            className: "pl-sidebar-empty",
            textContent: "No workflows yet. Click + New workflow to create one.",
          }),
        );
      }
      return;
    }
    if (emptyHint) emptyHint.remove();

    const runsByPipeline = new Map<PipelineId, number>();
    for (const r of this.runs) {
      runsByPipeline.set(r.pipelineId, (runsByPipeline.get(r.pipelineId) ?? 0) + 1);
    }

    const seen = new Set<string>();
    let prev: HTMLButtonElement | null = null;
    const selectedId = this.selection.kind === "pipeline" ? this.selection.draft.id : null;

    for (const p of this.pipelines) {
      seen.add(p.id);
      const runCount = runsByPipeline.get(p.id) ?? 0;
      const selected = selectedId === p.id;
      let node = this.sidebarNodes.get(p.id);
      if (!node) {
        node = this.buildSidebarRow(p, runCount, selected);
        this.sidebarNodes.set(p.id, node);
      } else {
        this.updateSidebarRow(node, p, runCount, selected);
      }
      const expectedNext: ChildNode | null = prev ? prev.nextSibling : this.sidebarListEl.firstChild;
      if (node !== expectedNext) this.sidebarListEl.insertBefore(node, expectedNext);
      prev = node;
    }

    for (const [id, node] of this.sidebarNodes) {
      if (!seen.has(id)) {
        node.remove();
        this.sidebarNodes.delete(id);
      }
    }
  }

  private buildSidebarRow(p: Pipeline, runCount: number, selected: boolean): HTMLButtonElement {
    const nameEl = h("span", { className: "pl-sidebar-item-name", textContent: p.name });
    const blocksEl = h("span", { textContent: blockCountLabel(p.blocks.length) });
    const runBadgeEl = h("span", {
      className: "pl-run-count-badge",
      textContent: runCountLabel(runCount),
      style: { display: runCount > 0 ? "" : "none" },
    });
    const button = h(
      "button",
      {
        className: `pl-sidebar-item${selected ? " selected" : ""}`,
        attrs: { type: "button" },
        on: { click: () => this.deps.send({ type: "loadPipeline", pipelineId: p.id }) },
      },
      h("div", { className: "pl-sidebar-item-name-row" }, nameEl),
      h("div", { className: "pl-sidebar-item-meta" }, blocksEl, runBadgeEl),
    ) as HTMLButtonElement;
    sidebarRowRefs.set(button, { nameEl, blocksEl, runBadgeEl });
    return button;
  }

  private updateSidebarRow(button: HTMLButtonElement, p: Pipeline, runCount: number, selected: boolean): void {
    button.classList.toggle("selected", selected);
    const { nameEl, blocksEl, runBadgeEl } = sidebarRowRefs.get(button)!;
    setIfChanged(nameEl, p.name);
    setIfChanged(blocksEl, blockCountLabel(p.blocks.length));
    setIfChanged(runBadgeEl, runCountLabel(runCount));
    runBadgeEl.style.display = runCount > 0 ? "" : "none";
  }

  private renderRunRow(r: RunSummary, selected: boolean): HTMLElement {
    const startedDate = new Date(r.startedAtMs);
    const dateText = startedDate.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const timeText = startedDate.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const duration = r.endedAtMs && r.startedAtMs
      ? `${Math.round((r.endedAtMs - r.startedAtMs) / 1000)}s`
      : null;

    const deleteBtn = h("button", {
      className: "pl-run-delete-btn",
      attrs: {
        type: "button",
        title: "Delete this run",
        "aria-label": "Delete this run",
      },
      innerHTML: ICON_TRASH,
      on: {
        click: (e: MouseEvent) => {
          e.stopPropagation();
          e.preventDefault();
          this.deps.send({ type: "deleteRun", runId: r.runId });
        },
        mousedown: (e: MouseEvent) => { e.stopPropagation(); },
      },
    });

    return h(
      "div",
      {
        className: `pl-run-card${selected ? " active" : ""}`,
        on: {
          click: (e: MouseEvent) => {
            if ((e.target as HTMLElement).closest(".pl-run-delete-btn")) return;
            this.handleSelectRun(r.runId);
          },
        },
        attrs: { role: "button", tabindex: "0" },
      },
      h(
        "div",
        { className: "pl-run-card-main" },
        h(
          "div",
          { className: "pl-run-card-header" },
          h("span", { className: "pl-run-card-date", textContent: `${dateText} · ${timeText}` }),
          h("span", {
            className: `pl-status-pill pl-status-${r.status}`,
            textContent: r.status,
          }),
        ),
        h(
          "div",
          { className: "pl-run-card-meta" },
          h("span", { textContent: `${r.blockCount} block${r.blockCount === 1 ? "" : "s"}` }),
          duration ? h("span", { textContent: duration }) : null,
        ),
      ),
      deleteBtn,
    );
  }

  private renderEmpty(): void {
    clear(this.canvasToolbar);
    clear(this.canvasEl);
    this.currentStack = null;
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
    this.renderToolbar(draft, view);
    clear(this.canvasEl);

    if (view === "runs") {
      this.renderPipelineRunsList(draft.id);
      this.currentStack = null;
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
    stack.appendChild(this.renderStaticNode("start", "Start", "Workflow entry", ICON_START));
    stack.appendChild(this.renderConnector({ insertIndex: 0 }));

    draft.blocks.forEach((block, index) => {
      if (block.kind === "parallel") {
        stack.appendChild(this.renderParallelExpanded(block));
      } else {
        stack.appendChild(this.renderBlockRowWithOrch(this.renderBlockNode(block)));
      }
      stack.appendChild(this.renderConnector({ insertIndex: index + 1 }));
    });

    stack.appendChild(this.renderStaticNode("end", "End", "Workflow complete", ICON_END));
    this.canvasEl.appendChild(stack);
    this.currentStack = stack;
    this.applyZoom();
    requestAnimationFrame(() => this.drawLoopArrows());
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
        list.appendChild(this.renderRunRow(r, false));
      }
      container.appendChild(list);
    }

    this.canvasEl.appendChild(container);
  }

  private renderToolbar(draft: Pipeline, view: PipelineView): void {
    clear(this.canvasToolbar);
    const runCount = this.runs.filter((r) => r.pipelineId === draft.id).length;

    const nameInput = h("input", {
      className: "pl-name-input",
      attrs: { type: "text", placeholder: "Untitled workflow" },
      on: {
        input: (e) => {
          const target = e.currentTarget as HTMLInputElement;
          this.updateDraft({ name: target.value });
        },
      },
    });
    nameInput.value = draft.name;

    const blockCount = draft.blocks.length;
    const subtitleText = `${blockCount} block${blockCount === 1 ? "" : "s"}${runCount > 0 ? ` · ${runCount} run${runCount === 1 ? "" : "s"}` : ""}`;

    const heading = h(
      "div",
      { className: "pl-header-row" },
      h(
        "div",
        { className: "pl-header-title" },
        h("div", { className: "pl-header-icon", innerHTML: ICON_ZAP }),
        h(
          "div",
          { className: "pl-header-title-text" },
          nameInput,
          h("div", { className: "pl-header-subtitle", textContent: subtitleText }),
        ),
      ),
      h("button", {
        className: "pl-btn primary pl-btn-run",
        attrs: { type: "button", title: "Run this workflow" },
        innerHTML: `<span class="pl-btn-icon">${ICON_PLAY}</span><span>Run workflow</span>`,
        on: { click: () => this.handleRun() },
      }),
    );

    const tabs = h(
      "div",
      { className: "pl-view-tabs" },
      h("button", {
        className: `pl-view-tab${view === "editor" ? " active" : ""}`,
        attrs: { type: "button", role: "tab", "aria-selected": String(view === "editor") },
        textContent: "Definition",
        on: { click: () => this.setPipelineView("editor") },
      }),
      h(
        "button",
        {
          className: `pl-view-tab${view === "runs" ? " active" : ""}`,
          attrs: { type: "button", role: "tab", "aria-selected": String(view === "runs") },
          on: { click: () => this.setPipelineView("runs") },
        },
        h("span", { textContent: "Runs" }),
        runCount > 0
          ? h("span", { className: "pl-view-tab-badge", textContent: String(runCount) })
          : null,
      ),
    );

    const secondaryActions = h("div", { className: "pl-header-actions" });
    if (view === "editor") {
      const triggerCount = draft.triggers.length;
      secondaryActions.appendChild(
        h("button", {
          className: "pl-btn pl-btn-ghost",
          attrs: { type: "button", title: "Configure schedule and webhook triggers" },
          textContent: triggerCount > 0 ? `Triggers (${triggerCount})` : "Triggers",
          on: { click: () => this.openTriggers() },
        }),
      );
      secondaryActions.appendChild(
        h("button", {
          className: "pl-btn pl-btn-ghost",
          attrs: { type: "button", title: "Save changes (⌘S)" },
          textContent: "Save",
          on: { click: () => this.handleSave() },
        }),
      );
      secondaryActions.appendChild(
        h("button", {
          className: "pl-btn pl-btn-ghost danger",
          attrs: { type: "button", title: "Delete this workflow" },
          textContent: "Delete",
          on: { click: () => this.handleDelete() },
        }),
      );
    }

    const tabRow = h("div", { className: "pl-tab-row" }, tabs, secondaryActions);

    this.canvasToolbar.appendChild(heading);
    this.canvasToolbar.appendChild(tabRow);
  }

  private renderRunHeader(run: RunState): void {
    clear(this.canvasToolbar);

    const pipelineId = run.pipelineId;
    const sameAsCurrentPipeline = this.pipelines.some((p) => p.id === pipelineId);
    const runCount = this.runs.filter((r) => r.pipelineId === pipelineId).length;
    const startedDate = new Date(run.startedAtMs);
    const dateText = startedDate.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const timeText = startedDate.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const duration = run.endedAtMs && run.startedAtMs
      ? `${Math.round((run.endedAtMs - run.startedAtMs) / 1000)}s`
      : "";
    const subtitleParts = [`Run · ${dateText} · ${timeText}`];
    if (duration) subtitleParts.push(duration);
    const subtitleText = subtitleParts.join(" · ");

    const isLive = run.status === "running" || run.status === "paused-needs-input";

    const primaryAction = isLive
      ? h("button", {
          className: "pl-btn pl-btn-run danger",
          attrs: { type: "button", title: "Stop this run" },
          innerHTML: `<span class="pl-btn-icon">${ICON_PLAY}</span><span>Stop run</span>`,
          on: { click: () => this.deps.send({ type: "killRun", runId: run.runId }) },
        })
      : null;

    const awaitingApproval =
      run.status === "paused-needs-input" &&
      run.blocks.some(
        (b) =>
          b.status === "stuck" &&
          run.pipelineSnapshot.blocks.find((d) => d.id === b.blockId)?.kind === "approval",
      );
    const continueAction = awaitingApproval
      ? h("button", {
          className: "pl-btn pl-btn-run",
          attrs: { type: "button", title: "Approve and continue the run" },
          innerHTML: `<span class="pl-btn-icon">${ICON_PLAY}</span><span>Continue</span>`,
          on: { click: () => this.deps.send({ type: "resumeRun", runId: run.runId }) },
        })
      : null;

    const statusPill = h("span", {
      className: `pl-status-pill pl-status-${run.status}`,
      textContent: run.status,
    });

    const heading = h(
      "div",
      { className: "pl-header-row" },
      h(
        "div",
        { className: "pl-header-title" },
        h("div", { className: "pl-header-icon", innerHTML: ICON_ZAP }),
        h(
          "div",
          { className: "pl-header-title-text" },
          h(
            "div",
            { className: "pl-header-name-row" },
            h("div", { className: "pl-name-static", textContent: run.pipelineSnapshot.name }),
            statusPill,
          ),
          h("div", { className: "pl-header-subtitle", textContent: subtitleText }),
        ),
      ),
      continueAction,
      primaryAction,
    );

    const pipelineDraft = this.pipelines.find((p) => p.id === pipelineId);
    const navigateToView = (view: PipelineView): void => {
      if (!pipelineDraft) return;
      this.selection = { kind: "pipeline", draft: pipelineDraft, dirty: false, view };
      this.panel = { kind: "none" };
      this.renderSidebar();
      this.renderEditor();
      this.renderPanel();
    };

    const tabs = h(
      "div",
      { className: "pl-view-tabs" },
      h("button", {
        className: "pl-view-tab",
        attrs: {
          type: "button",
          role: "tab",
          "aria-selected": "false",
          title: sameAsCurrentPipeline ? "Open the workflow definition" : "Workflow no longer exists",
        },
        textContent: "Definition",
        on: { click: () => navigateToView("editor") },
      }),
      h(
        "button",
        {
          className: "pl-view-tab active",
          attrs: { type: "button", role: "tab", "aria-selected": "true", title: "Back to runs list" },
          on: { click: () => navigateToView("runs") },
        },
        h("span", { textContent: "Runs" }),
        runCount > 0
          ? h("span", { className: "pl-view-tab-badge", textContent: String(runCount) })
          : null,
      ),
    );

    const secondaryActions = h("div", { className: "pl-header-actions" });
    if (sameAsCurrentPipeline) {
      secondaryActions.appendChild(
        h("button", {
          className: "pl-btn pl-btn-ghost",
          attrs: { type: "button", title: "Back to runs list" },
          textContent: "← Back to runs",
          on: { click: () => navigateToView("runs") },
        }),
      );
    }

    const tabRow = h("div", { className: "pl-tab-row" }, tabs, secondaryActions);

    this.canvasToolbar.appendChild(heading);
    this.canvasToolbar.appendChild(tabRow);

    if (run.status === "paused-needs-input") {
      this.canvasToolbar.appendChild(
        h("div", { className: "pl-header-banner" },
          h("span", { textContent: "Click the warning bubble below to open the worker's terminal and answer Claude's question." }),
        ),
      );
    }
  }

  private setPipelineView(view: PipelineView): void {
    if (this.selection.kind !== "pipeline") return;
    this.selection = { ...this.selection, view };
    this.renderEditor();
  }

  private renderStaticNode(
    kind: "start" | "end",
    label: string,
    sublabel: string,
    iconSvg: string,
    runState?: "active" | "completed" | "failed" | "interrupted",
  ): HTMLElement {
    const attrs: Record<string, string> = {};
    if (runState) attrs["data-run-state"] = runState;
    const sublabelEl = h("span", {
      className: "pl-node-label-kind",
      textContent: staticSublabel(kind, runState, sublabel),
    });
    const bubble = h("div", {
      className: `pl-node-bubble kind-${kind}`,
      innerHTML: iconSvg,
      attrs,
    });
    const node = h(
      "div",
      { className: "pl-node pl-static-node", attrs: { "data-pos": kind } },
      bubble,
      h(
        "div",
        { className: "pl-node-label" },
        h("span", { textContent: label }),
        sublabelEl,
      ),
    );
    staticNodeRefs.set(node, { bubbleEl: bubble, sublabelEl, defaultSublabel: sublabel, kind });
    return node;
  }

  private renderBlockNode(block: Block, runState?: RunBlockState): HTMLElement {
    const isRunView = !!runState;
    const isSelectedInspector = this.panel.kind === "inspector" && this.panel.blockId === block.id;
    const isSelectedRunDetail = this.panel.kind === "run-block-detail" && this.panel.blockId === block.id;
    const meta = blockNodeMeta(block);
    const isAnchorCandidate = !isRunView && this.isLoopAnchorCandidate(block.id);
    const isActiveLoopBeingDefined = !isRunView && this.loopDefineMode === block.id;

    let sublabel = meta.sublabel;
    if (block.kind === "loop") {
      const targetName = block.loopBackToBlockId
        ? (this.findBlockName(block.loopBackToBlockId) ?? "missing block")
        : "target not set";
      sublabel = `Loops back to ${targetName} · max ${block.maxIterations}`;
    }

    const classes = ["pl-node-bubble", `kind-${meta.cssKind}`, "clickable"];
    if (isSelectedInspector || isSelectedRunDetail) classes.push("selected");
    if (isAnchorCandidate) classes.push("anchor-candidate");
    if (isActiveLoopBeingDefined) classes.push("loop-defining");

    const bubbleAttrs: Record<string, string> = {
      role: "button",
      "aria-label": `${isRunView ? "View" : "Edit"} ${block.name || meta.kindLabel}`,
      "data-block-id": block.id,
    };
    if (runState) bubbleAttrs["data-status"] = runState.status;

    const bubble = h("div", {
      className: classes.join(" "),
      innerHTML: meta.icon,
      on: {
        click: () => {
          if (this.loopDefineMode) return;
          if (isRunView) {
            if (runState?.runId && block.kind !== "parallel") {
              this.deps.send({
                type: "revealSession",
                runId: runState.runId,
                blockId: block.id,
                target: { kind: "self" },
                sessionId: runState.sessionId,
              });
            }
            this.openRunBlockDetail(block.id);
          } else {
            this.openInspector(block.id);
          }
        },
      },
      attrs: bubbleAttrs,
    });

    const iterationBadge = isRunView && block.kind === "loop" && runState && runState.iterations > 0 && runState.loopMaxIterations
      ? h("div", {
          className: `pl-iteration-badge${runState.status === "running" ? " iterating" : ""}`,
          textContent: `${runState.iterations}/${runState.loopMaxIterations}`,
          attrs: { title: `Loop iteration ${runState.iterations} of ${runState.loopMaxIterations}` },
        })
      : null;

    return h(
      "div",
      { className: "pl-node", attrs: { "data-block-id": block.id } },
      h(
        "div",
        { className: "pl-node-bubble-wrap" },
        bubble,
        iterationBadge,
        isRunView ? null : this.renderRemoveButton(block.id, `Remove ${meta.kindLabel.toLowerCase()}`),
        isAnchorCandidate ? this.renderAnchorDot(block.id) : null,
      ),
      h(
        "div",
        { className: "pl-node-label" },
        h("span", { textContent: block.name || `Untitled ${meta.kindLabel.toLowerCase()}` }),
        h("span", { className: "pl-node-label-kind", textContent: sublabel }),
        runState
          ? h("span", {
              className: `pl-status-badge pl-status-${runState.status}`,
              textContent: runState.status,
              style: { marginTop: "4px", display: "inline-block" },
            })
          : null,
      ),
    );
  }

  private renderAnchorDot(blockId: string): HTMLElement {
    return h("button", {
      className: "pl-anchor-dot",
      attrs: { type: "button", title: "Click to loop back to this block", "aria-label": "Set as loop-back target" },
      on: {
        click: (e) => {
          e.stopPropagation();
          this.pickLoopTarget(blockId);
        },
      },
    });
  }

  private drawLoopArrows(): void {
    if (!this.currentStack) return;
    const stack = this.currentStack;

    stack.querySelectorAll(".pl-loop-arrow").forEach((el) => el.remove());

    let blocks: readonly Block[];
    if (this.selection.kind === "pipeline") {
      blocks = this.selection.draft.blocks;
    } else if (this.selection.kind === "run" && this.selection.latest) {
      blocks = this.selection.latest.pipelineSnapshot.blocks;
    } else {
      return;
    }

    const loopsWithTargets = blocks.filter(
      (b): b is LoopBlock => b.kind === "loop" && b.loopBackToBlockId !== null,
    );
    if (loopsWithTargets.length === 0) return;

    const stackBox = stack.getBoundingClientRect();
    const z = this.zoom || 1;
    const stackWidth = stackBox.width / z;
    const stackHeight = stackBox.height / z;

    let leftmostX = Infinity;
    for (const child of Array.from(stack.children)) {
      if ((child as Element).tagName.toLowerCase() === "svg") continue;
      const el = child as HTMLElement;
      const r = el.getBoundingClientRect();
      const left = (r.left - stackBox.left) / z;
      if (left < leftmostX) leftmostX = left;
    }
    if (!Number.isFinite(leftmostX)) leftmostX = 0;

    const railMargin = 64;
    const railX = leftmostX - railMargin;
    const radius = 14;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("pl-loop-arrow");
    svg.setAttribute("width", String(stackWidth));
    svg.setAttribute("height", String(stackHeight));
    svg.setAttribute("viewBox", `0 0 ${stackWidth} ${stackHeight}`);

    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", "pl-loop-arrowhead");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "8");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto-start-reverse");
    const arrowPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    arrowPath.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    arrowPath.setAttribute("fill", "#14b8a6");
    marker.appendChild(arrowPath);
    defs.appendChild(marker);
    svg.appendChild(defs);

    for (const loop of loopsWithTargets) {
      const sourceEl = stack.querySelector(`[data-block-id="${loop.id}"] .pl-node-bubble`) as HTMLElement | null;
      const targetEl = stack.querySelector(`[data-block-id="${loop.loopBackToBlockId}"] .pl-node-bubble`) as HTMLElement | null;
      if (!sourceEl || !targetEl) continue;

      const sr = sourceEl.getBoundingClientRect();
      const tr = targetEl.getBoundingClientRect();

      const sourceLeft = (sr.left - stackBox.left) / z;
      const sourceY = (sr.top + sr.height / 2 - stackBox.top) / z;
      const targetLeft = (tr.left - stackBox.left) / z;
      const targetY = (tr.top + tr.height / 2 - stackBox.top) / z;

      const d = [
        `M ${sourceLeft - 4} ${sourceY}`,
        `L ${railX + radius} ${sourceY}`,
        `Q ${railX} ${sourceY} ${railX} ${sourceY - radius}`,
        `L ${railX} ${targetY + radius}`,
        `Q ${railX} ${targetY} ${railX + radius} ${targetY}`,
        `L ${targetLeft - 6} ${targetY}`,
      ].join(" ");

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("stroke", "#14b8a6");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      path.setAttribute("marker-end", "url(#pl-loop-arrowhead)");
      svg.appendChild(path);

      const labelG = document.createElementNS("http://www.w3.org/2000/svg", "g");
      const labelY = (sourceY + targetY) / 2;
      const labelText = `Loop · max ${loop.maxIterations}`;
      const labelWidth = labelText.length * 6.5 + 16;
      const rectEl = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rectEl.setAttribute("x", String(railX - labelWidth / 2));
      rectEl.setAttribute("y", String(labelY - 10));
      rectEl.setAttribute("width", String(labelWidth));
      rectEl.setAttribute("height", "20");
      rectEl.setAttribute("rx", "10");
      rectEl.setAttribute("fill", "#0b0b0e");
      rectEl.setAttribute("stroke", "#14b8a6");
      rectEl.setAttribute("stroke-width", "1");
      const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
      textEl.setAttribute("x", String(railX));
      textEl.setAttribute("y", String(labelY + 4));
      textEl.setAttribute("text-anchor", "middle");
      textEl.setAttribute("fill", "#5eead4");
      textEl.setAttribute("font-size", "11");
      textEl.setAttribute("font-weight", "600");
      textEl.setAttribute("font-family", "var(--ct-font)");
      textEl.textContent = labelText;
      labelG.appendChild(rectEl);
      labelG.appendChild(textEl);
      svg.appendChild(labelG);
    }

    stack.appendChild(svg);
  }

  private renderRemoveButton(blockId: string, label: string): HTMLElement {
    return h("button", {
      className: "pl-node-remove",
      attrs: { type: "button", title: label, "aria-label": label },
      textContent: "−",
      on: {
        click: (e) => {
          e.stopPropagation();
          this.removeBlock(blockId);
        },
      },
    });
  }

  private renderBlockRowWithOrch(blockNode: HTMLElement, status?: string): HTMLElement {
    return h(
      "div",
      { className: "pl-block-row" },
      blockNode,
      this.renderOrchestratorSatellite(status),
    );
  }

  private renderOrchestratorSatellite(status?: string): HTMLElement {
    const attrs: Record<string, string> = { title: "Orchestrator: judges this step." };
    if (status) attrs["data-status"] = status;
    const bubble = h("div", {
      className: "pl-mini-bubble",
      innerHTML: ICON_ORCHESTRATOR,
      attrs,
    });
    return h(
      "div",
      { className: "pl-orch-satellite" },
      h("div", { className: "pl-orch-line" }),
      h(
        "div",
        { className: "pl-mini-node" },
        bubble,
        h("div", { className: "pl-mini-label", textContent: "Orchestrator" }),
      ),
    );
  }

  private renderParallelExpanded(block: ParallelBlock, runState?: RunBlockState): HTMLElement {
    const isRunView = !!runState;
    const container = h("div", { className: "pl-parallel-block", attrs: { "data-block-id": block.id } });

    container.appendChild(this.renderParallelHeaderNode(block, runState));
    container.appendChild(this.renderConnector(null));

    const branchesRow = h("div", { className: "pl-parallel-branches" });
    block.workers.forEach((worker) => {
      branchesRow.appendChild(this.renderParallelWorkerColumn(block, worker, runState));
    });
    if (!isRunView) {
      branchesRow.appendChild(
        h("button", {
          className: "pl-parallel-add-branch",
          attrs: { type: "button", title: "Add a parallel worker" },
          innerHTML: ICON_PLUS,
          on: { click: () => this.addParallelWorker(block.id) },
        }),
      );
    }
    container.appendChild(branchesRow);

    container.appendChild(this.renderConnector(null));
    container.appendChild(
      this.renderBlockRowWithOrch(
        this.renderMergerNode(block, runState),
        runState ? orchStatusFor(runState.status) : undefined,
      ),
    );

    return container;
  }

  private renderParallelCounter(runState: RunBlockState): HTMLElement | null {
    const done = runState.parallelDoneCount ?? 0;
    const total = runState.parallelTotalCount ?? 0;
    if (total === 0) return null;
    const allDone = done === total;
    return h(
      "span",
      {
        className: "pl-parallel-counter",
        attrs: allDone ? { "data-state": "done" } : {},
      },
      allDone ? null : h("span", { className: "pl-spinner-dot" }),
      h("span", { textContent: `${done}/${total} workers done` }),
    );
  }

  private renderParallelHeaderNode(block: ParallelBlock, runState?: RunBlockState): HTMLElement {
    const isRunView = !!runState;
    const isSelectedInspector = this.panel.kind === "inspector" && this.panel.blockId === block.id;
    const isSelectedRunDetail = this.panel.kind === "run-block-detail" && this.panel.blockId === block.id;
    const isAnchorCandidate = !isRunView && this.isLoopAnchorCandidate(block.id);
    const classes = ["pl-node-bubble", "kind-parallel", "clickable"];
    if (isSelectedInspector || isSelectedRunDetail) classes.push("selected");
    if (isAnchorCandidate) classes.push("anchor-candidate");

    const bubbleAttrs: Record<string, string> = {
      role: "button",
      "aria-label": `${isRunView ? "View" : "Edit"} ${block.name || "parallel"}`,
      "data-block-id": block.id,
    };
    if (runState) bubbleAttrs["data-status"] = runState.status;

    const bubble = h("div", {
      className: classes.join(" "),
      innerHTML: ICON_PARALLEL,
      on: {
        click: () => {
          if (this.loopDefineMode) return;
          if (isRunView) this.openRunBlockDetail(block.id);
          else this.openInspector(block.id);
        },
      },
      attrs: bubbleAttrs,
    });
    return h(
      "div",
      { className: "pl-node", attrs: { "data-block-id": block.id } },
      h(
        "div",
        { className: "pl-node-bubble-wrap" },
        bubble,
        isRunView ? null : this.renderRemoveButton(block.id, "Remove parallel block"),
        isAnchorCandidate ? this.renderAnchorDot(block.id) : null,
      ),
      h(
        "div",
        { className: "pl-node-label" },
        h("span", { textContent: block.name || "Parallel split" }),
        h(
          "span",
          { className: "pl-node-label-kind" },
          h("span", { textContent: `Parallel · ${block.workers.length} worker${block.workers.length === 1 ? "" : "s"}` }),
          runState ? this.renderParallelCounter(runState) : null,
        ),
      ),
    );
  }

  private renderParallelWorkerColumn(block: ParallelBlock, worker: WorkerBlock, runState?: RunBlockState): HTMLElement {
    const isRunView = !!runState;
    const isSelectedInspector = this.panel.kind === "inspector" && this.panel.blockId === block.id;
    const isSelectedRunDetail = this.panel.kind === "run-block-detail" && this.panel.blockId === block.id;
    const workerStatus = runState?.parallelWorkerStatuses?.get(worker.id);
    const isStuck = workerStatus === "stuck";
    const isFailed = workerStatus === "failed";
    const bubbleAttrs: Record<string, string> = {
      role: "button",
      "aria-label": `${isRunView ? "View" : "Edit"} ${worker.name}`,
      "data-worker-id": worker.id,
    };
    if (workerStatus) bubbleAttrs["data-status"] = workerStatus;
    else if (runState) bubbleAttrs["data-status"] = runState.status;
    if (isStuck) bubbleAttrs["title"] = "Claude is waiting for your reply — click to open the terminal";
    const classes = ["pl-node-bubble", "kind-worker", "clickable"];
    if (isSelectedInspector || isSelectedRunDetail) classes.push("selected");
    if (isStuck) classes.push("needs-input");
    if (isFailed) classes.push("failed");
    const bubble = h("div", {
      className: classes.join(" "),
      innerHTML: isStuck ? ICON_WARNING : ICON_WORKER,
      on: {
        click: () => {
          if (isRunView && runState?.runId) {
            const workerSessionId = runState.parallelWorkerSessionIds?.get(worker.id) ?? null;
            this.deps.send({
              type: "revealSession",
              runId: runState.runId,
              blockId: block.id,
              target: { kind: "parallel-worker", workerBlockId: worker.id },
              sessionId: workerSessionId,
            });
            this.openRunBlockDetail(block.id);
            return;
          }
          this.openInspector(block.id);
        },
      },
      attrs: bubbleAttrs,
    });
    return h(
      "div",
      { className: "pl-parallel-branch" },
      h(
        "div",
        { className: "pl-node" },
        h(
          "div",
          { className: "pl-node-bubble-wrap" },
          bubble,
          isRunView
            ? null
            : h("button", {
                className: "pl-node-remove",
                attrs: { type: "button", title: "Remove this worker", "aria-label": "Remove parallel worker" },
                textContent: "−",
                on: {
                  click: (e) => {
                    e.stopPropagation();
                    this.removeParallelWorker(block.id, worker.id);
                  },
                },
              }),
        ),
        h(
          "div",
          { className: "pl-node-label" },
          h("span", { textContent: worker.name || "Worker" }),
          h("span", { className: "pl-node-label-kind", textContent: "Parallel worker" }),
        ),
      ),
    );
  }

  private renderMergerNode(block: ParallelBlock, runState?: RunBlockState): HTMLElement {
    const isRunView = !!runState;
    const isSelectedInspector = this.panel.kind === "inspector" && this.panel.blockId === block.id;
    const isSelectedRunDetail = this.panel.kind === "run-block-detail" && this.panel.blockId === block.id;
    const mergerStatus = runState?.mergerStatus;
    const isStuck = mergerStatus === "stuck";
    const isFailed = mergerStatus === "failed";
    const bubbleAttrs: Record<string, string> = {
      role: "button",
      "aria-label": `${isRunView ? "View" : "Edit"} merger`,
    };
    if (mergerStatus) bubbleAttrs["data-status"] = mergerStatus;
    else if (runState) bubbleAttrs["data-status"] = runState.status;
    if (isStuck) bubbleAttrs["title"] = "Claude is waiting for your reply — click to open the merger's terminal";
    const classes = ["pl-node-bubble", "kind-merger", "clickable"];
    if (isSelectedInspector || isSelectedRunDetail) classes.push("selected");
    if (isStuck) classes.push("needs-input");
    if (isFailed) classes.push("failed");
    const bubble = h("div", {
      className: classes.join(" "),
      innerHTML: isStuck ? ICON_WARNING : ICON_MERGER,
      on: {
        click: () => {
          if (isRunView && runState?.runId) {
            this.deps.send({
              type: "revealSession",
              runId: runState.runId,
              blockId: block.id,
              target: { kind: "merger" },
              sessionId: runState.mergerSessionId ?? null,
            });
            this.openRunBlockDetail(block.id);
            return;
          }
          this.openInspector(block.id);
        },
      },
      attrs: bubbleAttrs,
    });
    return h(
      "div",
      { className: "pl-node" },
      bubble,
      h(
        "div",
        { className: "pl-node-label" },
        h("span", { textContent: "Merger" }),
        h("span", { className: "pl-node-label-kind", textContent: "Combine parallel outputs" }),
      ),
    );
  }

  private renderConnector(insert: { insertIndex: number } | null): HTMLElement {
    const connector = h("div", {
      className: insert ? "pl-connector" : "pl-connector short",
    });
    if (insert) {
      const btn = h(
        "button",
        {
          className: "pl-insert-btn",
          attrs: { type: "button", title: "Insert block here" },
          innerHTML: ICON_PLUS,
          on: { click: () => this.openLibraryAt(insert.insertIndex) },
        },
      );
      if (this.panel.kind === "library" && this.panel.insertAtIndex === insert.insertIndex) {
        btn.classList.add("expanded");
      }
      connector.appendChild(btn);
    }
    return connector;
  }

  private handleSelectRun(runId: RunId): void {
    this.selection = { kind: "run", runId, latest: null };
    this.panel = { kind: "none" };
    this.deps.send({ type: "loadRun", runId });
    this.renderSidebar();
    this.renderRunLoading();
    this.renderPanel();
  }

  private renderRunLoading(): void {
    clear(this.canvasToolbar);
    clear(this.canvasEl);
    this.currentStack = null;
    this.canvasEl.appendChild(
      h(
        "div",
        { className: "pl-empty" },
        h("div", { className: "pl-empty-title", textContent: "Loading run…" }),
      ),
    );
  }

  private renderRunDetail(run: RunState): void {
    this.renderRunHeader(run);
    const signature = computeRunSignature(run);
    if (signature === this.renderedRunSignature && this.currentStack) {
      this.updateRunInPlace(run);
      return;
    }
    clear(this.canvasEl);
    const stack = h("div", { className: "pl-canvas-stack" });
    stack.appendChild(this.renderStaticNode("start", "Start", "Workflow entry", ICON_START, startEndState(run.status, "start")));
    stack.appendChild(this.renderConnector(null));

    run.blocks.forEach((blockRun, index) => {
      const definition = run.pipelineSnapshot.blocks[index];
      if (!definition) return;
      const runState = buildRunBlockState(run.runId, blockRun, definition);
      if (definition.kind === "parallel") {
        stack.appendChild(this.renderParallelExpanded(definition, runState));
      } else {
        stack.appendChild(
          this.renderBlockRowWithOrch(
            this.renderBlockNode(definition, runState),
            orchStatusFor(blockRun.status),
          ),
        );
      }
      stack.appendChild(this.renderConnector(null));
    });

    stack.appendChild(this.renderStaticNode("end", "End", "Workflow complete", ICON_END, startEndState(run.status, "end")));
    this.canvasEl.appendChild(stack);
    this.currentStack = stack;
    this.renderedRunSignature = signature;
    this.applyZoom();
    requestAnimationFrame(() => this.drawLoopArrows());
  }

  private updateRunInPlace(run: RunState): void {
    const stack = this.currentStack;
    if (!stack) return;

    this.updateStaticNodeState(stack.querySelector(".pl-static-node[data-pos=\"start\"]"), startEndState(run.status, "start"));
    this.updateStaticNodeState(stack.querySelector(".pl-static-node[data-pos=\"end\"]"), startEndState(run.status, "end"));

    run.blocks.forEach((blockRun, index) => {
      const definition = run.pipelineSnapshot.blocks[index];
      if (!definition) return;
      const runState = buildRunBlockState(run.runId, blockRun, definition);
      const node = stack.querySelector<HTMLElement>(`.pl-node[data-block-id="${CSS.escape(definition.id)}"]`);
      if (!node) return;
      if (definition.kind === "parallel") {
        this.updateParallelInPlace(definition, runState);
      } else {
        this.updateBlockNodeInPlace(node, definition, runState);
      }
      this.updateOrchSatelliteInPlace(node, orchStatusFor(blockRun.status));
    });
  }

  private updateStaticNodeState(el: Element | null, state: "active" | "completed" | "failed" | "interrupted" | undefined): void {
    if (!el) return;
    const refs = staticNodeRefs.get(el as HTMLElement);
    if (!refs) return;
    if (state) refs.bubbleEl.setAttribute("data-run-state", state);
    else refs.bubbleEl.removeAttribute("data-run-state");
    setIfChanged(refs.sublabelEl, staticSublabel(refs.kind, state, refs.defaultSublabel));
  }

  private updateBlockNodeInPlace(node: HTMLElement, definition: Block, runState: RunBlockState): void {
    const bubble = node.querySelector<HTMLElement>(`.pl-node-bubble[data-block-id="${CSS.escape(definition.id)}"]`);
    if (bubble) bubble.setAttribute("data-status", runState.status);
    const badge = node.querySelector<HTMLElement>(".pl-node-label .pl-status-badge");
    if (badge) {
      badge.className = `pl-status-badge pl-status-${runState.status}`;
      setIfChanged(badge, runState.status);
    }
    if (definition.kind === "loop" && runState.loopMaxIterations !== undefined) {
      const wrap = node.querySelector<HTMLElement>(".pl-node-bubble-wrap");
      const existing = wrap?.querySelector<HTMLElement>(".pl-iteration-badge");
      const wantsBadge = runState.iterations > 0;
      if (wantsBadge) {
        const text = `${runState.iterations}/${runState.loopMaxIterations}`;
        if (existing) {
          existing.className = `pl-iteration-badge${runState.status === "running" ? " iterating" : ""}`;
          setIfChanged(existing, text);
        } else if (wrap) {
          wrap.appendChild(h("div", {
            className: `pl-iteration-badge${runState.status === "running" ? " iterating" : ""}`,
            textContent: text,
            attrs: { title: `Loop iteration ${runState.iterations} of ${runState.loopMaxIterations}` },
          }));
        }
      } else if (existing) {
        existing.remove();
      }
    }
  }

  private updateParallelInPlace(block: ParallelBlock, runState: RunBlockState): void {
    const stack = this.currentStack;
    if (!stack) return;
    const wrapper = stack.querySelector<HTMLElement>(`.pl-parallel-block[data-block-id="${CSS.escape(block.id)}"]`);
    if (!wrapper) return;
    const headerBubble = wrapper.querySelector<HTMLElement>(`.pl-node-bubble.kind-parallel[data-block-id="${CSS.escape(block.id)}"]`);
    if (headerBubble) headerBubble.setAttribute("data-status", runState.status);

    block.workers.forEach((worker) => {
      const status = runState.parallelWorkerStatuses?.get(worker.id);
      const bubble = wrapper.querySelector<HTMLElement>(`.pl-node-bubble[data-worker-id="${CSS.escape(worker.id)}"]`);
      if (!bubble) return;
      bubble.setAttribute("data-status", status ?? runState.status);
      bubble.classList.toggle("needs-input", status === "stuck");
      bubble.classList.toggle("failed", status === "failed");
    });

    const merger = wrapper.querySelector<HTMLElement>(".pl-node-bubble.kind-merger");
    if (merger) {
      merger.setAttribute("data-status", runState.mergerStatus ?? runState.status);
      merger.classList.toggle("needs-input", runState.mergerStatus === "stuck");
      merger.classList.toggle("failed", runState.mergerStatus === "failed");
    }
  }

  private updateOrchSatelliteInPlace(node: HTMLElement, status: string | undefined): void {
    const row = node.closest(".pl-block-row") as HTMLElement | null;
    const mini = row?.querySelector<HTMLElement>(".pl-orch-satellite .pl-mini-bubble");
    if (!mini) return;
    if (status) mini.setAttribute("data-status", status);
    else mini.removeAttribute("data-status");
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
      this.renderRunBlockDetailPanel(this.panel.blockId, closeBtn);
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
    this.renderInspectorBody(block);
  }

  private renderSessionButtons(
    runId: RunId,
    definition: Block,
    blockRun: RunState["blocks"][number],
  ): HTMLElement[] {
    const buttons: HTMLElement[] = [];
    const make = (
      label: string,
      target: SessionTarget,
      sessionId: string | null,
      isStuck: boolean,
    ) =>
      h(
        "button",
        {
          className: `pl-session-btn${isStuck ? " pl-session-btn-urgent" : ""}`,
          attrs: { type: "button" },
          on: {
            click: (e: Event) => {
              e.stopPropagation();
              e.preventDefault();
              this.deps.send({
                type: "revealSession",
                runId,
                blockId: definition.id,
                target,
                sessionId,
              });
            },
          },
        },
        h("span", { className: "pl-session-btn-icon", innerHTML: ICON_PLAY }),
        h("span", { className: "pl-session-btn-label", textContent: label }),
      );

    if (definition.kind === "parallel" && blockRun.parallel) {
      for (const w of blockRun.parallel.workerRuns) {
        if (w.sessions.length === 0) continue;
        const workerDef = definition.workers.find((x) => x.id === w.workerBlockId);
        const name = workerDef?.name ?? String(w.workerBlockId);
        const isStuck = w.status === "stuck";
        const label = isStuck
          ? `Open "${name}" terminal · click to answer Claude`
          : `Open "${name}" session terminal`;
        const sessionId = w.sessions.at(-1)?.sessionId ?? null;
        buttons.push(make(label, { kind: "parallel-worker", workerBlockId: w.workerBlockId }, sessionId, isStuck));
      }
      if (blockRun.parallel.mergerSessions.length > 0) {
        const isStuck = blockRun.parallel.mergerStatus === "stuck";
        const label = isStuck ? "Open merger terminal · click to answer Claude" : "Open merger session terminal";
        const sessionId = blockRun.parallel.mergerSessions.at(-1)?.sessionId ?? null;
        buttons.push(make(label, { kind: "merger" }, sessionId, isStuck));
      }
      return buttons;
    }

    if (blockRun.sessions.length > 0) {
      const isStuck = blockRun.status === "stuck";
      const label = isStuck
        ? "Open Claude session terminal · click to answer"
        : "Open Claude session terminal";
      const sessionId = blockRun.sessions.at(-1)?.sessionId ?? null;
      buttons.push(make(label, { kind: "self" }, sessionId, isStuck));
    }
    return buttons;
  }

  private renderRunBlockDetailPanel(blockId: string, closeBtn: HTMLElement): void {
    if (this.selection.kind !== "run" || !this.selection.latest) {
      this.panel = { kind: "none" };
      this.canvasArea.classList.remove("panel-open");
      return;
    }
    const run = this.selection.latest;
    const blockRun = run.blocks.find((b) => b.blockId === blockId);
    const definition = run.pipelineSnapshot.blocks.find((b) => b.id === blockId);
    if (!blockRun || !definition) {
      this.panel = { kind: "none" };
      this.canvasArea.classList.remove("panel-open");
      return;
    }

    const meta = blockNodeMeta(definition);
    this.panelHeader.appendChild(
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "10px", minWidth: "0", flex: "1" } },
        h("div", {
          className: "pl-section-icon",
          innerHTML: meta.icon,
          style: { flexShrink: "0" },
        }),
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", minWidth: "0" } },
          h("div", { className: "pl-panel-title", textContent: definition.name || meta.kindLabel }),
          h("div", {
            style: { fontSize: "11px", color: "var(--ct-text-muted)", marginTop: "1px" },
            textContent: meta.kindLabel,
          }),
        ),
      ),
    );
    this.panelHeader.appendChild(closeBtn);

    const form = h("div", { className: "pl-inspector-form" });

    form.appendChild(
      this.inspectorSection(
        ICON_TAG,
        "Status",
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "10px" } },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "8px" } },
            h("span", {
              className: `pl-status-badge pl-status-${blockRun.status}`,
              textContent: blockRun.status,
            }),
            blockRun.endedAtMs && blockRun.startedAtMs
              ? h("span", {
                  className: "pl-field-hint",
                  style: { margin: "0" },
                  textContent: `${blockRun.endedAtMs - blockRun.startedAtMs}ms`,
                })
              : null,
          ),
          blockRun.stuckReason
            ? h("div", {
                className: "pl-field-hint",
                style: { color: "var(--ct-amber)" },
                textContent: `Stuck: ${blockRun.stuckReason}`,
              })
            : null,
          ...this.renderSessionButtons(run.runId, definition, blockRun),
          blockRun.failureReason
            ? h("div", {
                className: "pl-field-hint",
                style: { color: "var(--ct-red)" },
                textContent: `Failed: ${blockRun.failureReason}`,
              })
            : null,
        ),
      ),
    );

    const sessionsCount = blockRun.sessions.length;
    if (sessionsCount === 0) {
      form.appendChild(
        this.inspectorSection(
          ICON_SLIDERS,
          "Sessions",
          h("div", {
            className: "pl-field-hint",
            textContent: "This block hasn't been executed yet.",
          }),
        ),
      );
    } else {
      const sessionsBody = h("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } });
      blockRun.sessions.forEach((session) => {
        sessionsBody.appendChild(this.renderRunSessionCard(session, sessionsCount > 1));
      });
      form.appendChild(
        this.inspectorSection(ICON_SLIDERS, "Sessions", sessionsBody, {
          meta: sessionsCount === 1 ? "1 run" : `${sessionsCount} iterations`,
        }),
      );
    }

    this.panelBody.appendChild(form);
  }

  private renderRunSessionCard(
    session: import("../../../src/features/pipelines/domain/types").BlockSessionRecord,
    showIteration: boolean,
  ): HTMLElement {
    const card = h("div", {
      style: {
        background: "var(--ct-bg-2)",
        border: "1px solid var(--ct-border)",
        borderRadius: "var(--ct-radius-sm)",
        padding: "12px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      },
    });

    if (showIteration) {
      card.appendChild(
        h(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
          h("span", {
            style: {
              fontSize: "11px",
              fontWeight: "600",
              color: "var(--ct-claude)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            },
            textContent: `Iteration ${session.iteration + 1}`,
          }),
          h("span", {
            className: "pl-field-hint",
            style: { margin: "0" },
            textContent:
              session.endedAtMs && session.startedAtMs
                ? `${session.endedAtMs - session.startedAtMs}ms`
                : "—",
          }),
        ),
      );
    }

    if (session.summary) {
      card.appendChild(
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "Summary" }),
          h("div", {
            style: {
              fontSize: "12.5px",
              lineHeight: "1.55",
              color: "var(--ct-text-primary)",
              whiteSpace: "pre-wrap",
              fontFamily: "var(--ct-font)",
            },
            textContent: session.summary,
          }),
        ),
      );
    }

    card.appendChild(
      h(
        "div",
        { className: "pl-field" },
        h("label", { className: "pl-field-label", textContent: "Session ID" }),
        h(
          "div",
          { style: { display: "flex", gap: "8px", alignItems: "center" } },
          h("code", {
            style: {
              flex: "1",
              fontFamily: "var(--ct-mono)",
              fontSize: "11.5px",
              color: "var(--ct-text-secondary)",
              background: "var(--ct-bg-1)",
              padding: "6px 10px",
              borderRadius: "var(--ct-radius-sm)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            },
            textContent: session.sessionId,
          }),
          h("button", {
            className: "pl-btn",
            attrs: { type: "button", title: "Copy session ID" },
            textContent: "Copy",
            on: {
              click: () => {
                void navigator.clipboard?.writeText(session.sessionId);
                this.showNotice("info", "Session ID copied to clipboard.");
              },
            },
          }),
        ),
      ),
    );

    card.appendChild(
      h(
        "div",
        { className: "pl-field" },
        h("label", { className: "pl-field-label", textContent: "Prompt sent" }),
        h("pre", {
          style: {
            fontFamily: "var(--ct-mono)",
            fontSize: "11.5px",
            color: "var(--ct-text-secondary)",
            background: "var(--ct-bg-1)",
            padding: "10px 12px",
            borderRadius: "var(--ct-radius-sm)",
            border: "1px solid var(--ct-border)",
            maxHeight: "200px",
            overflow: "auto",
            whiteSpace: "pre-wrap",
            margin: "0",
          },
          textContent: session.promptSent,
        }),
      ),
    );

    return card;
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

  private renderInspectorBody(block: Block): void {
    switch (block.kind) {
      case "worker":
        this.renderWorkerInspector(block);
        return;
      case "parallel":
        this.renderParallelInspector(block);
        return;
      case "loop":
        this.renderLoopInspector(block);
        return;
      case "script":
        this.renderScriptInspector(block);
        return;
      case "http":
        this.renderHttpInspector(block);
        return;
      case "file":
        this.renderFileInspector(block);
        return;
      case "condition":
        this.renderConditionInspector(block);
        return;
      case "wait":
        this.renderWaitInspector(block);
        return;
      case "reduce":
        this.renderReduceInspector(block);
        return;
      case "llm":
        this.renderLlmInspector(block);
        return;
      case "evaluator":
        this.renderEvaluatorInspector(block);
        return;
      case "map":
        this.renderMapInspector(block);
        return;
      case "approval":
        this.renderApprovalInspector(block);
        return;
      default:
        assertNever(block);
    }
  }

  private renderWorkerInspector(block: WorkerBlock): void {
    const form = h("div", { className: "pl-inspector-form" });

    form.appendChild(
      this.inspectorSection(
        ICON_TAG,
        "Identity",
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "Name" }),
          this.bareTextInput(block.name, (v) =>
            this.updateBlock(block.id, (b) => ({ ...b, name: v })),
          ),
        ),
      ),
    );

    const promptTextarea = h("textarea", {
      className: "pl-block-prompt",
      attrs: { placeholder: "Prompt sent to this Claude session…" },
      on: {
        input: (e) => {
          const target = e.currentTarget as HTMLTextAreaElement;
          this.updateBlock(block.id, (b) => ({ ...b, prompt: target.value }));
        },
      },
    });
    promptTextarea.value = block.prompt;
    form.appendChild(this.inspectorSection(ICON_FILE_TEXT, "Prompt", promptTextarea));

    form.appendChild(
      this.inspectorSection(
        ICON_SLIDERS,
        "Execution",
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "12px" } },
          this.fieldModel(block.model, (v) => this.updateBlock(block.id, (b) => ({ ...b, model: v }))),
          this.fieldEffort(block.effort, (v) =>
            this.updateBlock(block.id, (b) => ({ ...b, effort: v })),
          ),
          this.fieldRestartToggle(
            block.restartEachIteration === true,
            (v) => this.updateBlock(block.id, (b) => ({ ...b, restartEachIteration: v ? true : undefined })),
          ),
        ),
      ),
    );

    form.appendChild(
      this.inspectorSection(
        ICON_TRASH,
        "Danger zone",
        h("button", {
          className: "pl-btn danger",
          attrs: { type: "button" },
          textContent: "Remove this block",
          on: { click: () => this.removeBlock(block.id) },
        }),
        { danger: true },
      ),
    );

    this.panelBody.appendChild(form);
  }

  private fieldRestartToggle(value: boolean, onChange: (v: boolean) => void): HTMLElement {
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
            ? "On — each loop iteration starts a FRESH claude session (no memory of prior iterations)."
            : "Off — each loop iteration RESUMES the prior session (claude remembers prior context).",
        }),
      ),
    );
  }

  private bareTextInput(value: string, onInput: (v: string) => void): HTMLInputElement {
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
  }

  private boundTextarea(
    value: string,
    placeholder: string,
    className: string,
    onInput: (v: string) => void,
  ): HTMLTextAreaElement {
    const ta = h("textarea", {
      className,
      attrs: { placeholder },
      on: { input: (e) => onInput((e.currentTarget as HTMLTextAreaElement).value) },
    });
    ta.value = value;
    return ta;
  }

  private identitySection(name: string, label: string, onChange: (v: string) => void): HTMLElement {
    return this.inspectorSection(
      ICON_TAG,
      "Identity",
      h(
        "div",
        { className: "pl-field" },
        h("label", { className: "pl-field-label", textContent: label }),
        this.bareTextInput(name, onChange),
      ),
    );
  }

  private outputVarField(value: string | null, onChange: (v: string | null) => void): HTMLElement {
    return h(
      "div",
      { className: "pl-field" },
      h("label", { className: "pl-field-label", textContent: "Store output in variable (optional)" }),
      this.bareTextInput(value ?? "", (v) => onChange(v.trim() === "" ? null : v.trim())),
      h("div", {
        className: "pl-field-hint",
        textContent: "Later blocks can reference it as ${vars.NAME}. Leave empty to skip.",
      }),
    );
  }

  private dangerRemoveSection(blockId: string): HTMLElement {
    return this.inspectorSection(
      ICON_TRASH,
      "Danger zone",
      h("button", {
        className: "pl-btn danger",
        attrs: { type: "button" },
        textContent: "Remove this block",
        on: { click: () => this.removeBlock(blockId) },
      }),
      { danger: true },
    );
  }

  private refHint(): HTMLElement {
    return h("div", {
      className: "pl-field-hint",
      textContent:
        "References: ${workspace} = run folder · ${vars.NAME} = a stored variable · ${blocks.ID.output} = an earlier block's output.",
    });
  }

  private renderScriptInspector(block: ScriptBlock): void {
    const form = h("div", { className: "pl-inspector-form" });
    form.appendChild(this.identitySection(block.name, "Name", (v) =>
      this.updateBlock(block.id, (b) => ({ ...(b as ScriptBlock), name: v })),
    ));

    form.appendChild(
      this.inspectorSection(
        ICON_SLIDERS,
        "Interpreter",
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "Run with" }),
          this.selectFromOptions(INTERPRETER_OPTIONS, block.interpreter, (v) =>
            this.updateBlock(block.id, (b) => ({ ...(b as ScriptBlock), interpreter: v as Interpreter })),
          ),
        ),
      ),
    );

    const code = this.boundTextarea(block.code, "echo \"Hello from ${workspace}\"", "pl-block-prompt pl-code", (v) =>
      this.updateBlock(block.id, (b) => ({ ...(b as ScriptBlock), code: v })),
    );
    form.appendChild(this.inspectorSection(ICON_SCRIPT, "Code", h("div", {}, code, this.refHint())));

    form.appendChild(
      this.inspectorSection(
        ICON_TAG,
        "Output",
        this.outputVarField(block.outputVar, (v) =>
          this.updateBlock(block.id, (b) => ({ ...(b as ScriptBlock), outputVar: v })),
        ),
      ),
    );

    form.appendChild(this.dangerRemoveSection(block.id));
    this.panelBody.appendChild(form);
  }

  private renderHttpInspector(block: HttpBlock): void {
    const form = h("div", { className: "pl-inspector-form" });
    form.appendChild(this.identitySection(block.name, "Name", (v) =>
      this.updateBlock(block.id, (b) => ({ ...(b as HttpBlock), name: v })),
    ));

    form.appendChild(
      this.inspectorSection(
        ICON_HTTP,
        "Request",
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "12px" } },
          h(
            "div",
            { className: "pl-field" },
            h("label", { className: "pl-field-label", textContent: "Method" }),
            this.selectFromOptions(HTTP_METHOD_OPTIONS, block.method, (v) =>
              this.updateBlock(block.id, (b) => ({ ...(b as HttpBlock), method: v as HttpMethod })),
            ),
          ),
          h(
            "div",
            { className: "pl-field" },
            h("label", { className: "pl-field-label", textContent: "URL" }),
            this.bareTextInput(block.url, (v) =>
              this.updateBlock(block.id, (b) => ({ ...(b as HttpBlock), url: v })),
            ),
            this.refHint(),
          ),
        ),
      ),
    );

    form.appendChild(this.inspectorSection(ICON_SLIDERS, "Headers", this.httpHeadersEditor(block)));

    const body = this.boundTextarea(block.body ?? "", "Request body (JSON, form data, …)", "pl-block-prompt", (v) =>
      this.updateBlock(block.id, (b) => ({ ...(b as HttpBlock), body: v === "" ? null : v })),
    );
    form.appendChild(this.inspectorSection(ICON_FILE_TEXT, "Body", body));

    form.appendChild(
      this.inspectorSection(
        ICON_TAG,
        "Output",
        this.outputVarField(block.outputVar, (v) =>
          this.updateBlock(block.id, (b) => ({ ...(b as HttpBlock), outputVar: v })),
        ),
      ),
    );

    form.appendChild(this.dangerRemoveSection(block.id));
    this.panelBody.appendChild(form);
  }

  private httpHeadersEditor(block: HttpBlock): HTMLElement {
    const container = h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } });
    block.headers.forEach((header, index) => {
      container.appendChild(
        h(
          "div",
          { style: { display: "flex", gap: "8px", alignItems: "center" } },
          this.bareTextInput(header.name, (v) =>
            this.updateBlock(block.id, (b) => ({
              ...(b as HttpBlock),
              headers: (b as HttpBlock).headers.map((hd, i) => (i === index ? { ...hd, name: v } : hd)),
            })),
          ),
          this.bareTextInput(header.value, (v) =>
            this.updateBlock(block.id, (b) => ({
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
                this.updateBlock(block.id, (b) => ({
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
            this.updateBlock(block.id, (b) => ({
              ...(b as HttpBlock),
              headers: [...(b as HttpBlock).headers, { name: "", value: "" }],
            })),
        },
      }),
    );
    return container;
  }

  private renderFileInspector(block: FileBlock): void {
    const form = h("div", { className: "pl-inspector-form" });
    form.appendChild(this.identitySection(block.name, "Name", (v) =>
      this.updateBlock(block.id, (b) => ({ ...(b as FileBlock), name: v })),
    ));

    form.appendChild(
      this.inspectorSection(
        ICON_FILE,
        "Operation",
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "12px" } },
          h(
            "div",
            { className: "pl-field" },
            h("label", { className: "pl-field-label", textContent: "Operation" }),
            this.selectFromOptions(FILE_OP_OPTIONS, block.operation, (v) =>
              this.updateBlock(block.id, (b) => ({ ...(b as FileBlock), operation: v as FileOperation })),
            ),
          ),
          h(
            "div",
            { className: "pl-field" },
            h("label", { className: "pl-field-label", textContent: "Path (relative to workspace)" }),
            this.bareTextInput(block.path, (v) =>
              this.updateBlock(block.id, (b) => ({ ...(b as FileBlock), path: v })),
            ),
          ),
        ),
      ),
    );

    if (block.operation === "write") {
      const content = this.boundTextarea(block.content, "File contents…", "pl-block-prompt", (v) =>
        this.updateBlock(block.id, (b) => ({ ...(b as FileBlock), content: v })),
      );
      form.appendChild(this.inspectorSection(ICON_FILE_TEXT, "Content", h("div", {}, content, this.refHint())));
    } else {
      form.appendChild(
        this.inspectorSection(
          ICON_TAG,
          "Output",
          this.outputVarField(block.outputVar, (v) =>
            this.updateBlock(block.id, (b) => ({ ...(b as FileBlock), outputVar: v })),
          ),
        ),
      );
    }

    form.appendChild(this.dangerRemoveSection(block.id));
    this.panelBody.appendChild(form);
  }

  private renderParallelInspector(block: ParallelBlock): void {
    const form = h("div", { className: "pl-inspector-form" });

    form.appendChild(
      this.inspectorSection(
        ICON_TAG,
        "Identity",
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "Block name" }),
          this.bareTextInput(block.name, (v) =>
            this.updateBlock(block.id, (b) => ({ ...(b as ParallelBlock), name: v })),
          ),
        ),
      ),
    );

    form.appendChild(
      this.inspectorSection(
        ICON_PARALLEL,
        "Parallel workers",
        this.renderParallelWorkersBody(block),
        { meta: `${block.workers.length}` },
      ),
    );

    const mergerGoalTextarea = h("textarea", {
      className: "pl-block-prompt",
      attrs: { placeholder: "Describe how to combine the branch results…" },
      on: {
        input: (e) => {
          const target = e.currentTarget as HTMLTextAreaElement;
          this.updateBlock(block.id, (b) => ({ ...(b as ParallelBlock), mergerGoal: target.value }));
        },
      },
    });
    mergerGoalTextarea.value = block.mergerGoal;
    const mergerBody = h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "12px" } },
      h(
        "div",
        { className: "pl-field" },
        h("label", { className: "pl-field-label", textContent: "Goal" }),
        mergerGoalTextarea,
      ),
      h(
        "div",
        { className: "pl-field" },
        h("label", { className: "pl-field-label", textContent: "Merger model" }),
        this.selectFromOptions(MODEL_OPTIONS, block.mergerModel, (v) =>
          this.updateBlock(block.id, (b) => ({ ...(b as ParallelBlock), mergerModel: v as ModelChoice })),
        ),
      ),
    );
    form.appendChild(this.inspectorSection(ICON_FILE_TEXT, "Merger", mergerBody));

    form.appendChild(
      this.inspectorSection(
        ICON_TRASH,
        "Danger zone",
        h("button", {
          className: "pl-btn danger",
          attrs: { type: "button" },
          textContent: "Remove this Parallel block",
          on: { click: () => this.removeBlock(block.id) },
        }),
        { danger: true },
      ),
    );

    this.panelBody.appendChild(form);
  }

  private renderParallelWorkersBody(block: ParallelBlock): HTMLElement {
    const body = h("div", { className: "pl-tabs-pane" });

    if (block.workers.length === 0) {
      body.appendChild(
        h("div", {
          className: "pl-field-hint",
          style: { padding: "12px 0" },
          textContent: "No parallel workers yet. Click + to add the first one.",
        }),
      );
      body.appendChild(this.renderAddWorkerButton(block.id));
      return body;
    }

    const activeId = this.getActiveParallelWorker(block);
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
              this.activeParallelWorker.set(block.id, worker.id);
              this.refreshInspectorOnly();
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
        on: { click: () => this.addParallelWorker(block.id) },
      }),
    );

    body.appendChild(tabStrip);
    body.appendChild(this.renderActiveParallelWorker(block, activeWorker));

    return body;
  }

  private renderActiveParallelWorker(parent: ParallelBlock, worker: WorkerBlock): HTMLElement {
    const editor = h("div", { className: "pl-tab-editor" });

    const nameInput = h("input", {
      className: "pl-field-input",
      attrs: { type: "text", placeholder: "Worker name" },
      on: {
        input: (e) => {
          const target = e.currentTarget as HTMLInputElement;
          this.updateParallelWorker(parent.id, worker.id, { name: target.value });
        },
      },
    });
    nameInput.value = worker.name;
    editor.appendChild(this.flatField("Name", nameInput));

    const promptInput = h("textarea", {
      className: "pl-block-prompt",
      attrs: { placeholder: "Prompt sent to this Claude session…" },
      on: {
        input: (e) => {
          const target = e.currentTarget as HTMLTextAreaElement;
          this.updateParallelWorker(parent.id, worker.id, { prompt: target.value });
        },
      },
    });
    promptInput.value = worker.prompt;
    editor.appendChild(this.flatField("Prompt", promptInput));

    const modelSelect = this.selectFromOptions(MODEL_OPTIONS, worker.model, (v) =>
      this.updateParallelWorker(parent.id, worker.id, { model: v as ModelChoice }),
    );
    const effortSelect = this.selectFromOptions(EFFORT_OPTIONS, worker.effort, (v) =>
      this.updateParallelWorker(parent.id, worker.id, { effort: v as EffortLevel }),
    );
    editor.appendChild(
      h(
        "div",
        { className: "pl-flat-row" },
        this.flatField("Model", modelSelect),
        this.flatField("Effort", effortSelect),
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
          on: { click: () => this.removeParallelWorker(parent.id, worker.id) },
        }),
      ),
    );

    return editor;
  }

  private renderAddWorkerButton(blockId: string): HTMLElement {
    return h("button", {
      className: "pl-add-row",
      attrs: { type: "button" },
      textContent: "+ Add parallel worker",
      on: { click: () => this.addParallelWorker(blockId) },
    });
  }

  private flatField(label: string, control: HTMLElement): HTMLElement {
    return h(
      "div",
      { className: "pl-field" },
      h("label", { className: "pl-field-label", textContent: label }),
      control,
    );
  }

  private getActiveParallelWorker(block: ParallelBlock): string {
    const stored = this.activeParallelWorker.get(block.id);
    if (stored && block.workers.some((w) => w.id === stored)) return stored;
    return block.workers[0]?.id ?? "";
  }

  private renderLoopInspector(block: LoopBlock): void {
    const form = h("div", { className: "pl-inspector-form" });

    form.appendChild(
      this.inspectorSection(
        ICON_TAG,
        "Identity",
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "Block name" }),
          this.bareTextInput(block.name, (v) =>
            this.updateBlock(block.id, (b) => ({ ...(b as LoopBlock), name: v })),
          ),
        ),
      ),
    );

    const targetName = this.findBlockName(block.loopBackToBlockId);
    const targetRow = h(
      "div",
      { className: "pl-field" },
      h("label", { className: "pl-field-label", textContent: "Loop back to" }),
      h(
        "div",
        { style: { display: "flex", gap: "8px", alignItems: "center" } },
        h("div", {
          className: "pl-field-input",
          style: {
            flex: "1",
            display: "flex",
            alignItems: "center",
            color: targetName ? "var(--ct-text-primary)" : "var(--ct-text-muted)",
            fontStyle: targetName ? "normal" : "italic",
          },
          textContent: targetName ?? "Not set — pick a target",
        }),
        h("button", {
          className: "pl-btn",
          attrs: { type: "button" },
          textContent: targetName ? "Change" : "Pick",
          on: { click: () => this.enterLoopDefineMode(block.id) },
        }),
      ),
      h("div", {
        className: "pl-field-hint",
        textContent: "Click Pick/Change, then click the green dot on a block earlier in the workflow.",
      }),
    );

    const goalTextarea = h("textarea", {
      className: "pl-block-prompt",
      attrs: { placeholder: "Describe what the loop should achieve…" },
      on: {
        input: (e) => {
          const target = e.currentTarget as HTMLTextAreaElement;
          this.updateBlock(block.id, (b) => ({ ...(b as LoopBlock), goal: target.value }));
        },
      },
    });
    goalTextarea.value = block.goal;
    const goalField = h(
      "div",
      { className: "pl-field" },
      h("label", { className: "pl-field-label", textContent: "Goal" }),
      goalTextarea,
      h("div", {
        className: "pl-field-hint",
        textContent: "The loop's evaluator session reads each iteration's results and checks them against this goal.",
      }),
    );

    const iterationsInput = h("input", {
      className: "pl-field-input",
      attrs: { type: "number", min: "1", max: "100" },
      on: {
        input: (e) => {
          const target = e.currentTarget as HTMLInputElement;
          const parsed = parseInt(target.value, 10);
          if (!Number.isFinite(parsed)) return;
          this.updateBlock(block.id, (b) => ({ ...(b as LoopBlock), maxIterations: Math.max(1, parsed) }));
        },
      },
    });
    iterationsInput.value = String(block.maxIterations);
    const iterationsField = h(
      "div",
      { className: "pl-field" },
      h("label", { className: "pl-field-label", textContent: "Max iterations (safety cap)" }),
      iterationsInput,
      h("div", {
        className: "pl-field-hint",
        textContent: "Hard cap. The evaluator may end earlier when the goal is met.",
      }),
    );

    const modelField = h(
      "div",
      { className: "pl-field" },
      h("label", { className: "pl-field-label", textContent: "Evaluator model" }),
      this.selectFromOptions(MODEL_OPTIONS, block.evaluatorModel, (v) =>
        this.updateBlock(block.id, (b) => ({ ...(b as LoopBlock), evaluatorModel: v as ModelChoice })),
      ),
      h("div", {
        className: "pl-field-hint",
        textContent: "The loop's own judge session. Fresh context each iteration.",
      }),
    );

    form.appendChild(
      this.inspectorSection(
        ICON_REPEAT,
        "Loop control",
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "14px" } },
          targetRow,
          goalField,
          iterationsField,
          modelField,
        ),
      ),
    );

    form.appendChild(
      this.inspectorSection(
        ICON_TRASH,
        "Danger zone",
        h("button", {
          className: "pl-btn danger",
          attrs: { type: "button" },
          textContent: "Remove this Loop block",
          on: { click: () => this.removeBlock(block.id) },
        }),
        { danger: true },
      ),
    );

    this.panelBody.appendChild(form);
  }

  private renderConditionInspector(block: ConditionBlock): void {
    const form = h("div", { className: "pl-inspector-form" });
    form.appendChild(this.identitySection(block.name, "Name", (v) =>
      this.updateBlock(block.id, (b) => ({ ...(b as ConditionBlock), name: v })),
    ));

    form.appendChild(
      this.inspectorSection(
        ICON_CONDITION,
        "Condition",
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "Expression (true = continue, false = skip ahead)" }),
          this.bareTextInput(block.expression, (v) =>
            this.updateBlock(block.id, (b) => ({ ...(b as ConditionBlock), expression: v })),
          ),
          h("div", {
            className: "pl-field-hint",
            textContent: 'Examples: ${vars.status} == done · ${vars.count} > 3 · ${blocks.review.output} contains LGTM · ${vars.flag}',
          }),
        ),
      ),
    );

    const laterBlocks = this.blocksAfter(block.id);
    form.appendChild(
      this.inspectorSection(
        ICON_SLIDERS,
        "When false, skip to",
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "Rejoin point" }),
          this.selectFromOptions(
            [{ id: "", label: "End of pipeline" }, ...laterBlocks.map((b) => ({ id: b.id, label: b.name }))],
            block.skipToBlockId ?? "",
            (v) => this.updateBlock(block.id, (b) => ({ ...(b as ConditionBlock), skipToBlockId: v === "" ? null : toBlockId(v) })),
          ),
          h("div", { className: "pl-field-hint", textContent: "Blocks between this condition and the rejoin point are skipped when the expression is false." }),
        ),
      ),
    );

    form.appendChild(this.dangerRemoveSection(block.id));
    this.panelBody.appendChild(form);
  }

  private renderWaitInspector(block: WaitBlock): void {
    const form = h("div", { className: "pl-inspector-form" });
    form.appendChild(this.identitySection(block.name, "Name", (v) =>
      this.updateBlock(block.id, (b) => ({ ...(b as WaitBlock), name: v })),
    ));

    const input = h("input", {
      className: "pl-field-input",
      attrs: { type: "number", min: "0", step: "100" },
      on: {
        input: (e) => {
          const n = Number((e.currentTarget as HTMLInputElement).value);
          this.updateBlock(block.id, (b) => ({ ...(b as WaitBlock), durationMs: Number.isFinite(n) && n >= 0 ? n : 0 }));
        },
      },
    });
    input.value = String(block.durationMs);
    form.appendChild(
      this.inspectorSection(
        ICON_WAIT,
        "Delay",
        h("div", { className: "pl-field" }, h("label", { className: "pl-field-label", textContent: "Duration (milliseconds)" }), input),
      ),
    );

    form.appendChild(this.dangerRemoveSection(block.id));
    this.panelBody.appendChild(form);
  }

  private renderReduceInspector(block: ReduceBlock): void {
    const form = h("div", { className: "pl-inspector-form" });
    form.appendChild(this.identitySection(block.name, "Name", (v) =>
      this.updateBlock(block.id, (b) => ({ ...(b as ReduceBlock), name: v })),
    ));

    form.appendChild(
      this.inspectorSection(
        ICON_REDUCE,
        "Input",
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "Input variable (its lines are the items)" }),
          this.bareTextInput(block.inputVar, (v) =>
            this.updateBlock(block.id, (b) => ({ ...(b as ReduceBlock), inputVar: v })),
          ),
        ),
      ),
    );

    form.appendChild(
      this.inspectorSection(
        ICON_SLIDERS,
        "Mode",
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "How to combine" }),
          this.selectFromOptions(REDUCE_MODE_OPTIONS, block.mode, (v) =>
            this.updateBlock(block.id, (b) => ({ ...(b as ReduceBlock), mode: v as ReduceMode })),
          ),
        ),
      ),
    );

    if (block.mode === "concat") {
      form.appendChild(
        this.inspectorSection(
          ICON_FILE_TEXT,
          "Separator",
          h(
            "div",
            { className: "pl-field" },
            h("label", { className: "pl-field-label", textContent: "Joined with (use \\n for newline)" }),
            this.bareTextInput(block.separator, (v) =>
              this.updateBlock(block.id, (b) => ({ ...(b as ReduceBlock), separator: v })),
            ),
          ),
        ),
      );
    } else {
      const goal = this.boundTextarea(block.mergerGoal, "How should the LLM synthesize the items?", "pl-block-prompt", (v) =>
        this.updateBlock(block.id, (b) => ({ ...(b as ReduceBlock), mergerGoal: v })),
      );
      form.appendChild(this.inspectorSection(ICON_FILE_TEXT, "Merger goal", goal));
      form.appendChild(
        this.inspectorSection(
          ICON_SLIDERS,
          "Model",
          this.fieldModel(block.mergerModel, (v) => this.updateBlock(block.id, (b) => ({ ...(b as ReduceBlock), mergerModel: v }))),
        ),
      );
    }

    form.appendChild(
      this.inspectorSection(
        ICON_TAG,
        "Output",
        this.outputVarField(block.outputVar, (v) =>
          this.updateBlock(block.id, (b) => ({ ...(b as ReduceBlock), outputVar: v })),
        ),
      ),
    );

    form.appendChild(this.dangerRemoveSection(block.id));
    this.panelBody.appendChild(form);
  }

  private renderLlmInspector(block: LlmBlock): void {
    const form = h("div", { className: "pl-inspector-form" });
    form.appendChild(this.identitySection(block.name, "Name", (v) =>
      this.updateBlock(block.id, (b) => ({ ...(b as LlmBlock), name: v })),
    ));

    const prompt = this.boundTextarea(block.prompt, "Prompt for a single Claude reply…", "pl-block-prompt", (v) =>
      this.updateBlock(block.id, (b) => ({ ...(b as LlmBlock), prompt: v })),
    );
    form.appendChild(this.inspectorSection(ICON_FILE_TEXT, "Prompt", h("div", {}, prompt, this.refHint())));

    form.appendChild(
      this.inspectorSection(
        ICON_SLIDERS,
        "Execution",
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "12px" } },
          this.fieldModel(block.model, (v) => this.updateBlock(block.id, (b) => ({ ...(b as LlmBlock), model: v }))),
          this.fieldEffort(block.effort, (v) => this.updateBlock(block.id, (b) => ({ ...(b as LlmBlock), effort: v }))),
        ),
      ),
    );

    form.appendChild(
      this.inspectorSection(
        ICON_TAG,
        "Output",
        this.outputVarField(block.outputVar, (v) =>
          this.updateBlock(block.id, (b) => ({ ...(b as LlmBlock), outputVar: v })),
        ),
      ),
    );

    form.appendChild(this.dangerRemoveSection(block.id));
    this.panelBody.appendChild(form);
  }

  private renderEvaluatorInspector(block: EvaluatorBlock): void {
    const form = h("div", { className: "pl-inspector-form" });
    form.appendChild(this.identitySection(block.name, "Name", (v) =>
      this.updateBlock(block.id, (b) => ({ ...(b as EvaluatorBlock), name: v })),
    ));

    const goal = this.boundTextarea(block.goal, "What must be true for the run to continue?", "pl-block-prompt", (v) =>
      this.updateBlock(block.id, (b) => ({ ...(b as EvaluatorBlock), goal: v })),
    );
    form.appendChild(this.inspectorSection(ICON_EVALUATOR, "Pass criteria", h("div", {}, goal, this.refHint())));

    form.appendChild(
      this.inspectorSection(
        ICON_SLIDERS,
        "Model",
        this.fieldModel(block.evaluatorModel, (v) => this.updateBlock(block.id, (b) => ({ ...(b as EvaluatorBlock), evaluatorModel: v }))),
      ),
    );

    form.appendChild(this.dangerRemoveSection(block.id));
    this.panelBody.appendChild(form);
  }

  private renderMapInspector(block: MapBlock): void {
    const form = h("div", { className: "pl-inspector-form" });
    form.appendChild(this.identitySection(block.name, "Name", (v) =>
      this.updateBlock(block.id, (b) => ({ ...(b as MapBlock), name: v })),
    ));

    form.appendChild(
      this.inspectorSection(
        ICON_MAP,
        "Iterate",
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "12px" } },
          h(
            "div",
            { className: "pl-field" },
            h("label", { className: "pl-field-label", textContent: "List variable (one item per line)" }),
            this.bareTextInput(block.listVar, (v) => this.updateBlock(block.id, (b) => ({ ...(b as MapBlock), listVar: v }))),
          ),
          h(
            "div",
            { className: "pl-field" },
            h("label", { className: "pl-field-label", textContent: "Item variable name" }),
            this.bareTextInput(block.itemVar, (v) => this.updateBlock(block.id, (b) => ({ ...(b as MapBlock), itemVar: v }))),
            h("div", { className: "pl-field-hint", textContent: "Each item is exposed to the prompt as ${vars.<name>}." }),
          ),
        ),
      ),
    );

    const prompt = this.boundTextarea(block.prompt, "Prompt run once per item…", "pl-block-prompt", (v) =>
      this.updateBlock(block.id, (b) => ({ ...(b as MapBlock), prompt: v })),
    );
    form.appendChild(this.inspectorSection(ICON_FILE_TEXT, "Per-item prompt", h("div", {}, prompt, this.refHint())));

    form.appendChild(
      this.inspectorSection(
        ICON_SLIDERS,
        "Execution",
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "12px" } },
          this.fieldModel(block.model, (v) => this.updateBlock(block.id, (b) => ({ ...(b as MapBlock), model: v }))),
          this.fieldEffort(block.effort, (v) => this.updateBlock(block.id, (b) => ({ ...(b as MapBlock), effort: v }))),
        ),
      ),
    );

    form.appendChild(
      this.inspectorSection(
        ICON_TAG,
        "Output",
        this.outputVarField(block.outputVar, (v) =>
          this.updateBlock(block.id, (b) => ({ ...(b as MapBlock), outputVar: v })),
        ),
      ),
    );

    form.appendChild(this.dangerRemoveSection(block.id));
    this.panelBody.appendChild(form);
  }

  private renderApprovalInspector(block: ApprovalBlock): void {
    const form = h("div", { className: "pl-inspector-form" });
    form.appendChild(this.identitySection(block.name, "Name", (v) =>
      this.updateBlock(block.id, (b) => ({ ...(b as ApprovalBlock), name: v })),
    ));

    const message = this.boundTextarea(block.message, "Message shown to the reviewer when the run pauses…", "pl-block-prompt", (v) =>
      this.updateBlock(block.id, (b) => ({ ...(b as ApprovalBlock), message: v })),
    );
    form.appendChild(this.inspectorSection(ICON_APPROVAL, "Approval prompt", h("div", {}, message, this.refHint())));

    form.appendChild(this.dangerRemoveSection(block.id));
    this.panelBody.appendChild(form);
  }

  private blocksAfter(blockId: string): readonly Block[] {
    if (this.selection.kind !== "pipeline") return [];
    const blocks = this.selection.draft.blocks;
    const idx = blocks.findIndex((b) => b.id === blockId);
    return idx < 0 ? [] : blocks.slice(idx + 1);
  }

  private inspectorSection(
    iconSvg: string,
    title: string,
    body: HTMLElement,
    opts?: { readonly meta?: string; readonly danger?: boolean },
  ): HTMLElement {
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

  private fieldModel(value: ModelChoice, onChange: (v: ModelChoice) => void): HTMLElement {
    return h(
      "div",
      { className: "pl-field" },
      h("label", { className: "pl-field-label", textContent: "Model" }),
      this.selectFromOptions(MODEL_OPTIONS, value, (v) => onChange(v as ModelChoice)),
    );
  }

  private fieldEffort(value: EffortLevel, onChange: (v: EffortLevel) => void): HTMLElement {
    return h(
      "div",
      { className: "pl-field" },
      h("label", { className: "pl-field-label", textContent: "Effort" }),
      this.selectFromOptions(EFFORT_OPTIONS, value, (v) => onChange(v as EffortLevel)),
      h("div", { className: "pl-field-hint", textContent: "Controls /effort level: Low → Max. Higher = deeper reasoning, more tokens." }),
    );
  }

  private selectFromOptions<T extends string>(
    options: readonly { readonly id: T; readonly label: string }[],
    value: T,
    onChange: (v: string) => void,
  ): HTMLSelectElement {
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
      select.appendChild(
        h("option", { attrs: { value: opt.id }, textContent: opt.label }),
      );
    }
    select.value = value;
    return select;
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
        const input = this.bareTextInput(trigger.token, (v) =>
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
        this.inspectorSection(
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
    body.appendChild(this.inspectorSection(ICON_PLAY, "Add a trigger", addRow));
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
    stack.appendChild(this.renderStaticNode("start", "Start", "Workflow entry", ICON_START));
    stack.appendChild(this.renderConnector({ insertIndex: 0 }));
    draft.blocks.forEach((block, index) => {
      if (block.kind === "parallel") {
        stack.appendChild(this.renderParallelExpanded(block));
      } else {
        stack.appendChild(this.renderBlockRowWithOrch(this.renderBlockNode(block)));
      }
      stack.appendChild(this.renderConnector({ insertIndex: index + 1 }));
    });
    stack.appendChild(this.renderStaticNode("end", "End", "Workflow complete", ICON_END));
    this.canvasEl.appendChild(stack);
    this.currentStack = stack;
    this.applyZoom();
    requestAnimationFrame(() => this.drawLoopArrows());
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
    this.renderInspectorBody(block);
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

interface BlockNodeMeta {
  readonly icon: string;
  readonly cssKind: string;
  readonly kindLabel: string;
  readonly sublabel: string;
}

const blockNodeMeta = (block: Block): BlockNodeMeta => {
  switch (block.kind) {
    case "worker":
      return { icon: ICON_WORKER, cssKind: "worker", kindLabel: "Worker", sublabel: "Worker" };
    case "parallel":
      return {
        icon: ICON_PARALLEL,
        cssKind: "parallel",
        kindLabel: "Parallel",
        sublabel: `Parallel · ${block.workers.length} worker${block.workers.length === 1 ? "" : "s"}`,
      };
    case "loop":
      return {
        icon: ICON_LOOP,
        cssKind: "loop",
        kindLabel: "Loop",
        sublabel: `Loop · max ${block.maxIterations}`,
      };
    case "script":
      return {
        icon: ICON_SCRIPT,
        cssKind: "script",
        kindLabel: "Script",
        sublabel: `Script · ${block.interpreter}`,
      };
    case "http":
      return {
        icon: ICON_HTTP,
        cssKind: "http",
        kindLabel: "HTTP",
        sublabel: `HTTP · ${block.method}`,
      };
    case "file":
      return {
        icon: ICON_FILE,
        cssKind: "file",
        kindLabel: "File",
        sublabel: `File · ${block.operation}`,
      };
    case "condition":
      return { icon: ICON_CONDITION, cssKind: "condition", kindLabel: "Condition", sublabel: "Condition · branch" };
    case "wait":
      return { icon: ICON_WAIT, cssKind: "wait", kindLabel: "Wait", sublabel: `Wait · ${block.durationMs}ms` };
    case "reduce":
      return { icon: ICON_REDUCE, cssKind: "reduce", kindLabel: "Reduce", sublabel: `Reduce · ${block.mode}` };
    case "llm":
      return { icon: ICON_LLM, cssKind: "llm", kindLabel: "LLM", sublabel: "LLM call" };
    case "evaluator":
      return { icon: ICON_EVALUATOR, cssKind: "evaluator", kindLabel: "Evaluator", sublabel: "Evaluator · gate" };
    case "map":
      return { icon: ICON_MAP, cssKind: "map", kindLabel: "Map", sublabel: `Map · \${vars.${block.listVar}}` };
    case "approval":
      return { icon: ICON_APPROVAL, cssKind: "approval", kindLabel: "Approval", sublabel: "Approval · human gate" };
    default:
      return assertNever(block);
  }
};

const createBlock = (kind: BlockKind): Block => {
  switch (kind) {
    case "worker":
      return defaultWorker("New worker");
    case "parallel":
      return {
        id: toBlockId(makeId("parallel")),
        kind: "parallel",
        name: "Parallel split",
        mergerGoal: "Combine the parallel outputs into a single coherent summary.",
        mergerModel: "claude-sonnet-4-6",
        workers: [defaultWorker("Worker 1"), defaultWorker("Worker 2")],
      };
    case "loop":
      return {
        id: toBlockId(makeId("loop")),
        kind: "loop",
        name: "Loop",
        loopBackToBlockId: null,
        goal: "",
        maxIterations: 5,
        evaluatorModel: "claude-sonnet-4-6",
      };
    case "script":
      return {
        id: toBlockId(makeId("script")),
        kind: "script",
        name: "Script",
        interpreter: "bash",
        code: "",
        outputVar: null,
      };
    case "http":
      return {
        id: toBlockId(makeId("http")),
        kind: "http",
        name: "HTTP request",
        method: "GET",
        url: "",
        headers: [],
        body: null,
        outputVar: null,
      };
    case "file":
      return {
        id: toBlockId(makeId("file")),
        kind: "file",
        name: "File",
        operation: "write",
        path: "",
        content: "",
        outputVar: null,
      };
    case "condition":
      return {
        id: toBlockId(makeId("condition")),
        kind: "condition",
        name: "Condition",
        expression: "",
        skipToBlockId: null,
      };
    case "wait":
      return {
        id: toBlockId(makeId("wait")),
        kind: "wait",
        name: "Wait",
        durationMs: 1000,
      };
    case "reduce":
      return {
        id: toBlockId(makeId("reduce")),
        kind: "reduce",
        name: "Reduce",
        inputVar: "",
        mode: "concat",
        separator: "\n",
        mergerGoal: "Combine the inputs into one coherent result.",
        mergerModel: "claude-sonnet-4-6",
        outputVar: null,
      };
    case "llm":
      return {
        id: toBlockId(makeId("llm")),
        kind: "llm",
        name: "LLM call",
        prompt: "",
        model: "claude-sonnet-4-6",
        effort: "medium",
        outputVar: null,
      };
    case "evaluator":
      return {
        id: toBlockId(makeId("evaluator")),
        kind: "evaluator",
        name: "Evaluator",
        goal: "",
        evaluatorModel: "claude-sonnet-4-6",
      };
    case "map":
      return {
        id: toBlockId(makeId("map")),
        kind: "map",
        name: "Map",
        listVar: "",
        itemVar: "item",
        prompt: "Process this item: ${vars.item}",
        model: "claude-sonnet-4-6",
        effort: "medium",
        outputVar: null,
      };
    case "approval":
      return {
        id: toBlockId(makeId("approval")),
        kind: "approval",
        name: "Approval",
        message: "Review the results so far, then continue.",
      };
    default:
      return assertNever(kind);
  }
};

const defaultWorker = (name: string): WorkerBlock => ({
  id: toBlockId(makeId("worker")),
  kind: "worker",
  name,
  prompt: "",
  model: "claude-sonnet-4-6",
  effort: "medium",
});

const makeId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 100000).toString(36)}`;

const orchStatusFor = (blockStatus: string): string | undefined => {
  switch (blockStatus) {
    case "judging":
    case "done":
    case "stuck":
    case "failed":
      return blockStatus;
    default:
      return undefined;
  }
};

