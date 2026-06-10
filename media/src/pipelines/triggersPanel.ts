import { h } from "../ui/h.js";
import type { ScheduleRecurrence, Trigger } from "../../../src/features/pipelines/domain/types";
import {
  INTERVAL_UNITS,
  WEEKDAY_LABELS,
  describeRecurrence,
  formatMinute,
  intervalToMs,
  splitInterval,
} from "../../../src/features/pipelines/domain/schedule.js";
import { ICON_HTTP, ICON_PLAY, ICON_WAIT } from "./pipelineIcons.js";
import { bareTextInput, inspectorSection } from "./inspectorFields.js";
import { makeId } from "./pipelineBlockMeta.js";

export interface TriggersPanelHost {
  triggers(): readonly Trigger[];
  updateTriggers(fn: (triggers: readonly Trigger[]) => readonly Trigger[]): void;
}

export const renderTriggersBody = (host: TriggersPanelHost): HTMLElement => {
  const triggers = host.triggers();
  const body = h("div", { className: "pl-inspector-form" });

  triggers.forEach((trigger, index) => {
    const rows: HTMLElement[] = [];
    const enabledCb = h("input", {
      attrs: { type: "checkbox" },
      on: {
        change: (e) =>
          host.updateTriggers((ts) =>
            ts.map((t, i) => (i === index ? { ...t, enabled: (e.currentTarget as HTMLInputElement).checked } : t)),
          ),
      },
    });
    enabledCb.checked = trigger.enabled;
    rows.push(h("label", { className: "pl-field", style: { flexDirection: "row", alignItems: "center", gap: "8px" } }, enabledCb, h("span", { textContent: "Enabled" })));

    if (trigger.kind === "schedule") {
      rows.push(...scheduleEditorRows(host, trigger.recurrence, index));
    } else {
      const input = bareTextInput(trigger.token, (v) =>
        host.updateTriggers((ts) => ts.map((t, i) => (i === index && t.kind === "webhook" ? { ...t, token: v } : t))),
      );
      rows.push(h("div", { className: "pl-field" }, h("label", { className: "pl-field-label", textContent: "Secret token" }), input, h("div", { className: "pl-field-hint", textContent: "POST to /?token=<token> on the configured webhook port." })));
    }

    rows.push(
      h("button", {
        className: "pl-btn ghost danger",
        attrs: { type: "button" },
        textContent: "Remove trigger",
        on: { click: () => host.updateTriggers((ts) => ts.filter((_, i) => i !== index)) },
      }),
    );

    body.appendChild(
      inspectorSection(
        trigger.kind === "schedule" ? ICON_WAIT : ICON_HTTP,
        trigger.kind === "schedule" ? "Schedule" : "Webhook",
        h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } }, ...rows),
      ),
    );
  });

  const addRow = h(
    "div",
    { style: { display: "flex", gap: "8px" } },
    h("button", {
      className: "pl-btn ghost",
      attrs: { type: "button" },
      textContent: "+ Schedule",
      on: { click: () => host.updateTriggers((ts) => [...ts, { kind: "schedule", enabled: true, recurrence: { type: "weekly", weekdays: [1], atMinute: 540 } }]) },
    }),
    h("button", {
      className: "pl-btn ghost",
      attrs: { type: "button" },
      textContent: "+ Webhook",
      on: { click: () => host.updateTriggers((ts) => [...ts, { kind: "webhook", token: makeId("hook"), enabled: true }]) },
    }),
  );
  body.appendChild(inspectorSection(ICON_PLAY, "Add a trigger", addRow));
  return body;
};

const setRecurrence = (host: TriggersPanelHost, index: number, recurrence: ScheduleRecurrence): void => {
  host.updateTriggers((ts) => ts.map((t, i) => (i === index && t.kind === "schedule" ? { ...t, recurrence } : t)));
};

