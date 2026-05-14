import type { SessionDetail, ToolStat } from "../../../../src/domain/types";
import { AreaChart } from "../charts/AreaChart.js";
import { h } from "../h.js";
import { icon, getToolColor } from "../icons.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export class ContextChartView {
  readonly root: HTMLElement;
  private readonly chart = new AreaChart(
    {
      maxYClamp: 100,
      maxYStep: 10,
      warnLine: 80,
      stroke: "#d97757",
      fillTop: "rgba(217, 119, 87, 0.25)",
      fillBottom: "rgba(217, 119, 87, 0)",
      yLabel: (v) => `${v}%`,
      tooltipValue: (v) => `${Math.round(v)}%`,
    },
    "Context usage chart",
  );
  private readonly empty: HTMLElement;

  constructor() {
    this.empty = h("div", { className: "no-data-msg", textContent: "Not enough context data" });
    this.empty.hidden = true;
    this.root = h(
      "section",
      { className: "chart-card", attrs: { "aria-label": "Context window usage over time" } },
      h("div", { className: "chart-header" },
        icon("cpu", 14),
        h("span", { className: "chart-title", textContent: "Context Usage" }),
      ),
      this.chart.element(),
      this.empty,
    );
  }

  element(): HTMLElement {
    return this.root;
  }

  update(d: SessionDetail): void {
    if (d.context_timeline.length < 2) {
      this.chart.element().hidden = true;
      this.empty.hidden = false;
      return;
    }
    this.chart.element().hidden = false;
    this.empty.hidden = true;
    this.chart.update(d.context_timeline);
  }
}

export class CostChartView {
  readonly root: HTMLElement;
  private readonly chart = new AreaChart(
    {
      maxYClamp: Number.POSITIVE_INFINITY,
      maxYStep: 0.01,
      warnLine: null,
      stroke: "#10b981",
      fillTop: "rgba(16, 185, 129, 0.2)",
      fillBottom: "rgba(16, 185, 129, 0)",
      yLabel: (v) => `$${v.toFixed(2)}`,
      tooltipValue: (v) => `$${v.toFixed(2)}`,
    },
    "Cost timeline chart",
  );

  constructor() {
    this.root = h(
      "section",
      {
        className: "chart-card",
        attrs: { "aria-label": "Cumulative cost over time" },
        style: { marginBottom: "16px" },
      },
      h("div", { className: "chart-header" },
        icon("dollar", 14),
        h("span", { className: "chart-title", textContent: "Cumulative Cost" }),
      ),
      this.chart.element(),
    );
    this.root.hidden = true;
  }

  element(): HTMLElement {
    return this.root;
  }

  update(d: SessionDetail): void {
    if (d.cost_timeline.length < 2) {
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    this.chart.update(d.cost_timeline);
  }
}

export class DonutView {
  readonly root: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly legend: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly distWrap: HTMLElement;

  constructor() {
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("width", "140");
    this.svg.setAttribute("height", "140");
    this.svg.setAttribute("viewBox", "0 0 140 140");
    this.svg.setAttribute("role", "img");

    const svgWrap = h("div", { style: { flexShrink: "0" } });
    svgWrap.appendChild(this.svg);
    this.legend = h("div", { className: "tool-legend" });
    this.distWrap = h("div", { className: "tool-dist" }, svgWrap, this.legend);
    this.empty = h("div", { className: "no-data-msg", textContent: "No tool data" });
    this.empty.hidden = true;

    this.root = h(
      "section",
      { className: "chart-card", attrs: { "aria-label": "Tool distribution" } },
      h("div", { className: "chart-header" },
        icon("wrench", 14),
        h("span", { className: "chart-title", textContent: "Tool Distribution" }),
      ),
      this.distWrap,
      this.empty,
    );
  }

  element(): HTMLElement {
    return this.root;
  }

  update(d: SessionDetail): void {
    const stats = d.tool_stats;
    if (stats.length === 0) {
      this.distWrap.hidden = true;
      this.empty.hidden = false;
      return;
    }
    this.distWrap.hidden = false;
    this.empty.hidden = true;
    this.renderDonut(stats);
    this.renderLegend(stats);
  }

  private renderDonut(stats: readonly ToolStat[]): void {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    const totalCount = total(stats);
    const label = stats
      .map((t) => `${t.name} ${Math.round((t.count / totalCount) * 100)}%`)
      .join(", ");
    this.svg.setAttribute("aria-label", `Tool distribution: ${label}`);

    const cx = 70, cy = 70, r = 48, inner = 32;
    let angle = -90;
    for (const stat of stats) {
      const sweep = (stat.count / totalCount) * 360;
      const startRad = (angle * Math.PI) / 180;
      const endRad = ((angle + sweep) * Math.PI) / 180;
      const largeArc = sweep > 180 ? 1 : 0;
      const x1 = cx + r * Math.cos(startRad);
      const y1 = cy + r * Math.sin(startRad);
      const x2 = cx + r * Math.cos(endRad);
      const y2 = cy + r * Math.sin(endRad);
      const ix1 = cx + inner * Math.cos(endRad);
      const iy1 = cy + inner * Math.sin(endRad);
      const ix2 = cx + inner * Math.cos(startRad);
      const iy2 = cy + inner * Math.sin(startRad);

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute(
        "d",
        `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${inner} ${inner} 0 ${largeArc} 0 ${ix2} ${iy2} Z`,
      );
      path.setAttribute("fill", getToolColor(stat.name));
      path.setAttribute("opacity", "0.9");
      this.svg.appendChild(path);
      angle += sweep;
    }
  }

  private renderLegend(stats: readonly ToolStat[]): void {
    while (this.legend.firstChild) this.legend.removeChild(this.legend.firstChild);
    const totalCount = total(stats);
    for (const stat of stats) {
      const pct = ((stat.count / totalCount) * 100).toFixed(1);
      this.legend.appendChild(
        h(
          "div",
          { className: "legend-item" },
          h(
            "div",
            { className: "legend-left" },
            h("div", {
              className: "legend-dot",
              style: { background: getToolColor(stat.name) },
            }),
            h("span", { className: "legend-name", textContent: stat.name }),
          ),
          h(
            "div",
            { className: "legend-right" },
            h("span", { className: "legend-count", textContent: String(stat.count) }),
            h("span", { className: "legend-pct", textContent: `${pct}%` }),
          ),
        ),
      );
    }
  }
}

const total = (stats: readonly ToolStat[]): number => stats.reduce((s, t) => s + t.count, 0);

export class ChartsRowView {
  readonly root: HTMLElement;
  private readonly contextChart = new ContextChartView();
  private readonly donut = new DonutView();

  constructor() {
    this.root = h("div", { className: "charts-row" });
    this.root.appendChild(this.contextChart.element());
    this.root.appendChild(this.donut.element());
  }

  element(): HTMLElement {
    return this.root;
  }

  update(d: SessionDetail): void {
    this.contextChart.update(d);
    this.donut.update(d);
  }
}
