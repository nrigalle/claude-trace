import { setIfChanged } from "../ui/dom.js";
import { h } from "../ui/h.js";
import type { Pipeline, PipelineId } from "../../../src/features/pipelines/domain/types";
import type { RunSummary } from "../../../src/features/pipelines/protocol";
import { ICON_TRASH } from "./pipelineIcons.js";
import { blockCountLabel, runCountLabel } from "./pipelineRunState.js";

interface SidebarRowRefs {
  readonly nameEl: HTMLElement;
  readonly blocksEl: HTMLElement;
  readonly runBadgeEl: HTMLElement;
}
const sidebarRowRefs = new WeakMap<HTMLElement, SidebarRowRefs>();

export interface SidebarHost {
  getPipelines(): readonly Pipeline[];
  getRuns(): readonly RunSummary[];
  getSelectedPipelineId(): PipelineId | null;
  loadPipeline(pipelineId: PipelineId): void;
  deleteRun(runId: RunSummary["runId"]): void;
  selectRun(runId: RunSummary["runId"]): void;
}

export class PipelineSidebar {
  private readonly nodes = new Map<string, HTMLButtonElement>();

  constructor(private readonly listEl: HTMLElement, private readonly host: SidebarHost) {}

  render(): void {
    const emptyHint = this.listEl.querySelector<HTMLElement>(".pl-sidebar-empty");
    if (this.host.getPipelines().length === 0) {
      for (const [, node] of this.nodes) node.remove();
      this.nodes.clear();
      if (!emptyHint) {
        this.listEl.appendChild(
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
    for (const r of this.host.getRuns()) {
      runsByPipeline.set(r.pipelineId, (runsByPipeline.get(r.pipelineId) ?? 0) + 1);
    }

    const seen = new Set<string>();
    let prev: HTMLButtonElement | null = null;
    const selectedId = this.host.getSelectedPipelineId();

    for (const p of this.host.getPipelines()) {
      seen.add(p.id);
      const runCount = runsByPipeline.get(p.id) ?? 0;
      const selected = selectedId === p.id;
      let node = this.nodes.get(p.id);
      if (!node) {
        node = this.buildSidebarRow(p, runCount, selected);
        this.nodes.set(p.id, node);
      } else {
        this.updateSidebarRow(node, p, runCount, selected);
      }
      const expectedNext: ChildNode | null = prev ? prev.nextSibling : this.listEl.firstChild;
      if (node !== expectedNext) this.listEl.insertBefore(node, expectedNext);
      prev = node;
    }

    for (const [id, node] of this.nodes) {
      if (!seen.has(id)) {
        node.remove();
        this.nodes.delete(id);
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
        on: { click: () => this.host.loadPipeline(p.id) },
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

  renderRunRow(r: RunSummary, selected: boolean): HTMLElement {
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
          this.host.deleteRun(r.runId);
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
            this.host.selectRun(r.runId);
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
}
