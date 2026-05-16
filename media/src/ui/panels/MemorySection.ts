import type { SessionDetail } from "../../../../src/domain/types";
import { FileEditsListView } from "./FileEditsListView.js";

export interface MemorySectionActions {
  onOpenFile(filePath: string): void;
  onOpenFolder(): void;
  onViewDiff(filePath: string): void;
}

export class MemorySection {
  private readonly view: FileEditsListView;

  constructor(actions: MemorySectionActions) {
    this.view = new FileEditsListView({
      title: "Memory edits",
      iconName: "edit",
      rowActionLabel: "Open",
      onRowAction: (filePath) => actions.onOpenFile(filePath),
      onViewDiff: (filePath) => actions.onViewDiff(filePath),
      folderAction: {
        label: "Open folder",
        icon: "folder",
        ariaLabel: "Open memory folder in Explorer",
        onClick: () => actions.onOpenFolder(),
      },
      ariaLabel: "Memory edits during this session",
    });
  }

  element(): HTMLElement {
    return this.view.element();
  }

  update(detail: SessionDetail): void {
    this.view.update(detail.memory_edits);
  }
}
