import type { FileEditSummary } from "../../../../src/domain/types";
import { fmtTimeShort } from "../format.js";
import { h } from "../h.js";
import { icon, type IconName } from "../icons.js";

export interface FileEditsListOptions {
  readonly title: string;
  readonly iconName: IconName;
  readonly rowActionLabel: string;
  readonly onRowAction: (filePath: string) => void;
  readonly onViewDiff?: (filePath: string) => void;
  readonly folderAction?: {
    readonly label: string;
    readonly icon: IconName;
    readonly onClick: () => void;
    readonly ariaLabel: string;
  };
  readonly ariaLabel: string;
}

export class FileEditsListView {
  readonly root: HTMLElement;
  private readonly countEl: HTMLSpanElement;
  private readonly listEl: HTMLElement;
  private readonly rows = new Map<string, HTMLElement>();

  constructor(private readonly opts: FileEditsListOptions) {
    this.countEl = h("span", { className: "file-edits-count" });

    const headerChildren: (HTMLElement | null)[] = [
      h(
        "div",
        { className: "file-edits-title" },
        icon(this.opts.iconName, 14),
        h("span", { textContent: this.opts.title }),
        this.countEl,
      ),
    ];

    if (this.opts.folderAction) {
      const folder = this.opts.folderAction;
      headerChildren.push(
        h(
          "button",
          {
            className: "file-edits-folder",
            attrs: { type: "button", "aria-label": folder.ariaLabel },
            on: { click: () => folder.onClick() },
          },
          icon(folder.icon, 12),
          h("span", { textContent: folder.label }),
        ),
      );
    }

    const header = h("div", { className: "file-edits-header" }, ...headerChildren);
    this.listEl = h("div", { className: "file-edits-list", attrs: { role: "list" } });

    this.root = h(
      "section",
      { className: "file-edits-section", attrs: { "aria-label": this.opts.ariaLabel } },
      header,
      this.listEl,
    );
    this.root.hidden = true;
  }

  element(): HTMLElement {
    return this.root;
  }

  update(edits: readonly FileEditSummary[]): void {
    if (edits.length === 0) {
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    this.countEl.textContent = `(${edits.length})`;
    this.renderRows(edits);
  }

  private renderRows(edits: readonly FileEditSummary[]): void {
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

  private rowFor(edit: FileEditSummary): HTMLElement {
    const cached = this.rows.get(edit.filePath);
    if (cached) {
      this.applyRowContent(cached, edit);
      return cached;
    }
    const fresh = this.buildRow(edit);
    this.rows.set(edit.filePath, fresh);
    return fresh;
  }

  private buildRow(edit: FileEditSummary): HTMLElement {
    const timeEl = h("span", { className: "file-edits-row-time" });
    const nameEl = h("span", { className: "file-edits-row-name" });
    const countEl = h("span", { className: "file-edits-row-count" });
    countEl.hidden = true;
    const diffEl = h("span", { className: "file-edits-row-diff" });
    const actionsHost = h("div", { className: "file-edits-row-actions" });

    if (this.opts.onViewDiff) {
      const viewDiff = this.opts.onViewDiff;
      const diffBtn = h(
        "button",
        {
          className: "file-edits-row-diff-btn",
          attrs: { type: "button", "aria-label": `View diff for ${edit.fileName}` },
          on: { click: () => viewDiff(edit.filePath) },
        },
        h("span", { textContent: "Diff" }),
      );
      actionsHost.appendChild(diffBtn);
    }

    const openBtn = h(
      "button",
      {
        className: "file-edits-row-open",
        attrs: { type: "button", "aria-label": `${this.opts.rowActionLabel} ${edit.fileName}` },
        on: { click: () => this.opts.onRowAction(edit.filePath) },
      },
      h("span", { textContent: this.opts.rowActionLabel }),
    );
    actionsHost.appendChild(openBtn);

    const row = h(
      "div",
      { className: "file-edits-row", attrs: { role: "listitem" } },
      timeEl,
      h("div", { className: "file-edits-row-main" }, nameEl, countEl, diffEl),
      actionsHost,
    );
    this.applyRowContent(row, edit);
    return row;
  }

  private applyRowContent(row: HTMLElement, edit: FileEditSummary): void {
    const timeEl = row.querySelector<HTMLSpanElement>(".file-edits-row-time")!;
    const nameEl = row.querySelector<HTMLSpanElement>(".file-edits-row-name")!;
    const diffEl = row.querySelector<HTMLSpanElement>(".file-edits-row-diff")!;
    const countEl = row.querySelector<HTMLSpanElement>(".file-edits-row-count")!;

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
