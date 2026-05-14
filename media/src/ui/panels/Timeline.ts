import type { SessionDetail, TraceEvent } from "../../../../src/domain/types";
import { fmtTime } from "../format.js";
import { h } from "../h.js";
import { EVENT_ICONS, TOOL_ICONS, getToolColor, icon } from "../icons.js";
import type { Store } from "../../state/Store.js";

const ROW_HEIGHT = 56;
const OVERSCAN = 6;

export type TimelineFilter = "all" | "tools" | "lifecycle" | "errors";

export class Timeline {
  private readonly root: HTMLElement;
  private readonly headerEl: HTMLElement;
  private readonly filtersEl: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly expandedHost: HTMLElement;
  private rowPool: HTMLElement[] = [];
  private filtered: readonly TraceEvent[] = [];
  private startedAt = 0;
  private rafScheduled = false;
  private scrollHandlerBound: () => void;
  private resizeObserver: ResizeObserver | null = null;

  constructor(private readonly store: Store, private readonly onChange: () => void) {
    this.root = h("section", {
      className: "timeline-card",
      attrs: { "aria-label": "Session event timeline" },
    });

    this.filtersEl = h("div", {
      className: "timeline-filters",
      attrs: { role: "group", "aria-label": "Timeline filter" },
    });

    this.headerEl = h(
      "div",
      { className: "timeline-header" },
      h("span", { className: "timeline-title", textContent: "Timeline" }),
      this.filtersEl,
    );
    this.root.appendChild(this.headerEl);

    this.spacer = h("div", { className: "timeline-spacer" });
    this.stage = h("div", { className: "timeline-stage" });
    this.expandedHost = h("div", { className: "timeline-expanded-host" });
    this.viewport = h(
      "div",
      {
        className: "timeline-events",
        attrs: {
          role: "list",
          tabindex: "0",
          "aria-live": "polite",
          "aria-relevant": "additions",
        },
      },
      this.spacer,
    );
    this.spacer.appendChild(this.stage);
    this.spacer.appendChild(this.expandedHost);
    this.root.appendChild(this.viewport);

    this.scrollHandlerBound = () => this.requestPaint();
    this.viewport.addEventListener("scroll", this.scrollHandlerBound, { passive: true });

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.requestPaint());
      this.resizeObserver.observe(this.viewport);
    }
  }

  element(): HTMLElement {
    return this.root;
  }

  update(d: SessionDetail): void {
    this.startedAt = d.started_at ?? 0;
    this.filtered = filterEvents(d.events, this.store.state.timelineFilter);
    this.renderFilters(d.events.length);
    this.spacer.style.height = `${this.filtered.length * ROW_HEIGHT}px`;

    queueMicrotask(() => {
      this.viewport.scrollTop = this.store.state.timelineScroll;
      this.requestPaint();
    });
  }

  dispose(): void {
    this.viewport.removeEventListener("scroll", this.scrollHandlerBound);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private renderFilters(totalCount: number): void {
    while (this.filtersEl.firstChild) this.filtersEl.removeChild(this.filtersEl.firstChild);
    const filters: { value: TimelineFilter; label: string }[] = [
      { value: "all", label: `All ${totalCount}` },
      { value: "tools", label: "Tools" },
      { value: "lifecycle", label: "Lifecycle" },
      { value: "errors", label: "Errors" },
    ];
    for (const f of filters) {
      const active = this.store.state.timelineFilter === f.value;
      const btn = h(
        "button",
        {
          className: `filter-btn${active ? " active" : ""}`,
          attrs: {
            type: "button",
            "aria-pressed": String(active),
          },
          on: {
            click: () => {
              this.store.update({ timelineFilter: f.value, expandedEvent: null });
              this.onChange();
            },
          },
        },
        f.label,
      );
      this.filtersEl.appendChild(btn);
    }
  }

  private requestPaint(): void {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => {
      this.rafScheduled = false;
      this.paint();
    });
  }

  private paint(): void {
    this.store.update({ timelineScroll: this.viewport.scrollTop });

    if (this.filtered.length === 0) {
      while (this.stage.firstChild) this.stage.removeChild(this.stage.firstChild);
      while (this.expandedHost.firstChild) this.expandedHost.removeChild(this.expandedHost.firstChild);
      const empty = h("div", { className: "no-data-msg", textContent: "No events match filter" });
      this.stage.appendChild(empty);
      return;
    }

    const viewportH = this.viewport.clientHeight || 400;
    const scroll = this.viewport.scrollTop;
    const startIdx = Math.max(0, Math.floor(scroll / ROW_HEIGHT) - OVERSCAN);
    const endIdx = Math.min(this.filtered.length, Math.ceil((scroll + viewportH) / ROW_HEIGHT) + OVERSCAN);
    const visibleCount = endIdx - startIdx;

    while (this.rowPool.length < visibleCount) {
      this.rowPool.push(this.createRowShell());
    }

    for (let i = 0; i < this.rowPool.length; i++) {
      const row = this.rowPool[i]!;
      if (i < visibleCount) {
        const idx = startIdx + i;
        const ev = this.filtered[idx]!;
        this.bindRow(row, ev, idx);
        if (!row.isConnected) this.stage.appendChild(row);
      } else if (row.isConnected) {
        row.remove();
      }
    }

    this.renderExpanded();
  }

  private createRowShell(): HTMLElement {
    const iconEl = h("div", { className: "event-icon" });
    const label = h("span", { className: "event-label" });
    const detail = h("div", { className: "event-detail" });
    const elapsedEl = h("span", { className: "event-elapsed" });
    const timestampEl = h("span", { className: "event-timestamp" });
    const body = h("div", { className: "event-body" }, label, detail);
    const time = h("div", { className: "event-time" }, elapsedEl, timestampEl);

    const row = h(
      "button",
      {
        className: "event-row",
        attrs: {
          type: "button",
          role: "listitem",
          "aria-expanded": "false",
        },
      },
      iconEl,
      body,
      time,
    );
    row.dataset["pool"] = "1";
    return row;
  }

  private bindRow(row: HTMLElement, ev: TraceEvent, idx: number): void {
    row.style.position = "absolute";
    row.style.top = `${idx * ROW_HEIGHT}px`;
    row.style.left = "0";
    row.style.right = "0";
    row.style.height = `${ROW_HEIGHT}px`;
    row.dataset["idx"] = String(idx);

    const expanded = this.store.state.expandedEvent === idx;
    row.classList.toggle("expanded", expanded);
    const isError = ev.event === "StopFailure" || !!ev.error;
    row.classList.toggle("error", isError);
    row.setAttribute("aria-expanded", String(expanded));

    const iconHost = row.querySelector(".event-icon") as HTMLElement;
    while (iconHost.firstChild) iconHost.removeChild(iconHost.firstChild);
    const iconName = (ev.tool_name && TOOL_ICONS[ev.tool_name]) || EVENT_ICONS[ev.event] || "terminal";
    const color = ev.tool_name ? getToolColor(ev.tool_name) : "#6b7280";
    iconHost.style.background = `${color}15`;
    iconHost.style.color = color;
    iconHost.appendChild(icon(iconName, 13));

    const label = row.querySelector(".event-label") as HTMLElement;
    label.textContent = ev.tool_name ?? ev.event;
    if (isError) {
      const badge = h("span", { className: "event-badge error", textContent: "ERROR" });
      label.appendChild(badge);
    }

    const detailEl = row.querySelector(".event-detail") as HTMLElement;
    const detailText = describeInput(ev);
    detailEl.textContent = detailText;
    detailEl.title = detailText;

    const elapsedEl = row.querySelector(".event-elapsed") as HTMLElement;
    const elapsed = ev.ts - this.startedAt;
    elapsedEl.textContent = elapsed > 0 ? `+${(elapsed / 1000).toFixed(1)}s` : "0s";

    const timestampEl = row.querySelector(".event-timestamp") as HTMLElement;
    timestampEl.textContent = fmtTime(ev.ts);

    row.onclick = () => {
      const newExpanded = this.store.state.expandedEvent === idx ? null : idx;
      this.store.update({ expandedEvent: newExpanded });
      this.requestPaint();
    };
  }

  private renderExpanded(): void {
    while (this.expandedHost.firstChild) this.expandedHost.removeChild(this.expandedHost.firstChild);
    const idx = this.store.state.expandedEvent;
    if (idx === null) return;
    if (idx < 0 || idx >= this.filtered.length) return;
    const ev = this.filtered[idx]!;
    if (!ev.tool_input && !ev.tool_result && !ev.error && !ev.tokens_freed) return;

    const exp = h("div", { className: "event-expanded" });
    exp.style.position = "absolute";
    exp.style.top = `${(idx + 1) * ROW_HEIGHT}px`;
    exp.style.left = "0";
    exp.style.right = "0";

    if (ev.tool_input) {
      exp.appendChild(detailBlock("Input", JSON.stringify(ev.tool_input, null, 2)));
    }
    if (ev.tool_result) {
      const content =
        typeof ev.tool_result === "string"
          ? ev.tool_result
          : JSON.stringify(ev.tool_result, null, 2);
      exp.appendChild(detailBlock("Result", content));
    }
    if (ev.error) exp.appendChild(detailBlock("Error", String(ev.error), true));
    if (ev.tokens_freed) exp.appendChild(detailBlock("Tokens Freed", `${ev.tokens_freed.toLocaleString()} tokens`));

    this.expandedHost.appendChild(exp);
  }
}

