import type { SessionDetail } from "../../../../src/features/dashboard/domain/types";
import { FileEditsListView } from "./FileEditsListView.js";

export interface FilesTouchedSectionActions {
  onOpenFile(filePath: string): void;
  onViewDiff(filePath: string): void;
  isCollapsed(): boolean;
  onToggleCollapsed(): void;
}

export class FilesTouchedSection {
  private readonly view: FileEditsListView;

  constructor(actions: FilesTouchedSectionActions) {
    this.view = new FileEditsListView({
      title: "Files touched",
      iconName: "file",
      rowActionLabel: "Open",
      onRowAction: (filePath) => actions.onOpenFile(filePath),
      onViewDiff: (filePath) => actions.onViewDiff(filePath),
      ariaLabel: "Files edited during this session",
      collapsed: () => actions.isCollapsed(),
      onToggleCollapsed: () => actions.onToggleCollapsed(),
    });
  }

  element(): HTMLElement {
    return this.view.element();
  }

  update(detail: SessionDetail): void {
    this.view.update(detail.files_touched);
  }
}
