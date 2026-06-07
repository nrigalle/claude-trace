import { h } from "../ui/h.js";
import type {
  Block,
  BlockSessionRecord,
  InputBlock,
  InputColumn,
  RunId,
  RunState,
} from "../../../src/features/pipelines/domain/types";
import type { PipelinesWebviewToHost, SessionTarget } from "../../../src/features/pipelines/protocol";
import { ICON_INPUT, ICON_PLAY, ICON_SCRIPT, ICON_SLIDERS, ICON_TAG } from "./pipelineIcons.js";
import { inspectorSection, selectFromOptions } from "./inspectorFields.js";
import { blockNodeMeta } from "./pipelineBlockMeta.js";

export interface RunDetailHost {
  readonly panelHeader: HTMLElement;
  readonly panelBody: HTMLElement;
  getRun(): RunState | null;
  clearPanel(): void;
  showNotice(level: "info" | "warning" | "error", message: string): void;
  send(msg: PipelinesWebviewToHost): void;
}

export class RunDetailPanel {
  private readonly transcripts = new Map<string, string>();
  constructor(private readonly host: RunDetailHost) {}

  cacheTranscript(sessionId: string, text: string): void {
    this.transcripts.set(sessionId, text.length > 0 ? text : "(No readable session content.)");
  }

  private renderSessionButtons(
    runId: RunId,
    definition: Block,
    blockRun: RunState["blocks"][number],
  ): HTMLElement[] {
    const buttons: HTMLElement[] = [];
    const make = (
      label: string,
      target: SessionTarget,
      sessionId: string | null,
      isStuck: boolean,
    ) =>
      h(
        "button",
        {
          className: `pl-session-btn${isStuck ? " pl-session-btn-urgent" : ""}`,
          attrs: { type: "button" },
          on: {
            click: (e: Event) => {
              e.stopPropagation();
              e.preventDefault();
              this.host.send({
                type: "revealSession",
                runId,
                blockId: definition.id,
                target,
                sessionId,
              });
            },
          },
        },
        h("span", { className: "pl-session-btn-icon", innerHTML: ICON_PLAY }),
        h("span", { className: "pl-session-btn-label", textContent: label }),
      );

    if (definition.kind === "parallel" && blockRun.parallel) {
      for (const w of blockRun.parallel.workerRuns) {
        if (w.sessions.length === 0) continue;
        const workerDef = definition.workers.find((x) => x.id === w.workerBlockId);
        const name = workerDef?.name ?? String(w.workerBlockId);
        const isStuck = w.status === "stuck";
        const label = isStuck
          ? `Open "${name}" terminal · click to answer Claude`
          : `Open "${name}" session terminal`;
        const sessionId = w.sessions.at(-1)?.sessionId ?? null;
        buttons.push(make(label, { kind: "parallel-worker", workerBlockId: w.workerBlockId }, sessionId, isStuck));
      }
      if (blockRun.parallel.mergerSessions.length > 0) {
        const isStuck = blockRun.parallel.mergerStatus === "stuck";
        const label = isStuck ? "Open merger terminal · click to answer Claude" : "Open merger session terminal";
        const sessionId = blockRun.parallel.mergerSessions.at(-1)?.sessionId ?? null;
        buttons.push(make(label, { kind: "merger" }, sessionId, isStuck));
      }
      return buttons;
    }

    if (blockRun.sessions.length > 0) {
      const isStuck = blockRun.status === "stuck";
      const label = isStuck
        ? "Open Claude session terminal · click to answer"
        : "Open Claude session terminal";
      const sessionId = blockRun.sessions.at(-1)?.sessionId ?? null;
      buttons.push(make(label, { kind: "self" }, sessionId, isStuck));
    }
    return buttons;
  }

