import { setIfChanged } from "../ui/dom.js";
import { h } from "../ui/h.js";
import type {
  Block,
  LoopBlock,
  ParallelBlock,
  PoolBlock,
  RunState,
  WorkerBlock,
} from "../../../src/features/pipelines/domain/types";
import type { PipelinesWebviewToHost } from "../../../src/features/pipelines/protocol";
import {
  ICON_MERGER,
  ICON_ORCHESTRATOR,
  ICON_PARALLEL,
  ICON_PLUS,
  ICON_WARNING,
  ICON_WORKER,
} from "./pipelineIcons.js";
import { blockNodeMeta, orchStatusFor } from "./pipelineBlockMeta.js";
import {
  buildRunBlockState,
  startEndState,
  staticSublabel,
} from "./pipelineRunState.js";
import type { RunBlockState } from "./pipelineRunState.js";
import { renderPoolExpanded, updatePoolInPlace, type PoolCanvasDeps } from "./poolCanvas.js";

interface StaticNodeRefs {
  readonly bubbleEl: HTMLElement;
  readonly sublabelEl: HTMLElement;
  readonly defaultSublabel: string;
  readonly kind: "start" | "end";
}
const staticNodeRefs = new WeakMap<HTMLElement, StaticNodeRefs>();

export interface CanvasHost {
  getZoom(): number;
  getLoopDefineMode(): string | null;
  getBlocksForArrows(): readonly Block[];
  isBlockSelected(blockId: string): boolean;
  isLibraryInsertActive(index: number): boolean;
  isLoopAnchorCandidate(blockId: string): boolean;
  pickLoopTarget(blockId: string): void;
  openInspector(blockId: string): void;
  openRunBlockDetail(blockId: string): void;
  openLibraryAt(index: number): void;
  findBlockName(blockId: string | null): string | null;
  addParallelWorker(blockId: string): void;
  removeParallelWorker(blockId: string, workerId: string): void;
  setPoolConcurrency(blockId: string, concurrency: number): void;
  removeBlock(blockId: string): void;
  send(msg: PipelinesWebviewToHost): void;
}

export class PipelineCanvas {
  private currentStack: HTMLElement | null = null;

  constructor(private readonly host: CanvasHost) {}

  setStack(stack: HTMLElement): void {
    this.currentStack = stack;
  }

  clearStack(): void {
    this.currentStack = null;
  }

  hasStack(): boolean {
    return this.currentStack !== null;
  }

  applyZoom(zoom: number): void {
    if (this.currentStack) this.currentStack.style.transform = `scale(${zoom})`;
  }

