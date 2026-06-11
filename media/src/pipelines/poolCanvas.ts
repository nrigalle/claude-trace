import { h } from "../ui/h.js";
import { clampConcurrency, POOL_MIN_CONCURRENCY, POOL_MAX_CONCURRENCY } from "../../../src/features/pipelines/domain/types";
import type { PoolBlock } from "../../../src/features/pipelines/domain/types";
import { ICON_MERGER, ICON_ORCHESTRATOR, ICON_PLUS, ICON_PARALLEL, ICON_WORKER } from "./pipelineIcons.js";
import type { RunBlockState } from "./pipelineRunState.js";
import type { CanvasHost } from "./pipelineCanvas.js";

const POOL_LANE_DISPLAY_CAP = 8;

export interface PoolCanvasDeps {
  readonly host: CanvasHost;
  connector(): HTMLElement;
  removeButton(blockId: string, label: string): HTMLElement;
  anchorDot(blockId: string): HTMLElement;
}

export const renderPoolExpanded = (deps: PoolCanvasDeps, block: PoolBlock, runState?: RunBlockState): HTMLElement => {
  const container = h("div", { className: "pl-parallel-block pl-pool-block", attrs: { "data-block-id": block.id } });
  container.appendChild(renderPoolHeaderNode(deps, block, runState));
  container.appendChild(
    h("div", {
        className: "pl-pool-hint",
        textContent: `Each agent grabs the next item${block.listVar ? ` from ${block.listVar}` : ""} until the list is empty.`,
      }),
  );
  container.appendChild(deps.connector());

  const isRunView = !!runState;
  const concurrency = clampConcurrency(block.concurrency);
  const lanes = h("div", { className: "pl-parallel-branches" });
  const laneCount = Math.min(concurrency, POOL_LANE_DISPLAY_CAP);
  for (let i = 0; i < laneCount; i += 1) {
    lanes.appendChild(renderPoolLane(deps, block, runState, !isRunView && concurrency > POOL_MIN_CONCURRENCY));
  }
  if (!isRunView && concurrency < POOL_MAX_CONCURRENCY) {
    lanes.appendChild(
      h("button", {
          className: "pl-parallel-add-branch",
          attrs: { type: "button", title: "Add a parallel agent" },
          innerHTML: ICON_PLUS,
          on: { click: () => deps.host.setPoolConcurrency(block.id, concurrency + 1) },
        }),
    );
  }
  container.appendChild(lanes);

  container.appendChild(deps.connector());
  container.appendChild(renderPoolOrchestratorNode(deps, block, runState));
  container.appendChild(deps.connector());
  container.appendChild(renderPoolCollectNode(deps, block, runState));
  return container;
};

const renderPoolOrchestratorNode = (deps: PoolCanvasDeps, block: PoolBlock, runState?: RunBlockState): HTMLElement => {
  const isRunView = !!runState;
  const pass = runState?.poolVerdictPassCount ?? 0;
  const fail = runState?.poolVerdictFailCount ?? 0;
  const attrs: Record<string, string> = {
    role: "button",
    "aria-label": "Pool orchestrator — judges every agent's result",
    title: "Every finished agent is judged by the orchestrator before its result counts",
  };
  if (runState) {
    attrs["data-status"] = fail > 0 ? "failed" : runState.status;
  }
  const bubble = h("div", {
      className: "pl-node-bubble kind-evaluator clickable pl-pool-orch-bubble",
      innerHTML: ICON_ORCHESTRATOR,
      on: {
        click: () => {
          if (deps.host.getLoopDefineMode()) return;
          if (isRunView) deps.host.openRunBlockDetail(block.id);
          else deps.host.openInspector(block.id);
        },
      },
      attrs,
    });
  const verdictLabel =
  isRunView && (pass > 0 || fail > 0)
  ? `${pass} passed${fail > 0 ? ` · ${fail} failed` : ""}`
  : "judges every result";
  return h(
    "div",
    { className: "pl-node pl-pool-orch", attrs: { "data-block-id": block.id } },
    h("div", { className: "pl-node-bubble-wrap" }, bubble),
    h(
      "div",
      { className: "pl-node-label" },
      h("span", { textContent: "Orchestrator" }),
      h(
        "span",
        { className: "pl-node-label-kind" },
        h("span", { className: "pl-pool-orch-verdicts", attrs: fail > 0 ? { "data-state": "failed" } : {}, textContent: verdictLabel }),
      ),
    ),
  );
};

