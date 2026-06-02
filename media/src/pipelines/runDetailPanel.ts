import { h } from "../ui/h.js";
import type {
  Block,
  BlockSessionRecord,
  RunId,
  RunState,
} from "../../../src/features/pipelines/domain/types";
import type { PipelinesWebviewToHost, SessionTarget } from "../../../src/features/pipelines/protocol";
import { ICON_PLAY, ICON_SLIDERS, ICON_TAG } from "./pipelineIcons.js";
import { inspectorSection } from "./inspectorFields.js";
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
  constructor(private readonly host: RunDetailHost) {}

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

    const sessionsCount = blockRun.sessions.length;
    if (sessionsCount === 0) {
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

    return card;
  }
}
