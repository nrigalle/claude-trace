import { h } from "../ui/h.js";
import { ICONS } from "../ui/icons.js";
import { buildDropdown, type DropdownEl } from "../ui/dropdown.js";
import { PERMISSION_MODES, type PermissionMode } from "../../../src/shared/permissionModes";
import { MODEL_OPTIONS, DEFAULT_MODEL_CHOICE, type ModelChoice } from "../../../src/shared/models";

const field = (label: string, control: HTMLElement): HTMLElement =>
  h(
    "div",
    { className: "tc-resume-field" },
    h("span", { className: "tc-resume-field-label", textContent: label }),
    control,
  );

export interface ResumeOverlay {
  readonly root: HTMLElement;
  readonly modelDd: DropdownEl;
}

export const buildResumeOverlay = (
  onResume: (button: HTMLButtonElement, permissionMode: PermissionMode | null, model: ModelChoice) => void,
): ResumeOverlay => {
  const modelDd = buildDropdown({
    value: DEFAULT_MODEL_CHOICE,
    options: MODEL_OPTIONS.map((m) => ({ value: m.id, label: m.label })),
    ariaLabel: "Model for the resumed session",
    wrapClass: "tc-resume-model",
  });

  const permDd = buildDropdown({
    value: "",
    options: [
      { value: "", label: "Same permissions as before" },
      ...PERMISSION_MODES.map((m) => ({ value: m.mode, label: m.label })),
    ],
    ariaLabel: "Permission mode for the resumed session",
    wrapClass: "tc-resume-perm",
  });

  const resumeBtn = h("button", {
    className: "tc-launch-btn tc-resume-btn",
    attrs: { type: "button" },
    innerHTML: `<span class="tc-btn-icon">${ICONS.play}</span><span>Resume</span>`,
    on: {
      click: (e) => {
        const perm = permDd.getDropdownValue();
        onResume(
          e.currentTarget as HTMLButtonElement,
          perm === "" ? null : (perm as PermissionMode),
          modelDd.getDropdownValue() as ModelChoice,
        );
      },
    },
  });

  const root = h(
    "div",
    { className: "tc-tile-resume hidden" },
    h(
      "div",
      { className: "tc-resume-card" },
      h("div", { className: "tc-resume-icon", innerHTML: ICONS.pause, attrs: { "aria-hidden": "true" } }),
      h("div", { className: "tc-resume-title", textContent: "Session paused" }),
      h("div", { className: "tc-resume-sub", textContent: "Picks up from the saved transcript." }),
      field("Model", modelDd),
      field("Permissions", permDd),
      resumeBtn,
    ),
  );

  return { root, modelDd };
};