const renderPoolHeaderNode = (deps: PoolCanvasDeps, block: PoolBlock, runState?: RunBlockState): HTMLElement => {
  const isRunView = !!runState;
  const isSelected = deps.host.isBlockSelected(block.id);
  const isAnchorCandidate = !isRunView && deps.host.isLoopAnchorCandidate(block.id);
  const classes = ["pl-node-bubble", "kind-pool", "clickable"];
  if (isSelected) classes.push("selected");
  if (isAnchorCandidate) classes.push("anchor-candidate");
  const bubbleAttrs: Record<string, string> = {
    role: "button",
    "aria-label": `${isRunView ? "View" : "Edit"} ${block.name || "worker pool"}`,
    "data-block-id": block.id,
  };
  if (runState) bubbleAttrs["data-status"] = runState.status;
  const bubble = h("div", {
      className: classes.join(" "),
      innerHTML: ICON_PARALLEL,
      on: {
        click: () => {
          if (deps.host.getLoopDefineMode()) return;
          if (isRunView) deps.host.openRunBlockDetail(block.id);
          else deps.host.openInspector(block.id);
        },
      },
      attrs: bubbleAttrs,
    });
  const concurrency = clampConcurrency(block.concurrency);
  return h(
    "div",
    { className: "pl-node", attrs: { "data-block-id": block.id } },
    h(
      "div",
      { className: "pl-node-bubble-wrap" },
      bubble,
      isRunView ? null : deps.removeButton(block.id, "Remove worker pool"),
      isAnchorCandidate ? deps.anchorDot(block.id) : null,
    ),
    h(
      "div",
      { className: "pl-node-label" },
      h("span", { textContent: block.name || "Worker pool" }),
      h(
        "span",
        { className: "pl-node-label-kind" },
        h("span", { textContent: `Pool · ${concurrency} at a time` }),
        runState ? renderPoolCounter(runState) : null,
      ),
    ),
  );
};

const renderPoolCounter = (runState: RunBlockState): HTMLElement | null => {
  const done = runState.poolDoneCount ?? 0;
  const active = runState.poolActiveCount ?? 0;
  if (done === 0 && active === 0) return null;
  const allDone = active === 0 && done > 0 && runState.status === "done";
  const label = active > 0 ? `${done} done · ${active} running` : `${done} done`;
  return h(
    "span",
    { className: "pl-parallel-counter pl-pool-counter", attrs: allDone ? { "data-state": "done" } : {} },
    active > 0 ? h("span", { className: "pl-spinner-dot" }) : null,
    h("span", { textContent: label }),
  );
};

const renderPoolLane = (deps: PoolCanvasDeps, block: PoolBlock, runState?: RunBlockState, removable = false): HTMLElement => {
  const isRunView = !!runState;
  const isSelected = deps.host.isBlockSelected(block.id);
  const classes = ["pl-node-bubble", "kind-worker", "clickable"];
  if (isSelected) classes.push("selected");
  const attrs: Record<string, string> = { role: "button", "aria-label": "Pool agent" };
  if (runState) attrs["data-status"] = runState.status;
  const bubble = h("div", {
      className: classes.join(" "),
      innerHTML: ICON_WORKER,
      on: {
        click: () => {
          if (deps.host.getLoopDefineMode()) return;
          if (isRunView) deps.host.openRunBlockDetail(block.id);
          else deps.host.openInspector(block.id);
        },
      },
      attrs,
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
        removable
        ? h("button", {
            className: "pl-node-remove",
            attrs: { type: "button", title: "Remove an agent", "aria-label": "Remove a pool agent" },
            textContent: "−",
            on: {
              click: (e) => {
                e.stopPropagation();
                deps.host.setPoolConcurrency(block.id, clampConcurrency(block.concurrency) - 1);
              },
            },
          })
        : null,
      ),
      h(
        "div",
        { className: "pl-node-label" },
        h("span", { textContent: "Agent" }),
        h("span", { className: "pl-node-label-kind", textContent: "pulls next item" }),
      ),
    ),
  );
};

