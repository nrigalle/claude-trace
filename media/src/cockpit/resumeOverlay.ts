import { h } from "../ui/h.js";
import { ICONS } from "../ui/icons.js";
import { PERMISSION_MODES, type PermissionMode } from "../../../src/shared/permissionModes";

export const buildResumeOverlay = (
  onResume: (button: HTMLButtonElement, permissionMode: PermissionMode | null) => void,
): HTMLElement => {
  const permissionSel = h(
    "select",
    { className: "tc-resume-permission", attrs: { title: "Permission mode for the resumed session", "aria-label": "Permission mode for the resumed session" } },
    h("option", { attrs: { value: "" }, textContent: "Same permissions as before" }),
    ...PERMISSION_MODES.map((m) =>
      h("option", { attrs: { value: m.mode, title: m.oneLine }, textContent: m.label }),
    ),
  ) as HTMLSelectElement;
  return h(
    "div",
    { className: "tc-tile-resume hidden" },
    permissionSel,
    h("button", {
      className: "tc-launch-btn",
      attrs: { type: "button" },
      innerHTML: `<span class="tc-btn-icon">${ICONS.play}</span><span>Resume</span>`,
      on: {
        click: (e) => {
          const picked = permissionSel.value;
          onResume(e.currentTarget as HTMLButtonElement, picked === "" ? null : (picked as PermissionMode));
        },
      },
    }),
    h("div", { className: "tc-tile-resume-hint", textContent: "Paused or exited. Click Resume to continue. The transcript reloads from disk." }),
  );
};
