import { DEFAULT_MODEL_CHOICE, EFFORT_OPTIONS, MODEL_OPTIONS, modelEffortLevels, type EffortChoice, type ModelChoice } from "../../../src/shared/models";
import { PERMISSION_MODES, type PermissionMode } from "../../../src/shared/permissionModes";
import {
  DEFAULT_NAME_TEMPLATE,
  MAX_BATCH,
  clampCount,
  toProfileId,
  toSpaceId,
  type SessionProfile,
} from "../../../src/features/cockpit/domain/profiles";
import type { CockpitState, CockpitWebviewToHost } from "../../../src/features/cockpit/protocol";
import { ICONS } from "../ui/icons.js";
import { clear, h } from "../ui/h.js";
import { decorateTextarea } from "../ui/textarea.js";
import { ALL_FOLDER, newId } from "./cockpitUtils.js";

interface LauncherDeps {
  send(msg: CockpitWebviewToHost): void;
  rerender(): void;
  setActiveFolder(folder: string): void;
}

export class CockpitLauncher {
  private open = false;
  private editing: SessionProfile | null = null;
  private quickCount = 1;
  private quickPrefill: SessionProfile | null = null;
  private cwdInput: HTMLInputElement | null = null;

  constructor(private readonly deps: LauncherDeps) {}

  isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    this.open = !this.open;
    this.deps.rerender();
  }

  openForNew(): void {
    this.open = true;
    this.deps.rerender();
  }

  applyPickedFolder(path: string | null): void {
    if (path && this.cwdInput) this.cwdInput.value = path;
  }

  renderInto(container: HTMLElement, state: CockpitState, activeFolder: string): void {
    container.classList.toggle("hidden", !this.open);
    clear(container);
    this.cwdInput = null;
    if (!this.open) return;
    if (this.editing) {
      container.appendChild(this.profileForm(this.editing, state));
      return;
    }
    container.appendChild(this.quickForm(state, activeFolder));
  }

  private close(): void {
    this.open = false;
    this.quickPrefill = null;
    this.deps.rerender();
  }

  private quickForm(state: CockpitState, activeFolder: string): HTMLElement {
    const pre = this.quickPrefill;
    const nameInput = h("input", { className: "tc-field-input", attrs: { type: "text", placeholder: "Claude", value: pre?.name ?? "" } }) as HTMLInputElement;
    const modelSel = this.selectFrom(MODEL_OPTIONS.map((m) => ({ value: m.id, label: m.label })), pre?.model ?? DEFAULT_MODEL_CHOICE);
    const effortSel = h("select", { className: "tc-field-input" }) as HTMLSelectElement;
    const refreshEffort = (): void => {
      const allowed = new Set<string>(modelEffortLevels(modelSel.value as ModelChoice));
      const prev = effortSel.value || (pre?.effort ?? "default");
      effortSel.innerHTML = "";
      for (const opt of EFFORT_OPTIONS) {
        if (allowed.size > 0 && !allowed.has(opt.id)) continue;
        const o = document.createElement("option");
        o.value = opt.id;
        o.textContent = opt.label;
        o.title = opt.oneLine;
        effortSel.appendChild(o);
      }
      effortSel.value = allowed.has(prev) ? prev : "default";
      effortSel.disabled = allowed.size === 0;
    };
    refreshEffort();
    modelSel.addEventListener("change", refreshEffort);
    const modeSel = this.selectFrom(PERMISSION_MODES.map((m) => ({ value: m.mode, label: m.label })), pre?.permissionMode ?? "default");
    const spaceSel = this.selectFrom(
      [{ value: "", label: "No workspace" }, ...state.spaces.map((s) => ({ value: s.id, label: s.name }))],
      pre?.spaceId ?? (activeFolder === ALL_FOLDER ? "" : activeFolder),
    );
    const promptDeco = decorateTextarea({
      className: "tc-prompt",
      rows: 2,
      placeholder: "Optional first prompt (sent to every terminal)",
      expandTitle: "Initial prompt",
      ariaLabel: "Initial prompt",
      value: pre?.initialPrompt ?? "",
    });
    const prompt = promptDeco.textarea;
    const cwdInput = h("input", {
      className: "tc-field-input tc-cwd-input",
      attrs: { type: "text", placeholder: "Workspace root (default)", value: pre?.cwd ?? "" },
    }) as HTMLInputElement;
    this.cwdInput = cwdInput;
    const cwdBrowse = h("button", {
      className: "tc-cwd-browse",
      attrs: { type: "button", "aria-label": "Browse for a folder" },
      innerHTML: `<span class="tc-btn-icon">${ICONS.folder}</span><span>Browse</span>`,
      on: { click: () => this.deps.send({ type: "cockpitPickFolder", context: "quick" }) },
    });
    const cwdField = h("div", { className: "tc-cwd-row" }, cwdInput, cwdBrowse);
    this.quickCount = clampCount(pre?.defaultCount ?? this.quickCount);
    const countStepper = this.stepper(this.quickCount, 1, MAX_BATCH, ICONS.terminal, "How many terminals", (v) => { this.quickCount = v; });

    const launch = h("button", {
      className: "tc-launch-btn tc-launch-primary",
      attrs: { type: "button" },
      innerHTML: `<span class="tc-btn-icon">${ICONS.play}</span><span>Launch</span>`,
      on: {
        click: () => {
          this.deps.send({
            type: "cockpitQuickLaunch",
            name: nameInput.value,
            model: modelSel.value as ModelChoice,
            effort: effortSel.value as EffortChoice,
            permissionMode: modeSel.value as PermissionMode,
            cwd: cwdInput.value.trim().length > 0 ? cwdInput.value.trim() : null,
            spaceId: spaceSel.value === "" ? null : spaceSel.value,
            count: clampCount(this.quickCount),
            prompt: prompt.value.trim().length > 0 ? prompt.value : null,
          });
          if (spaceSel.value !== "") this.deps.setActiveFolder(spaceSel.value);
          this.close();
        },
      },
    });

    const field = (label: string, control: HTMLElement) =>
      h("label", { className: "tc-qfield" }, h("span", { className: "tc-qlabel", textContent: label }), control);

    const grid = h(
      "div",
      { className: "tc-quick-grid" },
      field("Name", nameInput),
      field("Model", modelSel),
      field("Effort", effortSel),
      field("Permissions", modeSel),
      field("Workspace", spaceSel),
      field("Working folder", cwdField),
      field("Terminals", countStepper),
    );

    const profilesRow = h("div", { className: "tc-profile-chips" });
    for (const p of state.profiles) {
      profilesRow.appendChild(
        h("button", {
          className: `tc-chip${pre?.id === p.id ? " active" : ""}`,
          attrs: { type: "button", title: `Use “${p.name}” settings` },
          textContent: p.name,
          on: { click: () => { this.quickPrefill = p; this.deps.rerender(); } },
        }),
      );
    }
    profilesRow.appendChild(
      h("button", {
        className: "tc-chip tc-chip-ghost",
        attrs: { type: "button" },
        textContent: "＋ Save as profile",
        on: { click: () => { this.editing = this.draftFromQuick(nameInput.value, modelSel.value, effortSel.value, modeSel.value, spaceSel.value, prompt.value); this.deps.rerender(); } },
      }),
    );

    const close = h("button", {
      className: "tc-quick-close",
      attrs: { type: "button", title: "Close", "aria-label": "Close session setup" },
      innerHTML: ICONS.close,
      on: { click: () => this.close() },
    });

    return h(
      "div",
      { className: "tc-quick" },
      h("div", { className: "tc-quick-head" }, h("span", { className: "tc-quick-title", textContent: "New session" }), h("span", { className: "tc-quick-spacer" }), close),
      grid,
      promptDeco.element,
      h("div", { className: "tc-quick-actions" }, launch, h("span", { className: "tc-quick-spacer" }), profilesRow),
    );
  }

  private draftFromQuick(name: string, model: string, effort: string, mode: string, space: string, prompt: string): SessionProfile {
    return {
      id: newId() as SessionProfile["id"],
      name: name.trim().length > 0 ? name.trim() : "",
      model: model as SessionProfile["model"],
      effort: effort as SessionProfile["effort"],
      permissionMode: mode as SessionProfile["permissionMode"],
      cwd: null,
      nameTemplate: DEFAULT_NAME_TEMPLATE,
      initialPrompt: prompt.trim().length > 0 ? prompt : null,
      defaultCount: clampCount(this.quickCount),
      spaceId: space === "" ? null : toSpaceId(space),
    };
  }

  private selectFrom(options: ReadonlyArray<{ value: string; label: string }>, selected: string): HTMLSelectElement {
    const sel = h("select", { className: "tc-field-input" }) as HTMLSelectElement;
    for (const o of options) {
      const opt = h("option", { textContent: o.label, attrs: { value: o.value } }) as HTMLOptionElement;
      if (o.value === selected) opt.selected = true;
      sel.appendChild(opt);
    }
    return sel;
  }

  private stepper(initial: number, min: number, max: number, icon: string, title: string, onChange: (v: number) => void): HTMLElement {
    let value = initial;
    const valEl = h("span", { className: "tc-stepper-val", textContent: String(value) });
    const set = (next: number): void => {
      const clamped = Math.max(min, Math.min(max, next));
      if (clamped === value) return;
      value = clamped;
      valEl.textContent = String(value);
      onChange(value);
    };
    return h(
      "div",
      { className: "tc-stepper", attrs: { title } },
      h("span", { className: "tc-stepper-icon", innerHTML: icon }),
      h("button", {
        className: "tc-stepper-btn",
        attrs: { type: "button", "aria-label": `Decrease ${title}` },
        textContent: "−",
        on: { click: () => set(value - 1) },
      }),
      valEl,
      h("button", {
        className: "tc-stepper-btn",
        attrs: { type: "button", "aria-label": `Increase ${title}` },
        textContent: "+",
        on: { click: () => set(value + 1) },
      }),
    );
  }

  private profileForm(profile: SessionProfile, state: CockpitState): HTMLElement {
    let draft: SessionProfile = profile;
    const set = (patch: Partial<SessionProfile>) => { draft = { ...draft, ...patch }; };
    const textField = (label: string, value: string, on: (v: string) => void, placeholder = "") => {
      const input = h("input", { className: "tc-field-input", attrs: { type: "text", value, placeholder } }) as HTMLInputElement;
      input.addEventListener("input", () => on(input.value));
      return h("label", { className: "tc-field" }, h("span", { textContent: label }), input);
    };
    const modelSel = this.selectFrom(MODEL_OPTIONS.map((m) => ({ value: m.id, label: m.label })), draft.model);
    const effortSel = h("select", { className: "tc-field-input" }) as HTMLSelectElement;
    const refreshEffort = (): void => {
      const allowed = new Set<string>(modelEffortLevels(modelSel.value as ModelChoice));
      const prev = effortSel.value || draft.effort;
      effortSel.innerHTML = "";
      for (const opt of EFFORT_OPTIONS) {
        if (allowed.size > 0 && !allowed.has(opt.id)) continue;
        const o = document.createElement("option");
        o.value = opt.id;
        o.textContent = opt.label;
        o.title = opt.oneLine;
        effortSel.appendChild(o);
      }
      const desired = allowed.has(prev) ? prev : "default";
      effortSel.value = desired;
      effortSel.disabled = allowed.size === 0;
      set({ effort: desired as SessionProfile["effort"] });
    };
    refreshEffort();
    modelSel.addEventListener("change", () => { set({ model: modelSel.value as SessionProfile["model"] }); refreshEffort(); });
    effortSel.addEventListener("change", () => set({ effort: effortSel.value as SessionProfile["effort"] }));
    const modeSel = this.selectFrom(PERMISSION_MODES.map((m) => ({ value: m.mode, label: m.label })), draft.permissionMode);
    modeSel.addEventListener("change", () => set({ permissionMode: modeSel.value as SessionProfile["permissionMode"] }));
    const spaceSel = this.selectFrom(
      [{ value: "", label: "No workspace" }, ...state.spaces.map((s) => ({ value: s.id, label: s.name }))],
      draft.spaceId ?? "",
    );
    spaceSel.addEventListener("change", () => set({ spaceId: spaceSel.value === "" ? null : toSpaceId(spaceSel.value) }));
    const countInput = h("input", { className: "tc-field-input", attrs: { type: "number", min: "1", max: String(MAX_BATCH), value: String(draft.defaultCount) } }) as HTMLInputElement;
    countInput.addEventListener("change", () => { const c = clampCount(Number(countInput.value)); set({ defaultCount: c }); countInput.value = String(c); });
    const save = h("button", {
      className: "tc-launch-btn",
      attrs: { type: "button" },
      textContent: "Save profile",
      on: { click: () => { this.deps.send({ type: "cockpitSaveProfile", profile: draft }); this.editing = null; this.deps.rerender(); } },
    });
    const cancel = h("button", { className: "tc-link", attrs: { type: "button" }, textContent: "Cancel", on: { click: () => { this.editing = null; this.deps.rerender(); } } });
    const del = state.profiles.some((p) => p.id === draft.id)
      ? h("button", { className: "tc-link tc-danger", attrs: { type: "button" }, textContent: "Delete", on: { click: () => { this.deps.send({ type: "cockpitDeleteProfile", profileId: toProfileId(draft.id) }); this.editing = null; this.deps.rerender(); } } })
      : null;
    return h(
      "div",
      { className: "tc-form" },
      textField("Profile name", draft.name, (v) => set({ name: v }), "e.g. Reviewer"),
      h("label", { className: "tc-field" }, h("span", { textContent: "Model" }), modelSel),
      h("label", { className: "tc-field" }, h("span", { textContent: "Effort" }), effortSel),
      h("label", { className: "tc-field" }, h("span", { textContent: "Permission mode" }), modeSel),
      textField("Working directory", draft.cwd ?? "", (v) => set({ cwd: v.trim() === "" ? null : v }), "Defaults to the workspace root"),
      textField("Name template", draft.nameTemplate, (v) => set({ nameTemplate: v }), "{profile} {n}"),
      textField("Initial prompt", draft.initialPrompt ?? "", (v) => set({ initialPrompt: v.trim() === "" ? null : v }), "Optional"),
      h("label", { className: "tc-field" }, h("span", { textContent: "Default count" }), countInput),
      h("label", { className: "tc-field" }, h("span", { textContent: "Workspace" }), spaceSel),
      h("div", { className: "tc-form-actions" }, save, cancel, del),
    );
  }
}