const filterEvents = (events: readonly TraceEvent[], filter: TimelineFilter): readonly TraceEvent[] => {
  const visible = events.filter((e) => e.event !== "Metrics" && e.event !== "PreToolUse");
  if (filter === "all") return visible;
  if (filter === "tools") return visible.filter((e) => e.event === "PostToolUse");
  if (filter === "lifecycle") {
    return visible.filter((e) =>
      ["SessionStart", "SessionEnd", "Stop", "PreCompact", "PostCompact"].includes(e.event),
    );
  }
  if (filter === "errors") return visible.filter((e) => e.event === "StopFailure" || !!e.error);
  return visible;
};

const describeInput = (ev: TraceEvent): string => {
  if (!ev.tool_input) return "";
  const inp = ev.tool_input as Record<string, unknown>;
  const candidates = ["command", "file_path", "pattern", "description", "skill", "prompt", "subagent_type"];
  for (const key of candidates) {
    const v = inp[key];
    if (typeof v === "string") return v;
  }
  return "";
};

const detailBlock = (label: string, content: string, isError = false): HTMLElement =>
  h(
    "div",
    { className: "detail-block" },
    h("div", { className: `detail-label${isError ? " error" : ""}`, textContent: label }),
    h("pre", { className: `detail-pre${isError ? " error" : ""}`, textContent: content }),
  );
