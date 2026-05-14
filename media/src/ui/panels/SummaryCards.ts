import type { SessionDetail } from "../../../../src/domain/types";
import { fmtCost, fmtDuration, fmtPct, fmtTokens } from "../format.js";
import { h } from "../h.js";
import { icon, type IconName } from "../icons.js";

interface CardRef {
  root: HTMLElement;
  iconHost: HTMLElement;
  valueEl: HTMLSpanElement;
  subEl: HTMLDivElement;
}

export class SummaryCardsView {
  private readonly root: HTMLElement;
  private readonly duration: CardRef;
  private readonly tools: CardRef;
  private readonly cost: CardRef;
  private readonly context: CardRef;
  private readonly tokens: CardRef;
  private readonly lines: CardRef;

  constructor() {
    this.root = h("div", { className: "summary-cards" });
    this.duration = this.appendCard("clock", "Duration", "var(--ct-blue)");
    this.tools = this.appendCard("wrench", "Tool Calls", "var(--ct-purple)");
    this.cost = this.appendCard("dollar", "Cost", "var(--ct-claude)");
    this.context = this.appendCard("cpu", "Context", "var(--ct-green)");
    this.tokens = this.appendCard("trending", "Tokens", "var(--ct-teal)");
    this.lines = this.appendCard("file", "Lines", "var(--ct-green)");
  }

  element(): HTMLElement {
    return this.root;
  }

  update(d: SessionDetail): void {
    const costUsd = d.cost?.total_cost_usd ?? 0;
    const ctxPct = d.context_window?.used_percentage ?? 0;
    const inTok = d.context_window?.total_input_tokens ?? 0;
    const outTok = d.context_window?.total_output_tokens ?? 0;
    const added = d.cost?.total_lines_added ?? 0;
    const removed = d.cost?.total_lines_removed ?? 0;

    setValue(this.duration, fmtDuration(d.duration_ms));
    setValue(this.tools, String(d.tool_count));
    setValue(this.cost, fmtCost(costUsd));

    const ctxColor =
      ctxPct > 80 ? "var(--ct-red)" : ctxPct > 50 ? "var(--ct-amber)" : "var(--ct-green)";
    this.context.iconHost.style.background = `${ctxColor}15`;
    this.context.iconHost.style.color = ctxColor;
    setValue(this.context, fmtPct(ctxPct));

    setValue(this.tokens, fmtTokens(inTok + outTok));
    setSub(this.tokens, `${fmtTokens(inTok)} in / ${fmtTokens(outTok)} out`);

    setValue(this.lines, `+${added} / -${removed}`);
  }

  private appendCard(iconName: IconName, label: string, color: string): CardRef {
    const iconHost = h("div", {
      className: "card-icon",
      style: { background: `${color}15`, color },
    });
    iconHost.appendChild(icon(iconName, 14));

    const labelEl = h("span", { className: "card-label", textContent: label });
    const valueEl = h("span", { className: "card-value" });
    const subEl = h("div", { className: "card-sub" });
    subEl.hidden = true;

    const root = h(
      "div",
      { className: "card", attrs: { role: "group", "aria-label": label } },
      h("div", { className: "card-top" }, iconHost, labelEl),
      valueEl,
      subEl,
    );

    this.root.appendChild(root);
    return { root, iconHost, valueEl, subEl };
  }
}

const setValue = (card: CardRef, value: string): void => {
  if (card.valueEl.textContent !== value) card.valueEl.textContent = value;
};

const setSub = (card: CardRef, sub: string): void => {
  if (card.subEl.textContent !== sub) card.subEl.textContent = sub;
  card.subEl.hidden = sub.length === 0;
};