  renderStaticNode(
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

  renderBlockNode(block: Block, runState?: RunBlockState): HTMLElement {
    const isRunView = !!runState;
    const isSelected = this.host.isBlockSelected(block.id);
    const meta = blockNodeMeta(block);
    const isAnchorCandidate = !isRunView && this.host.isLoopAnchorCandidate(block.id);
    const isActiveLoopBeingDefined = !isRunView && this.host.getLoopDefineMode() === block.id;

    let sublabel = meta.sublabel;
    if (block.kind === "loop") {
      const targetName = block.loopBackToBlockId
        ? (this.host.findBlockName(block.loopBackToBlockId) ?? "missing block")
        : "target not set";
      sublabel = `Loops back to ${targetName} · max ${block.maxIterations}`;
    }

    const classes = ["pl-node-bubble", `kind-${meta.cssKind}`, "clickable"];
    if (isSelected) classes.push("selected");
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
          if (this.host.getLoopDefineMode()) return;
          if (isRunView) {
            if (runState?.runId && block.kind !== "parallel") {
              this.host.send({
                type: "revealSession",
                runId: runState.runId,
                blockId: block.id,
                target: { kind: "self" },
                sessionId: runState.sessionId,
              });
            }
            this.host.openRunBlockDetail(block.id);
          } else {
            this.host.openInspector(block.id);
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
          this.host.pickLoopTarget(blockId);
        },
      },
    });
  }

  drawLoopArrows(): void {
    if (!this.currentStack) return;
    const stack = this.currentStack;

    stack.querySelectorAll(".pl-loop-arrow").forEach((el) => el.remove());

    const blocks = this.host.getBlocksForArrows();
    if (blocks.length === 0) return;

    const loopsWithTargets = blocks.filter(
      (b): b is LoopBlock => b.kind === "loop" && b.loopBackToBlockId !== null,
    );
    if (loopsWithTargets.length === 0) return;

    const stackBox = stack.getBoundingClientRect();
    const z = this.host.getZoom() || 1;
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
          this.host.removeBlock(blockId);
        },
      },
    });
  }

  renderBlockRowWithOrch(blockNode: HTMLElement, status?: string): HTMLElement {
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

  renderParallelExpanded(block: ParallelBlock, runState?: RunBlockState): HTMLElement {
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
          on: { click: () => this.host.addParallelWorker(block.id) },
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
    const isSelected = this.host.isBlockSelected(block.id);
    const isAnchorCandidate = !isRunView && this.host.isLoopAnchorCandidate(block.id);
    const classes = ["pl-node-bubble", "kind-parallel", "clickable"];
    if (isSelected) classes.push("selected");
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
          if (this.host.getLoopDefineMode()) return;
          if (isRunView) this.host.openRunBlockDetail(block.id);
          else this.host.openInspector(block.id);
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
    const isSelected = this.host.isBlockSelected(block.id);
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
    if (isStuck) bubbleAttrs["title"] = "Claude is waiting for your reply. Click to open the terminal";
    const classes = ["pl-node-bubble", "kind-worker", "clickable"];
    if (isSelected) classes.push("selected");
    if (isStuck) classes.push("needs-input");
    if (isFailed) classes.push("failed");
    const bubble = h("div", {
      className: classes.join(" "),
      innerHTML: isStuck ? ICON_WARNING : ICON_WORKER,
      on: {
        click: () => {
          if (isRunView && runState?.runId) {
            const workerSessionId = runState.parallelWorkerSessionIds?.get(worker.id) ?? null;
            this.host.send({
              type: "revealSession",
              runId: runState.runId,
              blockId: block.id,
              target: { kind: "parallel-worker", workerBlockId: worker.id },
              sessionId: workerSessionId,
            });
            this.host.openRunBlockDetail(block.id);
            return;
          }
          this.host.openInspector(block.id);
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
                    this.host.removeParallelWorker(block.id, worker.id);
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
    const isSelected = this.host.isBlockSelected(block.id);
    const mergerStatus = runState?.mergerStatus;
    const isStuck = mergerStatus === "stuck";
    const isFailed = mergerStatus === "failed";
    const bubbleAttrs: Record<string, string> = {
      role: "button",
      "aria-label": `${isRunView ? "View" : "Edit"} merger`,
    };
    if (mergerStatus) bubbleAttrs["data-status"] = mergerStatus;
    else if (runState) bubbleAttrs["data-status"] = runState.status;
    if (isStuck) bubbleAttrs["title"] = "Claude is waiting for your reply. Click to open the merger's terminal";
    const classes = ["pl-node-bubble", "kind-merger", "clickable"];
    if (isSelected) classes.push("selected");
    if (isStuck) classes.push("needs-input");
    if (isFailed) classes.push("failed");
    const bubble = h("div", {
      className: classes.join(" "),
      innerHTML: isStuck ? ICON_WARNING : ICON_MERGER,
      on: {
        click: () => {
          if (isRunView && runState?.runId) {
            this.host.send({
              type: "revealSession",
              runId: runState.runId,
              blockId: block.id,
              target: { kind: "merger" },
              sessionId: runState.mergerSessionId ?? null,
            });
            this.host.openRunBlockDetail(block.id);
            return;
          }
          this.host.openInspector(block.id);
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

  renderPoolExpanded(block: PoolBlock, runState?: RunBlockState): HTMLElement {
    return renderPoolExpanded(this.poolCanvasDeps(), block, runState);
  }

  private poolCanvasDeps(): PoolCanvasDeps {
    return {
      host: this.host,
      connector: () => this.renderConnector(null),
      removeButton: (blockId, label) => this.renderRemoveButton(blockId, label),
      anchorDot: (blockId) => this.renderAnchorDot(blockId),
    };
  }

  renderConnector(insert: { insertIndex: number } | null): HTMLElement {
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
          on: { click: () => this.host.openLibraryAt(insert.insertIndex) },
        },
      );
      if (this.host.isLibraryInsertActive(insert.insertIndex)) {
        btn.classList.add("expanded");
      }
      connector.appendChild(btn);
    }
    return connector;
  }

  updateRunInPlace(run: RunState): void {
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
      } else if (definition.kind === "pool") {
        this.updatePoolInPlace(definition, runState);
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

  private updatePoolInPlace(block: PoolBlock, runState: RunBlockState): void {
    if (!this.currentStack) return;
    updatePoolInPlace(this.currentStack, block, runState);
  }

  private updateOrchSatelliteInPlace(node: HTMLElement, status: string | undefined): void {
    const row = node.closest(".pl-block-row") as HTMLElement | null;
    const mini = row?.querySelector<HTMLElement>(".pl-orch-satellite .pl-mini-bubble");
    if (!mini) return;
    if (status) mini.setAttribute("data-status", status);
    else mini.removeAttribute("data-status");
  }
}
