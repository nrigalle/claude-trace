import type { SessionDetail } from "../../../../src/domain/types";
import { h } from "../h.js";

export class DetailHeaderView {
  private readonly root: HTMLElement;
  private readonly titleEl: HTMLHeadingElement;
  private readonly modelBadge: HTMLSpanElement;
  private readonly subtitleEl: HTMLElement;
  private readonly pathEl: HTMLElement;

  constructor() {
    this.titleEl = h("h2", {});
    this.modelBadge = h("span", { className: "model-badge" });
    this.modelBadge.hidden = true;
    this.subtitleEl = h("div", { className: "detail-subtitle" });
    this.pathEl = h("div", { className: "detail-path" });

    this.root = h(
      "header",
      { className: "detail-header" },
      h("div", { className: "detail-title" }, this.titleEl, this.modelBadge),
      this.subtitleEl,
      this.pathEl,
    );
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
  }
}
