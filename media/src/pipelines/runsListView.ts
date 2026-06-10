import { h, clear } from "../ui/h.js";
import type { PipelineId, RunId, RunState } from "../../../src/features/pipelines/domain/types";
import type { RunSummary } from "../../../src/features/pipelines/protocol";
import { runDisplayName, runDateGroup } from "./pipelineRunState.js";

export interface RunsListHost {
  runs(): readonly RunSummary[];
  isRunSelected(runId: RunId): boolean;
  getSearch(): string;
  setSearch(v: string): void;
  getStatusFilter(): string;
  setStatusFilter(v: string): void;
  renderRunRow(r: RunSummary, selected: boolean): HTMLElement;
}

export const renderRunsListPage = (host: RunsListHost, pipelineId: PipelineId): HTMLElement => {
  const allRuns = host.runs()
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
    return container;
  }

  const listEl = h("div", { className: "pl-runs-list" });
  const refresh = (): void => {
    clear(listEl);
    const q = host.getSearch().trim().toLowerCase();
    const statusFilter = host.getStatusFilter();
    const filtered = allRuns.filter(
      (r) =>
        (statusFilter === "all" || r.status === statusFilter) &&
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
      listEl.appendChild(host.renderRunRow(r, host.isRunSelected(r.runId)));
    }
  };

  const searchInput = h("input", {
    className: "pl-runs-search",
    attrs: { type: "search", placeholder: "Search runs by name…", spellcheck: "false" },
    on: {
      input: (e) => {
        host.setSearch((e.currentTarget as HTMLInputElement).value);
        refresh();
      },
    },
  }) as HTMLInputElement;
  searchInput.value = host.getSearch();

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
          className: `pl-runs-chip${host.getStatusFilter() === s ? " active" : ""}${s !== "all" ? ` pl-status-${s}` : ""}`,
          attrs: { type: "button" },
          on: {
            click: () => {
              host.setStatusFilter(s);
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
  return container;
};

export const renderRunResults = (run: RunState, onCopied: () => void): HTMLElement | null => {
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
        onCopied();
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
};
