import { h } from "../ui/h.js";

export const renderSkeletonTiles = (gridEl: HTMLElement): void => {
  if (gridEl.querySelector(".tc-skel-tile")) return;
  gridEl.classList.remove("empty");
  for (let i = 0; i < 4; i++) {
    gridEl.appendChild(
      h("div", { className: "tc-skel-tile" }, h("div", { className: "tc-skel-head" }), h("div", { className: "tc-skel-body" })),
    );
  }
};
