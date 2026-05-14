import type { SessionDetail } from "../../../../src/domain/types";
import { fmtTimeAgo } from "../format.js";
import { h } from "../h.js";
import { icon, type IconName } from "../icons.js";

export interface DetailHeaderActions {
  onRename(): void;
  onResume(): void;
}

interface Chip {
  readonly root: HTMLElement;
  readonly label: HTMLSpanElement;
}

const buildChip = (iconName: IconName, modifier?: string): Chip => {
  const label = h("span", { className: "meta-chip-label" });
  const root = h(
    "div",
    { className: `meta-chip${modifier ? ` ${modifier}` : ""}` },
    icon(iconName, 11),
    label,
  );
  root.hidden = true;
  return { root, label };
};

const setChip = (chip: Chip, text: string): void => {
  if (text.length === 0) {
    chip.root.hidden = true;
    return;
  }
  if (chip.label.textContent !== text) chip.label.textContent = text;
  chip.root.hidden = false;
};

export class DetailHeaderView {
  private readonly root: HTMLElement;
  private readonly titleEl: HTMLHeadingElement;
  private readonly pathEl: HTMLElement;
  private readonly modelChip = buildChip("cpu", "model");
  private readonly timeChip = buildChip("clock");
  private readonly renameBtn: HTMLButtonElement;
  private readonly resumeBtn: HTMLButtonElement;
  private currentEndedAt: number | null = null;
  private timeRefreshHandle: number | null = null;
  private hasDetail = false;

  constructor(private readonly actions: DetailHeaderActions) {
    this.titleEl = h("h2", { className: "detail-title-text" });
    this.pathEl = h("div", { className: "detail-path" });

    this.renameBtn = h(
      "button",
      {
        className: "detail-action-btn",
        attrs: { type: "button", "aria-label": "Rename session" },
        on: { click: () => this.actions.onRename() },
      },
      icon("edit", 14),
      h("span", { textContent: "Rename" }),
    );

    this.resumeBtn = h(
      "button",
      {
        className: "detail-action-btn primary",
        attrs: { type: "button", "aria-label": "Resume session in a new terminal" },
        on: { click: () => this.actions.onResume() },
      },
      icon("play", 14),
      h("span", { textContent: "Resume" }),
    );

    const topRow = h(
      "div",
      { className: "detail-top-row" },
      this.titleEl,
      h("div", { className: "detail-actions" }, this.renameBtn, this.resumeBtn),
    );

    const metaRow = h(
      "div",
      { className: "detail-meta-row" },
      this.modelChip.root,
      this.timeChip.root,
    );

    this.root = h(
      "header",
      { className: "detail-header" },
      topRow,
      metaRow,
      this.pathEl,
    );

    this.setActionsEnabled(false);
  }

  element(): HTMLElement {
    return this.root;
  }

  update(d: SessionDetail): void {
    const title = d.title?.trim() || `Session ${d.session_id.slice(0, 8)}`;
    if (this.titleEl.textContent !== title) this.titleEl.textContent = title;
    this.titleEl.title = title;

    setChip(this.modelChip, d.model?.display_name ?? "");

    this.currentEndedAt = d.ended_at;
    this.refreshTimeChip();
    this.scheduleTimeRefresh();

    const path = d.cwd ?? "";
    if (this.pathEl.textContent !== path) this.pathEl.textContent = path;
    this.pathEl.hidden = path.length === 0;

    if (!this.hasDetail) {
      this.hasDetail = true;
      this.setActionsEnabled(true);
    }
  }

  dispose(): void {
    if (this.timeRefreshHandle !== null) {
      window.clearInterval(this.timeRefreshHandle);
      this.timeRefreshHandle = null;
    }
  }

  private refreshTimeChip(): void {
    setChip(this.timeChip, fmtTimeAgo(this.currentEndedAt));
  }

  private scheduleTimeRefresh(): void {
    if (this.timeRefreshHandle !== null) return;
    this.timeRefreshHandle = window.setInterval(() => this.refreshTimeChip(), 30_000);
  }

  private setActionsEnabled(enabled: boolean): void {
    this.renameBtn.disabled = !enabled;
    this.resumeBtn.disabled = !enabled;
  }
}