const renderPoolCollectNode = (deps: PoolCanvasDeps, block: PoolBlock, runState?: RunBlockState): HTMLElement => {
  const isRunView = !!runState;
  const isSelected = deps.host.isBlockSelected(block.id);
  const classes = ["pl-node-bubble", "kind-pool-collect", "clickable"];
  if (isSelected) classes.push("selected");
  const attrs: Record<string, string> = { role: "button", "aria-label": `${isRunView ? "View" : "Edit"} collect step` };
  if (runState) attrs["data-status"] = runState.status;
  const bubble = h("div", {
      className: classes.join(" "),
      innerHTML: ICON_MERGER,
      on: {
        click: () => {
          if (deps.host.getLoopDefineMode()) return;
          if (isRunView) deps.host.openRunBlockDetail(block.id);
          else deps.host.openInspector(block.id);
        },
      },
      attrs,
    });
  return h(
    "div",
    { className: "pl-node" },
    bubble,
    h(
      "div",
      { className: "pl-node-label" },
      h("span", { textContent: "Collect" }),
      h("span", {
          className: "pl-node-label-kind",
          textContent: block.outputVar ? `outputs in order → ${block.outputVar}` : "outputs in list order",
        }),
    ),
  );
};


export const updatePoolInPlace = (stack: HTMLElement, block: PoolBlock, runState: RunBlockState): void => {
  if (!stack) return;
  const wrapper = stack.querySelector<HTMLElement>(`.pl-pool-block[data-block-id="${CSS.escape(block.id)}"]`);
  if (!wrapper) return;
  const header = wrapper.querySelector<HTMLElement>(`.pl-node-bubble.kind-pool[data-block-id="${CSS.escape(block.id)}"]`);
  if (header) header.setAttribute("data-status", runState.status);
  wrapper.querySelectorAll<HTMLElement>(".pl-parallel-branch .pl-node-bubble.kind-worker").forEach((b) => {
      b.setAttribute("data-status", runState.status);
    });
  const collect = wrapper.querySelector<HTMLElement>(".pl-node-bubble.kind-pool-collect");
  if (collect) collect.setAttribute("data-status", runState.status);
  const counter = wrapper.querySelector(".pl-pool-counter");
  const fresh = renderPoolCounter(runState);
  if (counter && fresh) counter.replaceWith(fresh);
  else if (counter && !fresh) counter.remove();
  else if (!counter && fresh) {
    wrapper.querySelector(".pl-node-label .pl-node-label-kind")?.appendChild(fresh);
  }
  const orchBubble = wrapper.querySelector<HTMLElement>(".pl-pool-orch-bubble");
  const pass = runState.poolVerdictPassCount ?? 0;
  const fail = runState.poolVerdictFailCount ?? 0;
  if (orchBubble) orchBubble.setAttribute("data-status", fail > 0 ? "failed" : runState.status);
  const orchVerdicts = wrapper.querySelector<HTMLElement>(".pl-pool-orch-verdicts");
  if (orchVerdicts) {
    orchVerdicts.textContent =
    pass > 0 || fail > 0 ? `${pass} passed${fail > 0 ? ` · ${fail} failed` : ""}` : "judges every result";
    if (fail > 0) orchVerdicts.setAttribute("data-state", "failed");
    else orchVerdicts.removeAttribute("data-state");
  }
};
