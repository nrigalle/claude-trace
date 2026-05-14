import type { MemoryEditSummary, SessionDetail } from "../../../../src/domain/types";
import { fmtTimeShort } from "../format.js";
import { h } from "../h.js";
import { icon } from "../icons.js";

export interface MemorySectionActions {
  onOpenFile(filePath: string): void;
  onOpenFolder(): void;
}

export class MemorySection {
  readonly root: HTMLElement;
  private readonly headerCountEl: HTMLSpanElement;
  private readonly openFolderBtn: HTMLButtonElement;
  private readonly listEl: HTMLElement;
  private readonly rows = new Map<string, HTMLElement>();

  constructor(private readonly actions: MemorySectionActions) {
    this.headerCountEl = h("span", { className: "memory-count" });
    this.openFolderBtn = h(
      "button",
      {
        className: "memory-open-folder",
        attrs: { type: "button", "aria-label": "Open memory folder in Explorer" },
        on: { click: () => this.actions.onOpenFolder() },
      },
      icon("folder", 12),
      h("span", { textContent: "Open folder" }),
    );

    const header = h(
      "div",
      { className: "memory-header" },
      h("div", { className: "memory-title" },
        icon("edit", 14),
        h("span", { textContent: "Memory edits" }),
        this.headerCountEl,
      ),
      this.openFolderBtn,
    );

    this.listEl = h("div", { className: "memory-list", attrs: { role: "list" } });

    this.root = h(
      "section",
      { className: "memory-section", attrs: { "aria-label": "Memory edits during this session" } },
      header,
      this.listEl,
    );
    this.root.hidden = true;
  }

  element(): HTMLElement {
    return this.root;
  }

  update(detail: SessionDetail): void {
    const edits = detail.memory_edits;
    if (edits.length === 0) {
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    this.headerCountEl.textContent = `(${edits.length})`;
    this.renderRows(edits);
  }

  private renderRows(edits: readonly MemoryEditSummary[]): void {
    const seen = new Set<string>();
    let previousNode: HTMLElement | null = null;

    for (const edit of edits) {
      seen.add(edit.filePath);
      const node = this.rowFor(edit);
      const expectedNext: ChildNode | null = previousNode
        ? previousNode.nextSibling
        : this.listEl.firstChild;
      if (node !== expectedNext) this.listEl.insertBefore(node, expectedNext);
      previousNode = node;
    }

    for (const [filePath, node] of this.rows) {
      if (!seen.has(filePath)) {
        node.remove();
        this.rows.delete(filePath);
      }
    }
  }

  private rowFor(edit: MemoryEditSummary): HTMLElement {
    const cached = this.rows.get(edit.filePath);
    if (cached) {
      this.applyRowContent(cached, edit);
      return cached;
    }
    const fresh = this.buildRow(edit);
    this.rows.set(edit.filePath, fresh);
    return fresh;
  }

  private buildRow(edit: MemoryEditSummary): HTMLElement {
    const timeEl = h("span", { className: "memory-row-time" });
    const nameEl = h("span", { className: "memory-row-name" });
    const diffEl = h("span", { className: "memory-row-diff" });
    const countEl = h("span", { className: "memory-row-count" });
    countEl.hidden = true;
    const openBtn = h(
      "button",
      {
        className: "memory-row-open",
        attrs: { type: "button", "aria-label": `Open ${edit.fileName}` },
        on: { click: () => this.actions.onOpenFile(edit.filePath) },
      },
      h("span", { textContent: "Open" }),
    );

    const row = h(
      "div",
      { className: "memory-row", attrs: { role: "listitem" } },
      timeEl,
      h("div", { className: "memory-row-main" }, nameEl, countEl, diffEl),
      openBtn,
    );
    this.applyRowContent(row, edit);
    return row;
  }

  private applyRowContent(row: HTMLElement, edit: MemoryEditSummary): void {
    const timeEl = row.querySelector<HTMLSpanElement>(".memory-row-time")!;
    const nameEl = row.querySelector<HTMLSpanElement>(".memory-row-name")!;
    const diffEl = row.querySelector<HTMLSpanElement>(".memory-row-diff")!;
    const countEl = row.querySelector<HTMLSpanElement>(".memory-row-count")!;

    setText(timeEl, fmtTimeShort(edit.latestTs));
    setText(nameEl, edit.fileName);
    nameEl.title = edit.filePath;

    if (edit.count > 1) {
      setText(countEl, `×${edit.count}`);
      countEl.hidden = false;
    } else {
      countEl.hidden = true;
    }

    setText(diffEl, edit.dominantAction === "write" && edit.removed === 0
      ? `+${edit.added}`
      : `+${edit.added} / -${edit.removed}`);
  }
}

const setText = (el: HTMLElement, value: string): void => {
  if (el.textContent !== value) el.textContent = value;
};
