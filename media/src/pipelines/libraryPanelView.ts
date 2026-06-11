import { h } from "../ui/h.js";
import type { BlockKind } from "../../../src/features/pipelines/domain/types";
import { LIBRARY } from "./pipelineCatalog.js";

export const renderLibraryBody = (panelBody: HTMLElement, insertBlock: (kind: BlockKind) => void): void => {
  for (const entry of LIBRARY) {
    panelBody.appendChild(
      h(
        "button",
        {
          className: "pl-library-item",
          attrs: { type: "button" },
          on: { click: () => insertBlock(entry.kind) },
        },
        h("div", {
            className: `pl-library-icon kind-${entry.kind}`,
            innerHTML: entry.icon,
          }),
        h(
          "div",
          {},
          h("div", { className: "pl-library-name" }, h("span", { textContent: entry.label })),
          h("div", { className: "pl-library-desc", textContent: entry.description }),
        ),
      ),
    );
  }
  panelBody.appendChild(
    h(
      "div",
      { className: "pl-field-hint", style: { marginTop: "12px" } },
      h("span", {
          textContent:
          "An Orchestrator is automatically inserted after every block. It judges whether the step finished or needs your input.",
        }),
    ),
  );
};
