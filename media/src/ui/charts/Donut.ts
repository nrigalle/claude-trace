import type { ToolStat } from "../../../../src/domain/types";
import { getToolColor } from "../icons.js";

const NS = "http://www.w3.org/2000/svg";

export const renderDonut = (stats: readonly ToolStat[]): SVGSVGElement | null => {
  if (stats.length === 0) return null;
  const total = stats.reduce((s, t) => s + t.count, 0);
  const size = 140;
  const cx = size / 2;
  const cy = size / 2;
  const r = 48;
  const inner = 32;
  let angle = -90;

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("role", "img");
  const label = stats
    .map((t) => `${t.name} ${Math.round((t.count / total) * 100)}%`)
    .join(", ");
  svg.setAttribute("aria-label", `Tool distribution: ${label}`);

  for (const t of stats) {
    const pct = t.count / total;
    const sweep = pct * 360;
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

    const path = document.createElementNS(NS, "path");
    path.setAttribute(
      "d",
      `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${inner} ${inner} 0 ${largeArc} 0 ${ix2} ${iy2} Z`,
    );
    path.setAttribute("fill", getToolColor(t.name));
    path.setAttribute("opacity", "0.9");
    svg.appendChild(path);
    angle += sweep;
  }
  return svg;
};
