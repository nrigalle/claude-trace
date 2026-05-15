import type { SessionDetail } from "../../../../src/domain/types";
import { FileEditsListView } from "./FileEditsListView.js";

export interface FilesTouchedSectionActions {
  onOpenFile(filePath: string): void;
}

export class FilesTouchedSection {
  private readonly view: FileEditsListView;

  constructor(actions: FilesTouchedSectionActions) {
    this.view = new FileEditsListView({
      title: "Files touched",
      iconName: "file",
      rowActionLabel: "Open",
      onRowAction: (filePath) => actions.onOpenFile(filePath),
      ariaLabel: "Files edited during this session",
    });
  }

  element(): HTMLElement {
    return this.view.element();
  }

  update(detail: SessionDetail): void {
    this.view.update(detail.files_touched);
  }
}