const scheduleEditorRows = (host: TriggersPanelHost, recurrence: ScheduleRecurrence, index: number): HTMLElement[] => {
  const rows: HTMLElement[] = [];
  const atMinute = recurrence.type === "interval" ? 540 : recurrence.atMinute;

  const typeSel = h("select", { className: "pl-field-input" },
    ...(["interval", "daily", "weekly", "monthly"] as const).map((tp) =>
      h("option", { attrs: { value: tp, ...(recurrence.type === tp ? { selected: "selected" } : {}) }, textContent: `${tp[0]!.toUpperCase()}${tp.slice(1)}` }),
    ),
  ) as HTMLSelectElement;
  typeSel.addEventListener("change", () => setRecurrence(host, index, defaultRecurrenceOfType(typeSel.value, atMinute)));
  rows.push(h("div", { className: "pl-field" }, h("label", { className: "pl-field-label", textContent: "Repeat" }), typeSel));

  if (recurrence.type === "interval") {
    const { value, unit } = splitInterval(recurrence.everyMs);
    const valInput = h("input", { className: "pl-field-input", attrs: { type: "number", min: "1", step: "1" } }) as HTMLInputElement;
    valInput.value = String(value);
    const unitSel = h("select", { className: "pl-field-input" },
      ...INTERVAL_UNITS.map((u) => h("option", { attrs: { value: u.id, ...(u.id === unit ? { selected: "selected" } : {}) }, textContent: u.label })),
    ) as HTMLSelectElement;
    const apply = (): void => setRecurrence(host, index, { type: "interval", everyMs: intervalToMs(Number(valInput.value) || 1, unitSel.value) });
    valInput.addEventListener("input", apply);
    unitSel.addEventListener("change", apply);
    rows.push(h("div", { className: "pl-field" }, h("label", { className: "pl-field-label", textContent: "Every" }), h("div", { style: { display: "flex", gap: "8px" } }, valInput, unitSel)));
  } else {
    if (recurrence.type === "weekly") {
      const chips = h("div", { style: { display: "flex", gap: "4px", flexWrap: "wrap" } });
      WEEKDAY_LABELS.forEach((label, d) => {
        const on = recurrence.weekdays.includes(d);
        chips.appendChild(h("button", {
          className: `pl-btn ghost${on ? " primary" : ""}`,
          attrs: { type: "button", "aria-pressed": on ? "true" : "false" },
          textContent: label,
          on: { click: () => {
            const set = new Set(recurrence.weekdays);
            if (set.has(d)) set.delete(d); else set.add(d);
            const weekdays = [...set].sort((a, b) => a - b);
            setRecurrence(host, index, { type: "weekly", weekdays: weekdays.length > 0 ? weekdays : [d], atMinute });
          } },
        }));
      });
      rows.push(h("div", { className: "pl-field" }, h("label", { className: "pl-field-label", textContent: "On days" }), chips));
    }
    if (recurrence.type === "monthly") {
      const dayInput = h("input", { className: "pl-field-input", attrs: { type: "number", min: "1", max: "31", step: "1" } }) as HTMLInputElement;
      dayInput.value = String(recurrence.day);
      dayInput.addEventListener("input", () => {
        const d = Math.min(31, Math.max(1, Math.round(Number(dayInput.value) || 1)));
        setRecurrence(host, index, { type: "monthly", day: d, atMinute });
      });
      rows.push(h("div", { className: "pl-field" }, h("label", { className: "pl-field-label", textContent: "Day of month" }), dayInput));
    }
    const timeInput = h("input", { className: "pl-field-input", attrs: { type: "time" } }) as HTMLInputElement;
    timeInput.value = formatMinute(atMinute);
    timeInput.addEventListener("input", () => {
      const m = timeToMinute(timeInput.value);
      if (m !== null) setRecurrence(host, index, withAtMinute(recurrence, m));
    });
    rows.push(h("div", { className: "pl-field" }, h("label", { className: "pl-field-label", textContent: "At time" }), timeInput));
  }

  rows.push(h("div", { className: "pl-field-hint", textContent: `Runs ${describeRecurrence(recurrence)}, while the Claude Trace tab is open and the computer is awake.` }));
  return rows;
};

const timeToMinute = (v: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
};

const withAtMinute = (r: ScheduleRecurrence, atMinute: number): ScheduleRecurrence => {
  switch (r.type) {
    case "interval": return r;
    case "daily": return { type: "daily", atMinute };
    case "weekly": return { type: "weekly", weekdays: r.weekdays, atMinute };
    case "monthly": return { type: "monthly", day: r.day, atMinute };
  }
};

const defaultRecurrenceOfType = (type: string, atMinute: number): ScheduleRecurrence => {
  switch (type) {
    case "daily": return { type: "daily", atMinute };
    case "weekly": return { type: "weekly", weekdays: [1], atMinute };
    case "monthly": return { type: "monthly", day: 1, atMinute };
    default: return { type: "interval", everyMs: 3_600_000 };
  }
};