  render(blockId: string, closeBtn: HTMLElement): void {
    const run = this.host.getRun();
    if (!run) {
      this.host.clearPanel();
      return;
    }
    const blockRun = run.blocks.find((b) => b.blockId === blockId);
    const definition = run.pipelineSnapshot.blocks.find((b) => b.id === blockId);
    if (!blockRun || !definition) {
      this.host.clearPanel();
      return;
    }

    const meta = blockNodeMeta(definition);
    this.host.panelHeader.appendChild(
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "10px", minWidth: "0", flex: "1" } },
        h("div", {
          className: "pl-section-icon",
          innerHTML: meta.icon,
          style: { flexShrink: "0" },
        }),
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", minWidth: "0" } },
          h("div", { className: "pl-panel-title", textContent: definition.name || meta.kindLabel }),
          h("div", {
            style: { fontSize: "11px", color: "var(--ct-text-muted)", marginTop: "1px" },
            textContent: meta.kindLabel,
          }),
        ),
      ),
    );
    this.host.panelHeader.appendChild(closeBtn);

    const form = h("div", { className: "pl-inspector-form" });

    form.appendChild(
      inspectorSection(
        ICON_TAG,
        "Status",
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "10px" } },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "8px" } },
            h("span", {
              className: `pl-status-badge pl-status-${blockRun.status}`,
              textContent: blockRun.status,
            }),
            blockRun.endedAtMs && blockRun.startedAtMs
              ? h("span", {
                  className: "pl-field-hint",
                  style: { margin: "0" },
                  textContent: `${blockRun.endedAtMs - blockRun.startedAtMs}ms`,
                })
              : null,
          ),
          blockRun.stuckReason
            ? h("div", {
                className: "pl-field-hint",
                style: { color: "var(--ct-amber)" },
                textContent: `Stuck: ${blockRun.stuckReason}`,
              })
            : null,
          ...this.renderSessionButtons(run.runId, definition, blockRun),
          blockRun.failureReason
            ? h("div", {
                className: "pl-field-hint",
                style: { color: "var(--ct-red)" },
                textContent: `Failed: ${blockRun.failureReason}`,
              })
            : null,
        ),
      ),
    );

    if (definition.kind === "input" && blockRun.status === "stuck") {
      form.appendChild(this.renderInputForm(run.runId, definition));
    }

    const logsSection = this.renderLogsSection(blockRun);
    if (logsSection) form.appendChild(logsSection);

    const sessionsCount = blockRun.sessions.length;
    if (sessionsCount === 0) {
      if (!logsSection && blockRun.status === "pending") {
        form.appendChild(
          inspectorSection(
            ICON_SLIDERS,
            "Sessions",
            h("div", {
              className: "pl-field-hint",
              textContent: "This block hasn't been executed yet.",
            }),
          ),
        );
      }
    } else {
      const sessionsBody = h("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } });
      blockRun.sessions.forEach((session) => {
        sessionsBody.appendChild(this.renderRunSessionCard(session, sessionsCount > 1));
      });
      form.appendChild(
        inspectorSection(ICON_SLIDERS, "Sessions", sessionsBody, {
          meta: sessionsCount === 1 ? "1 run" : `${sessionsCount} iterations`,
        }),
      );
    }

    this.host.panelBody.appendChild(form);
  }

  private renderInputForm(runId: RunId, definition: InputBlock): HTMLElement {
    const columns = definition.columns;
    const blankRow = (): Record<string, string> => {
      const row: Record<string, string> = {};
      for (const c of columns) row[c.key] = c.type === "enum" ? (c.options[0] ?? "") : "";
      return row;
    };
    const rows: Record<string, string>[] = [blankRow()];

    const tableBody = h("div", { className: "pl-input-rows" });
    const cell = (rowIndex: number, column: InputColumn): HTMLElement => {
      if (column.type === "enum") {
        return selectFromOptions(
          column.options.map((o) => ({ id: o, label: o })),
          rows[rowIndex]![column.key] ?? (column.options[0] ?? ""),
          (v) => { rows[rowIndex]![column.key] = v; },
        );
      }
      const input = h("input", {
        className: "pl-field-input",
        attrs: { type: column.type === "url" ? "url" : "text", placeholder: column.label },
        on: { input: (e) => { rows[rowIndex]![column.key] = (e.currentTarget as HTMLInputElement).value; } },
      });
      input.value = rows[rowIndex]![column.key] ?? "";
      return input;
    };
    const rebuild = (): void => {
      tableBody.replaceChildren();
      rows.forEach((_, rowIndex) => {
        const rowEl = h("div", { className: "pl-input-row" });
        for (const column of columns) {
          rowEl.appendChild(
            h("div", { className: "pl-input-cell" },
              h("label", { className: "pl-field-label", textContent: column.label + (column.required ? " *" : "") }),
              cell(rowIndex, column),
            ),
          );
        }
        rowEl.appendChild(
          h("button", {
            className: "pl-btn ghost",
            attrs: { type: "button", title: "Remove row" },
            textContent: "✕",
            on: {
              click: () => {
                if (rows.length <= 1) return;
                rows.splice(rowIndex, 1);
                rebuild();
              },
            },
          }),
        );
        tableBody.appendChild(rowEl);
      });
    };
    rebuild();

    const addBtn = h("button", {
      className: "pl-btn ghost",
      attrs: { type: "button" },
      textContent: "+ Add row",
      on: { click: () => { rows.push(blankRow()); rebuild(); } },
    });

    const submitBtn = h("button", {
      className: "pl-btn primary",
      attrs: { type: "button" },
      textContent: "Submit & continue",
      on: {
        click: () => {
          const missing = rows.some((row) =>
            columns.some((c) => c.required && (row[c.key] ?? "").trim().length === 0),
          );
          if (missing) {
            this.host.showNotice("warning", "Fill in every required field before continuing.");
            return;
          }
          this.host.send({ type: "submitInput", runId, blockId: definition.id, rows });
        },
      },
    });

    const body = h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "12px" } },
      tableBody,
      h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, addBtn, submitBtn),
    );
    return inspectorSection(ICON_INPUT, "Fill in the table", body, { meta: `${columns.length} column${columns.length === 1 ? "" : "s"}` });
  }

  private renderLogsSection(blockRun: RunState["blocks"][number]): HTMLElement | null {
    const live = typeof blockRun.logTail === "string" && blockRun.logTail.length > 0 ? blockRun.logTail : null;
    const log = live ?? blockRun.output ?? "";
    if (log.length === 0) return null;
    const running = blockRun.status === "running";
    const pre = h("pre", { className: "pl-run-log", textContent: log });
    requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
    const body = h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "8px" } },
      running
        ? h(
            "div",
            { className: "pl-run-log-live" },
            h("span", { className: "pl-spinner-dot" }),
            h("span", { textContent: "Streaming live output…" }),
          )
        : null,
      pre,
    );
    return inspectorSection(ICON_SCRIPT, running ? "Live output" : "Output", body, running ? { meta: "live" } : undefined);
  }

  private renderRunSessionCard(
    session: BlockSessionRecord,
    showIteration: boolean,
  ): HTMLElement {
    const card = h("div", {
      style: {
        background: "var(--ct-bg-2)",
        border: "1px solid var(--ct-border)",
        borderRadius: "var(--ct-radius-sm)",
        padding: "12px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      },
    });

    if (showIteration) {
      card.appendChild(
        h(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
          h("span", {
            style: {
              fontSize: "11px",
              fontWeight: "600",
              color: "var(--ct-claude)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            },
            textContent: `Iteration ${session.iteration + 1}`,
          }),
          h("span", {
            className: "pl-field-hint",
            style: { margin: "0" },
            textContent:
              session.endedAtMs && session.startedAtMs
                ? `${session.endedAtMs - session.startedAtMs}ms`
                : "n/a",
          }),
        ),
      );
    }

    if (session.summary) {
      card.appendChild(
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "Summary" }),
          h("div", {
            style: {
              fontSize: "12.5px",
              lineHeight: "1.55",
              color: "var(--ct-text-primary)",
              whiteSpace: "pre-wrap",
              fontFamily: "var(--ct-font)",
            },
            textContent: session.summary,
          }),
        ),
      );
    }

    card.appendChild(
      h(
        "div",
        { className: "pl-field" },
        h("label", { className: "pl-field-label", textContent: "Session ID" }),
        h(
          "div",
          { style: { display: "flex", gap: "8px", alignItems: "center" } },
          h("code", {
            style: {
              flex: "1",
              fontFamily: "var(--ct-mono)",
              fontSize: "11.5px",
              color: "var(--ct-text-secondary)",
              background: "var(--ct-bg-1)",
              padding: "6px 10px",
              borderRadius: "var(--ct-radius-sm)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            },
            textContent: session.sessionId,
          }),
          h("button", {
            className: "pl-btn",
            attrs: { type: "button", title: "Copy session ID" },
            textContent: "Copy",
            on: {
              click: () => {
                void navigator.clipboard?.writeText(session.sessionId);
                this.host.showNotice("info", "Session ID copied to clipboard.");
              },
            },
          }),
        ),
      ),
    );

    card.appendChild(
      h(
        "div",
        { className: "pl-field" },
        h("label", { className: "pl-field-label", textContent: "Prompt sent" }),
        h("pre", {
          style: {
            fontFamily: "var(--ct-mono)",
            fontSize: "11.5px",
            color: "var(--ct-text-secondary)",
            background: "var(--ct-bg-1)",
            padding: "10px 12px",
            borderRadius: "var(--ct-radius-sm)",
            border: "1px solid var(--ct-border)",
            maxHeight: "200px",
            overflow: "auto",
            whiteSpace: "pre-wrap",
            margin: "0",
          },
          textContent: session.promptSent,
        }),
      ),
    );

    const cached = this.transcripts.get(session.sessionId);
    card.appendChild(
      h(
        "div",
        { className: "pl-field" },
        h("label", { className: "pl-field-label", textContent: "Session content" }),
        cached !== undefined
          ? h("pre", { className: "pl-run-log", textContent: cached })
          : h("button", {
              className: "pl-btn",
              attrs: { type: "button", title: "Read this session without resuming it" },
              textContent: "Read session",
              on: { click: () => this.host.send({ type: "loadSessionTranscript", sessionId: session.sessionId }) },
            }),
      ),
    );

    return card;
  }
}
