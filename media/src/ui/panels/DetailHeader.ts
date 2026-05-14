import type { SessionDetail } from "../../../../src/domain/types";
import { h } from "../h.js";
import { icon } from "../icons.js";

export interface DetailHeaderActions {
  onRename(): void;
  onResume(): void;
}

export class DetailHeaderView {
  private readonly root: HTMLElement;
  private readonly titleEl: HTMLHeadingElement;
  private readonly modelBadge: HTMLSpanElement;
  private readonly subtitleEl: HTMLElement;
  private readonly pathEl: HTMLElement;
  private readonly renameBtn: HTMLButtonElement;
  private readonly resumeBtn: HTMLButtonElement;
  private hasDetail = false;

  constructor(private readonly actions: DetailHeaderActions) {
    this.titleEl = h("h2", {});
    this.modelBadge = h("span", { className: "model-badge" });
    this.modelBadge.hidden = true;
    this.subtitleEl = h("div", { className: "detail-subtitle" });
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

    const titleRow = h(
      "div",
      { className: "detail-title-row" },
      h("div", { className: "detail-title" }, this.titleEl, this.modelBadge),
      h("div", { className: "detail-actions" }, this.renameBtn, this.resumeBtn),
    );

    this.root = h(
      "header",
      { className: "detail-header" },
      titleRow,
      this.subtitleEl,
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

    const project = d.cwd ? d.cwd.split("/").pop() ?? "" : "";
    if (this.subtitleEl.textContent !== project) this.subtitleEl.textContent = project;
    this.subtitleEl.hidden = project.length === 0;

    const model = d.model?.display_name ?? null;
    if (model) {
      this.modelBadge.hidden = false;
      if (this.modelBadge.textContent !== model) this.modelBadge.textContent = model;
    } else {
      this.modelBadge.hidden = true;
    }

    const path = d.cwd ?? d.session_id;
    if (this.pathEl.textContent !== path) this.pathEl.textContent = path;

    if (!this.hasDetail) {
      this.hasDetail = true;
      this.setActionsEnabled(true);
    }
  }

  private setActionsEnabled(enabled: boolean): void {
    this.renameBtn.disabled = !enabled;
    this.resumeBtn.disabled = !enabled;
  }
}
