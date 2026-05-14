import type { ChartPoint } from "../../../../src/domain/types";
import { fmtTimeShort } from "../format.js";
import { h } from "../h.js";

export interface AreaChartOptions {
  readonly maxYClamp: number;
  readonly maxYStep: number;
  readonly warnLine: number | null;
  readonly stroke: string;
  readonly fillTop: string;
  readonly fillBottom: string;
  readonly yLabel: (v: number) => string;
  readonly tooltipValue: (v: number) => string;
}

interface Layout {
  readonly width: number;
  readonly height: number;
  readonly padLeft: number;
  readonly padRight: number;
  readonly padTop: number;
  readonly padBottom: number;
  readonly chartWidth: number;
  readonly chartHeight: number;
  readonly minTs: number;
  readonly rangeTs: number;
  readonly maxY: number;
}

const CHART_HEIGHT = 180;

export class AreaChart {
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly cursor: HTMLElement;
  private readonly tooltip: HTMLElement;

  private data: readonly ChartPoint[] = [];
  private layout: Layout | null = null;

  constructor(private readonly opts: AreaChartOptions, ariaLabel: string) {
    this.canvas = h("canvas", { attrs: { role: "img", "aria-label": ariaLabel } });
    this.cursor = h("div", { className: "chart-cursor" });
    this.cursor.hidden = true;
    this.tooltip = h("div", { className: "chart-tooltip" });
    this.tooltip.hidden = true;

    this.root = h("div", { className: "chart-body" }, this.canvas, this.cursor, this.tooltip);

    this.canvas.addEventListener("mousemove", (e) => this.onMouseMove(e));
    this.canvas.addEventListener("mouseleave", () => this.hideHover());
  }

  element(): HTMLElement {
    return this.root;
  }

  update(data: readonly ChartPoint[]): void {
    this.data = data;
    this.hideHover();
    this.draw();
  }

  private draw(): void {
    if (this.data.length < 2) {
      this.layout = null;
      return;
    }

    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = Math.max(parent.getBoundingClientRect().width, 200);
    const dpr = window.devicePixelRatio || 1;

    this.canvas.width = w * dpr;
    this.canvas.height = CHART_HEIGHT * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${CHART_HEIGHT}px`;

    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, CHART_HEIGHT);

    const padLeft = 44;
    const padRight = 12;
    const padTop = 10;
    const padBottom = 14;
    const chartWidth = w - padLeft - padRight;
    const chartHeight = CHART_HEIGHT - padTop - padBottom;

    const peak = Math.max(...this.data.map((d) => d.value));
    const maxY = Math.min(
      Math.ceil(peak / this.opts.maxYStep) * this.opts.maxYStep + this.opts.maxYStep,
      this.opts.maxYClamp,
    );

    const minTs = this.data[0]!.ts;
    const maxTs = this.data[this.data.length - 1]!.ts;
    const rangeTs = maxTs - minTs || 1;

    this.layout = {
      width: w,
      height: CHART_HEIGHT,
      padLeft,
      padRight,
      padTop,
      padBottom,
      chartWidth,
      chartHeight,
      minTs,
      rangeTs,
      maxY,
    };

    this.drawGrid(ctx);
    this.drawWarnLine(ctx);
    this.drawArea(ctx);
    this.drawLine(ctx);
  }

  private drawGrid(ctx: CanvasRenderingContext2D): void {
    const layout = this.layout!;
    const style = getComputedStyle(this.canvas);
    const gridColor = style.getPropertyValue("--ct-grid").trim() || "#27272a";
    const dimColor = style.getPropertyValue("--ct-text-dim").trim() || "#52525b";

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.font = "10px sans-serif";
    ctx.fillStyle = dimColor;
    ctx.textAlign = "right";

    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const value = (layout.maxY / steps) * i;
      const py = this.yPos(value);
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.moveTo(layout.padLeft, py);
      ctx.lineTo(layout.width - layout.padRight, py);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText(this.opts.yLabel(value), layout.padLeft - 6, py + 3);
    }
  }

  private drawWarnLine(ctx: CanvasRenderingContext2D): void {
    const layout = this.layout!;
    const warn = this.opts.warnLine;
    if (warn === null || warn > layout.maxY) return;
    ctx.strokeStyle = "rgba(239, 68, 68, 0.35)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(layout.padLeft, this.yPos(warn));
    ctx.lineTo(layout.width - layout.padRight, this.yPos(warn));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawArea(ctx: CanvasRenderingContext2D): void {
    const layout = this.layout!;
    const gradient = ctx.createLinearGradient(0, layout.padTop, 0, layout.padTop + layout.chartHeight);
    gradient.addColorStop(0, this.opts.fillTop);
    gradient.addColorStop(1, this.opts.fillBottom);

    ctx.beginPath();
    ctx.moveTo(this.xPos(this.data[0]!.ts), this.yPos(this.data[0]!.value));
    for (let i = 1; i < this.data.length; i++) {
      ctx.lineTo(this.xPos(this.data[i]!.ts), this.yPos(this.data[i]!.value));
    }
    ctx.lineTo(this.xPos(this.data[this.data.length - 1]!.ts), layout.padTop + layout.chartHeight);
    ctx.lineTo(this.xPos(this.data[0]!.ts), layout.padTop + layout.chartHeight);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  private drawLine(ctx: CanvasRenderingContext2D): void {
    ctx.beginPath();
    ctx.moveTo(this.xPos(this.data[0]!.ts), this.yPos(this.data[0]!.value));
    for (let i = 1; i < this.data.length; i++) {
      ctx.lineTo(this.xPos(this.data[i]!.ts), this.yPos(this.data[i]!.value));
    }
    ctx.strokeStyle = this.opts.stroke;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  private xPos(ts: number): number {
    const layout = this.layout!;
    return layout.padLeft + ((ts - layout.minTs) / layout.rangeTs) * layout.chartWidth;
  }

  private yPos(value: number): number {
    const layout = this.layout!;
    return layout.padTop + (1 - value / layout.maxY) * layout.chartHeight;
  }

  private onMouseMove(event: MouseEvent): void {
    if (!this.layout || this.data.length === 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x < this.layout.padLeft || x > this.layout.width - this.layout.padRight) {
      this.hideHover();
      return;
    }

    const point = this.nearestPoint(x);
    if (!point) return;

    const px = this.xPos(point.ts);
    const py = this.yPos(point.value);

    this.cursor.hidden = false;
    this.cursor.style.left = `${px}px`;
    this.cursor.style.top = `${this.layout.padTop}px`;
    this.cursor.style.height = `${this.layout.chartHeight}px`;

    this.tooltip.hidden = false;
    this.tooltip.textContent = `${fmtTimeShort(point.ts)} · ${this.opts.tooltipValue(point.value)}`;
    const tooltipWidth = this.tooltip.offsetWidth || 80;
    const left = Math.max(
      this.layout.padLeft,
      Math.min(px - tooltipWidth / 2, this.layout.width - this.layout.padRight - tooltipWidth),
    );
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${Math.max(0, py - 28)}px`;
  }

  private nearestPoint(x: number): ChartPoint | null {
    if (this.data.length === 0) return null;
    let lo = 0;
    let hi = this.data.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const px = this.xPos(this.data[mid]!.ts);
      if (px < x) lo = mid;
      else hi = mid;
    }
    const left = this.data[lo]!;
    const right = this.data[hi]!;
    return Math.abs(this.xPos(left.ts) - x) <= Math.abs(this.xPos(right.ts) - x) ? left : right;
  }

  private hideHover(): void {
    this.cursor.hidden = true;
    this.tooltip.hidden = true;
  }
}
