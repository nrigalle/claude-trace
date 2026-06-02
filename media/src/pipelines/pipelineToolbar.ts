import { h, clear } from "../ui/h.js";
import type { Pipeline, RunId, RunState } from "../../../src/features/pipelines/domain/types";
import type { RunSummary } from "../../../src/features/pipelines/protocol";
import { ICON_PLAY, ICON_ZAP } from "./pipelineIcons.js";

type PipelineView = "editor" | "runs";

export interface ToolbarHost {
  readonly canvasToolbar: HTMLElement;
  getRuns(): readonly RunSummary[];
  getPipelines(): readonly Pipeline[];
  updateDraft(patch: Partial<Pipeline>): void;
  setPipelineView(view: PipelineView): void;
  openTriggers(): void;
  handleSave(): void;
  handleRun(): void;
  handleDelete(): void;
  killRun(runId: RunId): void;
  resumeRun(runId: RunId): void;
  navigateToPipeline(draft: Pipeline, view: PipelineView): void;
  onAssistant(): void;
}

export class PipelineToolbar {
  constructor(private readonly host: ToolbarHost) {}

  render(draft: Pipeline, view: PipelineView): void {
    clear(this.host.canvasToolbar);
    const runCount = this.host.getRuns().filter((r) => r.pipelineId === draft.id).length;

    const nameInput = h("input", {
      className: "pl-name-input",
      attrs: { type: "text", placeholder: "Untitled workflow" },
      on: {
        input: (e) => {
          const target = e.currentTarget as HTMLInputElement;
          this.host.updateDraft({ name: target.value });
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
        on: { click: () => this.host.handleRun() },
      }),
    );

    const tabs = h(
      "div",
      { className: "pl-view-tabs" },
      h("button", {
        className: `pl-view-tab${view === "editor" ? " active" : ""}`,
        attrs: { type: "button", role: "tab", "aria-selected": String(view === "editor") },
        textContent: "Definition",
        on: { click: () => this.host.setPipelineView("editor") },
      }),
      h(
        "button",
        {
          className: `pl-view-tab${view === "runs" ? " active" : ""}`,
          attrs: { type: "button", role: "tab", "aria-selected": String(view === "runs") },
          on: { click: () => this.host.setPipelineView("runs") },
        },
        h("span", { textContent: "Runs" }),
        runCount > 0
          ? h("span", { className: "pl-view-tab-badge", textContent: String(runCount) })
          : null,
      ),
    );

    const secondaryActions = h("div", { className: "pl-header-actions" });
    if (view === "editor") {
      secondaryActions.appendChild(
        h("button", {
          className: "pl-btn primary",
          attrs: { type: "button", title: "Build this workflow with an AI assistant" },
          innerHTML: '<span>✦ Build with AI</span>',
          on: { click: () => this.host.onAssistant() },
        }),
      );
      const triggerCount = draft.triggers.length;
      secondaryActions.appendChild(
        h("button", {
          className: "pl-btn pl-btn-ghost",
          attrs: { type: "button", title: "Configure schedule and webhook triggers" },
          textContent: triggerCount > 0 ? `Triggers (${triggerCount})` : "Triggers",
          on: { click: () => this.host.openTriggers() },
        }),
      );
      secondaryActions.appendChild(
        h("button", {
          className: "pl-btn pl-btn-ghost",
          attrs: { type: "button", title: "Save changes (⌘S)" },
          textContent: "Save",
          on: { click: () => this.host.handleSave() },
        }),
      );
      secondaryActions.appendChild(
        h("button", {
          className: "pl-btn pl-btn-ghost danger",
          attrs: { type: "button", title: "Delete this workflow" },
          textContent: "Delete",
          on: { click: () => this.host.handleDelete() },
        }),
      );
    }

    const tabRow = h("div", { className: "pl-tab-row" }, tabs, secondaryActions);

    this.host.canvasToolbar.appendChild(heading);
    this.host.canvasToolbar.appendChild(tabRow);
  }

  renderRunHeader(run: RunState): void {
    clear(this.host.canvasToolbar);

    const pipelineId = run.pipelineId;
    const sameAsCurrentPipeline = this.host.getPipelines().some((p) => p.id === pipelineId);
    const runCount = this.host.getRuns().filter((r) => r.pipelineId === pipelineId).length;
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
          on: { click: () => this.host.killRun(run.runId) },
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
          on: { click: () => this.host.resumeRun(run.runId) },
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

    const pipelineDraft = this.host.getPipelines().find((p) => p.id === pipelineId);
    const navigateToView = (view: PipelineView): void => {
      if (!pipelineDraft) return;
      this.host.navigateToPipeline(pipelineDraft, view);
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

    this.host.canvasToolbar.appendChild(heading);
    this.host.canvasToolbar.appendChild(tabRow);

    if (run.status === "paused-needs-input") {
      this.host.canvasToolbar.appendChild(
        h("div", { className: "pl-header-banner" },
          h("span", { textContent: "Click the warning bubble below to open the worker's terminal and answer Claude's question." }),
        ),
      );
    }
  }
}
