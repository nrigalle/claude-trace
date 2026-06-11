import { clear, h } from "../ui/h.js";
import type { CockpitState, CockpitWebviewToHost, TerminalSession } from "../../../src/features/cockpit/protocol";
import { toSpaceId } from "../../../src/features/cockpit/domain/profiles";
import { ICONS } from "../ui/icons.js";
import { ALL_FOLDER, newId } from "./cockpitUtils.js";

export interface FoldersBarHost {
  readonly folderBar: HTMLElement;
  readonly topbarActions: HTMLElement;
  state(): CockpitState;
  groupWindows(): Map<string, TerminalSession[]>;
  windowFolder(windowId: string): string | null;
  activeFolder(): string;
  setActiveFolder(folder: string): void;
  creatingFolder(): boolean;
  setCreatingFolder(v: boolean): void;
  renamingFolder(): string | null;
  setRenamingFolder(v: string | null): void;
  folderNeedsAttention(folder: string): boolean;
  attentionCount(): number;
  jumpToAttention(): void;
  launcherOpen(): boolean;
  toggleLauncher(): void;
  fullscreen(): boolean;
  toggleFullscreen(): void;
  send(msg: CockpitWebviewToHost): void;
  rerender(): void;
  renderGrid(): void;
}

export const renderFoldersBar = (host: FoldersBarHost): void => {
  clear(host.folderBar);
  clear(host.topbarActions);
  const groups = host.groupWindows();
  const windowCount = (folder: string | null): number =>
  [...groups.keys()].filter((wid) => (host.windowFolder(wid) ?? null) === folder).length;

  const tab = (label: string, value: string, count: number, renamable = false) => {
    const el = h(
      "button",
      {
        className: `tc-folder${host.activeFolder() === value ? " active" : ""}`,
        attrs: { type: "button", "data-folder": value, ...(renamable ? { title: "Double-click to rename. Drop a session here to file it in this workspace." } : {}) },
        on: { click: () => { host.setActiveFolder(value); host.rerender(); host.renderGrid(); } },
      },
      h("span", { className: "tc-folder-icon", innerHTML: ICONS.folder }),
      h("span", { textContent: label }),
      h("span", { className: "tc-folder-count", textContent: String(count) }),
      h("span", {
          className: `tc-folder-dot${host.folderNeedsAttention(value) ? " on" : ""}`,
          attrs: { "aria-hidden": "true" },
        }),
    );
    if (renamable) {
      el.addEventListener("dblclick", (e) => {
          e.preventDefault();
          host.setRenamingFolder(value);
          host.rerender();
        });
      el.appendChild(
        h("span", {
            className: "tc-folder-del",
            attrs: { role: "button", title: "Delete workspace", "aria-label": `Delete workspace ${label}` },
            innerHTML: ICONS.close,
            on: {
              click: (e: Event) => {
                e.stopPropagation();
                if (host.activeFolder() === value) host.setActiveFolder(ALL_FOLDER);
                host.send({ type: "cockpitDeleteSpace", spaceId: toSpaceId(value) });
              },
            },
          }),
      );
    }
    return el;
  };

  host.folderBar.appendChild(tab("All", ALL_FOLDER, groups.size));
  for (const space of host.state().spaces) {
    if (host.renamingFolder() === space.id) {
      host.folderBar.appendChild(folderRenameInput(host, space.id, space.name));
    } else {
      host.folderBar.appendChild(tab(space.name, space.id, windowCount(space.id), true));
    }
  }

  if (host.creatingFolder()) {
    const input = h("input", { className: "tc-folder-input", attrs: { type: "text", placeholder: "Workspace name" } }) as HTMLInputElement;
    input.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" && input.value.trim().length > 0) {
          host.send({ type: "cockpitSaveSpace", space: { id: toSpaceId(newId()), name: input.value.trim() } });
          host.setCreatingFolder(false);
        } else if (e.key === "Escape") {
          host.setCreatingFolder(false);
          host.rerender();
        }
      });
    input.addEventListener("blur", () => { host.setCreatingFolder(false); host.rerender(); });
    host.folderBar.appendChild(input);
    requestAnimationFrame(() => input.focus());
  } else {
    host.folderBar.appendChild(
      h("button", {
          className: "tc-folder-add",
          attrs: { type: "button", title: "Create a workspace to group your sessions", "aria-label": "New workspace" },
          on: { click: () => { host.setCreatingFolder(true); host.rerender(); } },
        },
        h("span", { className: "tc-folder-add-icon", innerHTML: ICONS.plus }),
        h("span", { textContent: "New workspace" }),
      ),
    );
    if (host.state().spaces.length === 0) {
      host.folderBar.appendChild(
        h("span", { className: "tc-folder-hint", textContent: "Group sessions into workspaces" }),
      );
    }
  }

  const attentionCount = host.attentionCount();
  host.topbarActions.appendChild(
    h("button", {
        className: `tc-attention-jump${attentionCount > 0 ? " on" : ""}`,
        attrs: {
          type: "button",
          title: attentionCount === 0 ? "No sessions need attention" : `${attentionCount} session${attentionCount === 1 ? "" : "s"} need attention. Jump to the oldest one.`,
          "aria-label": attentionCount === 0 ? "No sessions need attention" : `${attentionCount} session${attentionCount === 1 ? "" : "s"} need attention. Jump to the oldest one.`,
          ...(attentionCount === 0 ? { disabled: "true" } : {}),
        },
        innerHTML: `<span class="tc-btn-icon">${ICONS.bell}</span><span class="tc-attention-count">${attentionCount}</span>`,
        on: { click: () => host.jumpToAttention() },
      }),
  );

  host.topbarActions.appendChild(
    h("button", {
        className: "tc-newterminal",
        attrs: { type: "button", title: "Open a plain shell terminal" },
        innerHTML: `<span class="tc-btn-icon">${ICONS.terminal}</span><span>Terminal</span>`,
        on: { click: () => host.send({ type: "cockpitNewTerminal", spaceId: host.activeFolder() === ALL_FOLDER ? null : host.activeFolder() }) },
      }),
  );

  host.topbarActions.appendChild(
    h("button", {
        className: `tc-newsession${host.launcherOpen() ? " active" : ""}`,
        attrs: { type: "button" },
        innerHTML: `<span class="tc-btn-icon">${ICONS.plus}</span><span>Session</span>`,
        on: { click: () => host.toggleLauncher() },
      }),
  );

  host.topbarActions.appendChild(
    h("button", {
        className: `tc-expand${host.fullscreen() ? " active" : ""}`,
        attrs: {
          type: "button",
          title: host.fullscreen() ? "Exit full screen" : "Full screen",
          "aria-label": host.fullscreen() ? "Exit full screen" : "Full screen",
        },
        innerHTML: host.fullscreen() ? ICONS.shrink : ICONS.expand,
        on: { click: () => host.toggleFullscreen() },
      }),
  );
};

const folderRenameInput = (host: FoldersBarHost, spaceId: string, currentName: string): HTMLElement => {
  const input = h("input", {
      className: "tc-folder-input",
      attrs: { type: "text", value: currentName, "aria-label": "Rename workspace" },
    }) as HTMLInputElement;
  let done = false;
  const commit = (save: boolean): void => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name.length > 0 && name !== currentName) {
      host.send({ type: "cockpitSaveSpace", space: { id: toSpaceId(spaceId), name } });
    }
    host.setRenamingFolder(null);
    host.rerender();
  };
  input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") commit(true);
      else if (e.key === "Escape") commit(false);
    });
  input.addEventListener("blur", () => commit(true));
  requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  return input;
};
