import type { ChartPoint } from "../../../../src/domain/types";
import { fmtTimeShort } from "../format.js";

const LABEL_PX_BUDGET = 70;

interface AreaOpts {
  readonly maxYClamp: number;
  readonly warnLine: number | null;
  readonly stroke: string;
  readonly fillTop: string;
  readonly fillBottom: string;
  readonly yLabel: (v: number) => string;
  readonly maxYStep: number;
}

const sizeCache = new WeakMap<HTMLCanvasElement, { w: number; dpr: number }>();

export const renderAreaChart = (
  canvas: HTMLCanvasElement,
  data: readonly ChartPoint[],
  opts: AreaOpts,
): void => {
  if (data.length < 2) return;
  const parent = canvas.parentElement;
  if (!parent) return;

  const rect = parent.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(rect.width, 200);
  const chartH = 180;

  const last = sizeCache.get(canvas);
  if (!last || last.w !== w || last.dpr !== dpr) {
    canvas.width = w * dpr;
    canvas.height = chartH * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${chartH}px`;
    sizeCache.set(canvas, { w, dpr });
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, chartH);

  const pad = { top: 10, right: 10, bottom: 24, left: 44 };
  const cw = w - pad.left - pad.right;
  const ch = chartH - pad.top - pad.bottom;

  const peak = Math.max(...data.map((d) => d.value));
  const maxY = Math.min(Math.ceil(peak / opts.maxYStep) * opts.maxYStep + opts.maxYStep, opts.maxYClamp);
  const minTs = data[0]!.ts;
  const maxTs = data[data.length - 1]!.ts;
  const rangeTs = maxTs - minTs || 1;

  const xPos = (ts: number) => pad.left + ((ts - minTs) / rangeTs) * cw;
  const yPos = (v: number) => pad.top + (1 - v / maxY) * ch;

  ctx.strokeStyle = "var(--ct-grid, #27272a)";
  ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue("--ct-grid") || "#27272a";
  ctx.lineWidth = 1;
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--ct-text-dim") || "#52525b";

  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const v = (maxY / steps) * i;
    const py = yPos(v);
    ctx.beginPath();
    ctx.setLineDash([3, 3]);
    ctx.moveTo(pad.left, py);
    ctx.lineTo(w - pad.right, py);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText(opts.yLabel(v), pad.left - 6, py + 3);
  }

  if (opts.warnLine !== null && opts.warnLine <= maxY) {
    ctx.strokeStyle = "rgba(239, 68, 68, 0.35)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, yPos(opts.warnLine));
    ctx.lineTo(w - pad.right, yPos(opts.warnLine));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
  grad.addColorStop(0, opts.fillTop);
  grad.addColorStop(1, opts.fillBottom);
  ctx.beginPath();
  ctx.moveTo(xPos(data[0]!.ts), yPos(data[0]!.value));
  for (let i = 1; i < data.length; i++) {
    ctx.lineTo(xPos(data[i]!.ts), yPos(data[i]!.value));
  }
  ctx.lineTo(xPos(data[data.length - 1]!.ts), pad.top + ch);
  ctx.lineTo(xPos(data[0]!.ts), pad.top + ch);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(xPos(data[0]!.ts), yPos(data[0]!.value));
  for (let i = 1; i < data.length; i++) {
    ctx.lineTo(xPos(data[i]!.ts), yPos(data[i]!.value));
  }
  ctx.strokeStyle = opts.stroke;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.stroke();

  ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--ct-text-dim") || "#52525b";
  ctx.font = "10px sans-serif";
  const maxLabels = Math.max(2, Math.min(5, Math.floor(cw / LABEL_PX_BUDGET)));
  const labelCount = Math.min(maxLabels, data.length);
  for (let i = 0; i < labelCount; i++) {
    const idx = Math.floor((i * (data.length - 1)) / Math.max(labelCount - 1, 1));
    const x = xPos(data[idx]!.ts);
    if (i === 0) ctx.textAlign = "left";
    else if (i === labelCount - 1) ctx.textAlign = "right";
    else ctx.textAlign = "center";
    ctx.fillText(fmtTimeShort(data[idx]!.ts), x, chartH - 4);
  }
};
