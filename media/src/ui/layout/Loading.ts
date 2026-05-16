import { h } from "../h.js";

const SIDEBAR_SKELETON_COUNT = 6;

export const renderSidebarSkeletons = (): readonly HTMLElement[] => {
  const out: HTMLElement[] = [];
  for (let i = 0; i < SIDEBAR_SKELETON_COUNT; i++) {
    out.push(
      h(
        "div",
        { className: "session-item-skeleton", attrs: { "aria-hidden": "true" } },
        h("div", { className: "skeleton skeleton-line" }),
        h("div", { className: "skeleton skeleton-line short" }),
        h("div", { className: "skeleton skeleton-line" }),
      ),
    );
  }
  return out;
};

export const renderMainSkeleton = (): HTMLElement =>
  h(
    "div",
    { className: "main-skeleton", attrs: { "aria-hidden": "true" } },
    h("div", { className: "skeleton skeleton-block main-skeleton-header" }),
    h(
      "div",
      { className: "main-skeleton-row" },
      h("div", { className: "skeleton skeleton-block main-skeleton-card" }),
      h("div", { className: "skeleton skeleton-block main-skeleton-card" }),
      h("div", { className: "skeleton skeleton-block main-skeleton-card" }),
      h("div", { className: "skeleton skeleton-block main-skeleton-card" }),
    ),
    h("div", { className: "skeleton skeleton-block main-skeleton-chart" }),
    h("div", { className: "skeleton skeleton-block main-skeleton-list" }),
  );
