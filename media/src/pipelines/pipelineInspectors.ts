import { h } from "../ui/h.js";
import { assertNever } from "../../../src/shared/assertNever";
import { MODEL_OPTIONS } from "../../../src/shared/models";
import type { ModelChoice } from "../../../src/shared/models";
import type {
  ApprovalBlock,
  Block,
  ConditionBlock,
  EvaluatorBlock,
  FileBlock,
  FileOperation,
  HttpBlock,
  HttpMethod,
  Interpreter,
  LlmBlock,
  LoopBlock,
  MapBlock,
  ParallelBlock,
  ReduceBlock,
  ReduceMode,
  ScriptBlock,
  WaitBlock,
  WorkerBlock,
} from "../../../src/features/pipelines/domain/types";
import { toBlockId } from "../../../src/features/pipelines/domain/types";
import {
  ICON_APPROVAL,
  ICON_CONDITION,
  ICON_EVALUATOR,
  ICON_FILE,
  ICON_FILE_TEXT,
  ICON_HTTP,
  ICON_MAP,
  ICON_PARALLEL,
  ICON_REDUCE,
  ICON_REPEAT,
  ICON_SCRIPT,
  ICON_SLIDERS,
  ICON_TAG,
  ICON_TRASH,
  ICON_WAIT,
} from "./pipelineIcons.js";
import {
  FILE_OP_OPTIONS,
  HTTP_METHOD_OPTIONS,
  INTERPRETER_OPTIONS,
  REDUCE_MODE_OPTIONS,
} from "./pipelineCatalog.js";
import {
  bareTextInput,
  boundTextarea,
  dangerRemoveSection,
  fieldEffort,
  fieldModel,
  fieldRestartToggle,
  identitySection,
  inspectorSection,
  outputVarField,
  refHint,
  selectFromOptions,
} from "./inspectorFields.js";
import { renderParallelWorkers } from "./parallelWorkersView.js";

export interface InspectorHost {
  readonly panelBody: HTMLElement;
  readonly activeParallelWorker: Map<string, string>;
  getDraftBlocks(): readonly Block[];
  findBlockName(blockId: string | null): string | null;
  updateBlock<T extends Block>(blockId: string, fn: (b: T) => T): void;
  removeBlock(blockId: string): void;
  updateParallelWorker(blockId: string, workerId: string, patch: Partial<WorkerBlock>): void;
  addParallelWorker(blockId: string): void;
  removeParallelWorker(blockId: string, workerId: string): void;
  refreshInspectorOnly(): void;
  enterLoopDefineMode(loopBlockId: string): void;
}

export class PipelineInspectors {
  constructor(private readonly host: InspectorHost) {}

  render(block: Block): void {
    switch (block.kind) {
      case "worker":
        this.renderWorkerInspector(block);
        return;
      case "parallel":
        this.renderParallelInspector(block);
        return;
      case "loop":
        this.renderLoopInspector(block);
        return;
      case "script":
        this.renderScriptInspector(block);
        return;
      case "http":
        this.renderHttpInspector(block);
        return;
      case "file":
        this.renderFileInspector(block);
        return;
      case "condition":
        this.renderConditionInspector(block);
        return;
      case "wait":
        this.renderWaitInspector(block);
        return;
      case "reduce":
        this.renderReduceInspector(block);
        return;
      case "llm":
        this.renderLlmInspector(block);
        return;
      case "evaluator":
        this.renderEvaluatorInspector(block);
        return;
      case "map":
        this.renderMapInspector(block);
        return;
      case "approval":
        this.renderApprovalInspector(block);
        return;
      default:
        assertNever(block);
    }
  }

  private renderWorkerInspector(block: WorkerBlock): void {
    const form = h("div", { className: "pl-inspector-form" });

    form.appendChild(
      inspectorSection(
        ICON_TAG,
        "Identity",
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "Name" }),
          bareTextInput(block.name, (v) =>
            this.host.updateBlock(block.id, (b) => ({ ...b, name: v })),
          ),
        ),
      ),
    );

    const promptTextarea = boundTextarea(
      block.prompt,
      "Prompt sent to this Claude session…",
      "pl-block-prompt",
      (v) => this.host.updateBlock(block.id, (b) => ({ ...b, prompt: v })),
    );
    form.appendChild(inspectorSection(ICON_FILE_TEXT, "Prompt", promptTextarea));

    form.appendChild(
      inspectorSection(
        ICON_SLIDERS,
        "Execution",
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "12px" } },
          fieldModel(block.model, (v) => this.host.updateBlock(block.id, (b) => ({ ...b, model: v }))),
          fieldEffort(block.effort, (v) =>
            this.host.updateBlock(block.id, (b) => ({ ...b, effort: v })),
          ),
          fieldRestartToggle(
            block.restartEachIteration === true,
            (v) => this.host.updateBlock(block.id, (b) => ({ ...b, restartEachIteration: v ? true : undefined })),
          ),
        ),
      ),
    );

    form.appendChild(
      inspectorSection(
        ICON_TRASH,
        "Danger zone",
        h("button", {
          className: "pl-btn danger",
          attrs: { type: "button" },
          textContent: "Remove this block",
          on: { click: () => this.host.removeBlock(block.id) },
        }),
        { danger: true },
      ),
    );

    this.host.panelBody.appendChild(form);
  }

  private renderScriptInspector(block: ScriptBlock): void {
    const form = h("div", { className: "pl-inspector-form" });
    form.appendChild(identitySection(block.name, "Name", (v) =>
      this.host.updateBlock(block.id, (b) => ({ ...(b as ScriptBlock), name: v })),
    ));

    form.appendChild(
      inspectorSection(
        ICON_SLIDERS,
        "Interpreter",
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "Run with" }),
          selectFromOptions(INTERPRETER_OPTIONS, block.interpreter, (v) =>
            this.host.updateBlock(block.id, (b) => ({ ...(b as ScriptBlock), interpreter: v as Interpreter })),
          ),
        ),
      ),
    );

    const code = boundTextarea(block.code, "echo \"Hello from ${workspace}\"", "pl-block-prompt pl-code", (v) =>
      this.host.updateBlock(block.id, (b) => ({ ...(b as ScriptBlock), code: v })),
    );
    form.appendChild(inspectorSection(ICON_SCRIPT, "Code", h("div", {}, code, refHint())));

    form.appendChild(
      inspectorSection(
        ICON_TAG,
        "Output",
        outputVarField(block.outputVar, (v) =>
          this.host.updateBlock(block.id, (b) => ({ ...(b as ScriptBlock), outputVar: v })),
        ),
      ),
    );

    form.appendChild(dangerRemoveSection(() => this.host.removeBlock(block.id)));
    this.host.panelBody.appendChild(form);
  }

  private renderHttpInspector(block: HttpBlock): void {
    const form = h("div", { className: "pl-inspector-form" });
    form.appendChild(identitySection(block.name, "Name", (v) =>
      this.host.updateBlock(block.id, (b) => ({ ...(b as HttpBlock), name: v })),
    ));

    form.appendChild(
      inspectorSection(
        ICON_HTTP,
        "Request",
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "12px" } },
          h(
            "div",
            { className: "pl-field" },
            h("label", { className: "pl-field-label", textContent: "Method" }),
            selectFromOptions(HTTP_METHOD_OPTIONS, block.method, (v) =>
              this.host.updateBlock(block.id, (b) => ({ ...(b as HttpBlock), method: v as HttpMethod })),
            ),
          ),
          h(
            "div",
            { className: "pl-field" },
            h("label", { className: "pl-field-label", textContent: "URL" }),
            bareTextInput(block.url, (v) =>
              this.host.updateBlock(block.id, (b) => ({ ...(b as HttpBlock), url: v })),
            ),
            refHint(),
          ),
        ),
      ),
    );

    form.appendChild(inspectorSection(ICON_SLIDERS, "Headers", this.httpHeadersEditor(block)));

    const body = boundTextarea(block.body ?? "", "Request body (JSON, form data, …)", "pl-block-prompt", (v) =>
      this.host.updateBlock(block.id, (b) => ({ ...(b as HttpBlock), body: v === "" ? null : v })),
    );
    form.appendChild(inspectorSection(ICON_FILE_TEXT, "Body", body));

    form.appendChild(
      inspectorSection(
        ICON_TAG,
        "Output",
        outputVarField(block.outputVar, (v) =>
          this.host.updateBlock(block.id, (b) => ({ ...(b as HttpBlock), outputVar: v })),
        ),
      ),
    );

    form.appendChild(dangerRemoveSection(() => this.host.removeBlock(block.id)));
    this.host.panelBody.appendChild(form);
  }

  private httpHeadersEditor(block: HttpBlock): HTMLElement {
    const container = h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } });
    block.headers.forEach((header, index) => {
      container.appendChild(
        h(
          "div",
          { style: { display: "flex", gap: "8px", alignItems: "center" } },
          bareTextInput(header.name, (v) =>
            this.host.updateBlock(block.id, (b) => ({
              ...(b as HttpBlock),
              headers: (b as HttpBlock).headers.map((hd, i) => (i === index ? { ...hd, name: v } : hd)),
            })),
          ),
          bareTextInput(header.value, (v) =>
            this.host.updateBlock(block.id, (b) => ({
              ...(b as HttpBlock),
              headers: (b as HttpBlock).headers.map((hd, i) => (i === index ? { ...hd, value: v } : hd)),
            })),
          ),
          h("button", {
            className: "pl-btn ghost",
            attrs: { type: "button" },
            textContent: "✕",
            on: {
              click: () =>
                this.host.updateBlock(block.id, (b) => ({
                  ...(b as HttpBlock),
                  headers: (b as HttpBlock).headers.filter((_, i) => i !== index),
                })),
            },
          }),
        ),
      );
    });
    container.appendChild(
      h("button", {
        className: "pl-btn ghost",
        attrs: { type: "button" },
        textContent: "+ Add header",
        on: {
          click: () =>
            this.host.updateBlock(block.id, (b) => ({
              ...(b as HttpBlock),
              headers: [...(b as HttpBlock).headers, { name: "", value: "" }],
            })),
        },
      }),
    );
    return container;
  }

  private renderFileInspector(block: FileBlock): void {
    const form = h("div", { className: "pl-inspector-form" });
    form.appendChild(identitySection(block.name, "Name", (v) =>
      this.host.updateBlock(block.id, (b) => ({ ...(b as FileBlock), name: v })),
    ));

    form.appendChild(
      inspectorSection(
        ICON_FILE,
        "Operation",
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "12px" } },
          h(
            "div",
            { className: "pl-field" },
            h("label", { className: "pl-field-label", textContent: "Operation" }),
            selectFromOptions(FILE_OP_OPTIONS, block.operation, (v) =>
              this.host.updateBlock(block.id, (b) => ({ ...(b as FileBlock), operation: v as FileOperation })),
            ),
          ),
          h(
            "div",
            { className: "pl-field" },
            h("label", { className: "pl-field-label", textContent: "Path (relative to workspace)" }),
            bareTextInput(block.path, (v) =>
              this.host.updateBlock(block.id, (b) => ({ ...(b as FileBlock), path: v })),
            ),
          ),
        ),
      ),
    );

    if (block.operation === "write") {
      const content = boundTextarea(block.content, "File contents…", "pl-block-prompt", (v) =>
        this.host.updateBlock(block.id, (b) => ({ ...(b as FileBlock), content: v })),
      );
      form.appendChild(inspectorSection(ICON_FILE_TEXT, "Content", h("div", {}, content, refHint())));
    } else {
      form.appendChild(
        inspectorSection(
          ICON_TAG,
          "Output",
          outputVarField(block.outputVar, (v) =>
            this.host.updateBlock(block.id, (b) => ({ ...(b as FileBlock), outputVar: v })),
          ),
        ),
      );
    }

    form.appendChild(dangerRemoveSection(() => this.host.removeBlock(block.id)));
    this.host.panelBody.appendChild(form);
  }

  private renderParallelInspector(block: ParallelBlock): void {
    const form = h("div", { className: "pl-inspector-form" });

    form.appendChild(
      inspectorSection(
        ICON_TAG,
        "Identity",
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "Block name" }),
          bareTextInput(block.name, (v) =>
            this.host.updateBlock(block.id, (b) => ({ ...(b as ParallelBlock), name: v })),
          ),
        ),
      ),
    );

    form.appendChild(
      inspectorSection(
        ICON_PARALLEL,
        "Parallel workers",
        renderParallelWorkers(this.host, block),
        { meta: `${block.workers.length}` },
      ),
    );

    const mergerGoalTextarea = boundTextarea(
      block.mergerGoal,
      "Describe how to combine the branch results…",
      "pl-block-prompt",
      (v) => this.host.updateBlock(block.id, (b) => ({ ...(b as ParallelBlock), mergerGoal: v })),
    );
    const mergerBody = h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "12px" } },
      h(
        "div",
        { className: "pl-field" },
        h("label", { className: "pl-field-label", textContent: "Goal" }),
        mergerGoalTextarea,
      ),
      h(
        "div",
        { className: "pl-field" },
        h("label", { className: "pl-field-label", textContent: "Merger model" }),
        selectFromOptions(MODEL_OPTIONS, block.mergerModel, (v) =>
          this.host.updateBlock(block.id, (b) => ({ ...(b as ParallelBlock), mergerModel: v as ModelChoice })),
        ),
      ),
    );
    form.appendChild(inspectorSection(ICON_FILE_TEXT, "Merger", mergerBody));

    form.appendChild(
      inspectorSection(
        ICON_TRASH,
        "Danger zone",
        h("button", {
          className: "pl-btn danger",
          attrs: { type: "button" },
          textContent: "Remove this Parallel block",
          on: { click: () => this.host.removeBlock(block.id) },
        }),
        { danger: true },
      ),
    );

    this.host.panelBody.appendChild(form);
  }

  private renderLoopInspector(block: LoopBlock): void {
    const form = h("div", { className: "pl-inspector-form" });

    form.appendChild(
      inspectorSection(
        ICON_TAG,
        "Identity",
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "Block name" }),
          bareTextInput(block.name, (v) =>
            this.host.updateBlock(block.id, (b) => ({ ...(b as LoopBlock), name: v })),
          ),
        ),
      ),
    );

    const targetName = this.host.findBlockName(block.loopBackToBlockId);
    const targetRow = h(
      "div",
      { className: "pl-field" },
      h("label", { className: "pl-field-label", textContent: "Loop back to" }),
      h(
        "div",
        { style: { display: "flex", gap: "8px", alignItems: "center" } },
        h("div", {
          className: "pl-field-input",
          style: {
            flex: "1",
            display: "flex",
            alignItems: "center",
            color: targetName ? "var(--ct-text-primary)" : "var(--ct-text-muted)",
            fontStyle: targetName ? "normal" : "italic",
          },
          textContent: targetName ?? "Not set. Pick a target",
        }),
        h("button", {
          className: "pl-btn",
          attrs: { type: "button" },
          textContent: targetName ? "Change" : "Pick",
          on: { click: () => this.host.enterLoopDefineMode(block.id) },
        }),
      ),
      h("div", {
        className: "pl-field-hint",
        textContent: "Click Pick/Change, then click the green dot on a block earlier in the workflow.",
      }),
    );

    const goalTextarea = boundTextarea(
      block.goal,
      "Describe what the loop should achieve…",
      "pl-block-prompt",
      (v) => this.host.updateBlock(block.id, (b) => ({ ...(b as LoopBlock), goal: v })),
    );
    const goalField = h(
      "div",
      { className: "pl-field" },
      h("label", { className: "pl-field-label", textContent: "Goal" }),
      goalTextarea,
      h("div", {
        className: "pl-field-hint",
        textContent: "The loop's evaluator session reads each iteration's results and checks them against this goal.",
      }),
    );

    const iterationsInput = h("input", {
      className: "pl-field-input",
      attrs: { type: "number", min: "1", max: "100" },
      on: {
        input: (e) => {
          const target = e.currentTarget as HTMLInputElement;
          const parsed = parseInt(target.value, 10);
          if (!Number.isFinite(parsed)) return;
          this.host.updateBlock(block.id, (b) => ({ ...(b as LoopBlock), maxIterations: Math.max(1, parsed) }));
        },
      },
    });
    iterationsInput.value = String(block.maxIterations);
    const iterationsField = h(
      "div",
      { className: "pl-field" },
      h("label", { className: "pl-field-label", textContent: "Max iterations (safety cap)" }),
      iterationsInput,
      h("div", {
        className: "pl-field-hint",
        textContent: "Hard cap. The evaluator may end earlier when the goal is met.",
      }),
    );

    const modelField = h(
      "div",
      { className: "pl-field" },
      h("label", { className: "pl-field-label", textContent: "Evaluator model" }),
      selectFromOptions(MODEL_OPTIONS, block.evaluatorModel, (v) =>
        this.host.updateBlock(block.id, (b) => ({ ...(b as LoopBlock), evaluatorModel: v as ModelChoice })),
      ),
      h("div", {
        className: "pl-field-hint",
        textContent: "The loop's own judge session. Fresh context each iteration.",
      }),
    );

    form.appendChild(
      inspectorSection(
        ICON_REPEAT,
        "Loop control",
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "14px" } },
          targetRow,
          goalField,
          iterationsField,
          modelField,
        ),
      ),
    );

    form.appendChild(
      inspectorSection(
        ICON_TRASH,
        "Danger zone",
        h("button", {
          className: "pl-btn danger",
          attrs: { type: "button" },
          textContent: "Remove this Loop block",
          on: { click: () => this.host.removeBlock(block.id) },
        }),
        { danger: true },
      ),
    );

    this.host.panelBody.appendChild(form);
  }

  private renderConditionInspector(block: ConditionBlock): void {
    const form = h("div", { className: "pl-inspector-form" });
    form.appendChild(identitySection(block.name, "Name", (v) =>
      this.host.updateBlock(block.id, (b) => ({ ...(b as ConditionBlock), name: v })),
    ));

    form.appendChild(
      inspectorSection(
        ICON_CONDITION,
        "Condition",
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "Expression (true = continue, false = skip ahead)" }),
          bareTextInput(block.expression, (v) =>
            this.host.updateBlock(block.id, (b) => ({ ...(b as ConditionBlock), expression: v })),
          ),
          h("div", {
            className: "pl-field-hint",
            textContent: 'Examples: ${vars.status} == done · ${vars.count} > 3 · ${blocks.review.output} contains LGTM · ${vars.flag}',
          }),
        ),
      ),
    );

    const laterBlocks = this.blocksAfter(block.id);
    form.appendChild(
      inspectorSection(
        ICON_SLIDERS,
        "When false, skip to",
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "Rejoin point" }),
          selectFromOptions(
            [{ id: "", label: "End of pipeline" }, ...laterBlocks.map((b) => ({ id: b.id, label: b.name }))],
            block.skipToBlockId ?? "",
            (v) => this.host.updateBlock(block.id, (b) => ({ ...(b as ConditionBlock), skipToBlockId: v === "" ? null : toBlockId(v) })),
          ),
          h("div", { className: "pl-field-hint", textContent: "Blocks between this condition and the rejoin point are skipped when the expression is false." }),
        ),
      ),
    );

    form.appendChild(dangerRemoveSection(() => this.host.removeBlock(block.id)));
    this.host.panelBody.appendChild(form);
  }

  private renderWaitInspector(block: WaitBlock): void {
    const form = h("div", { className: "pl-inspector-form" });
    form.appendChild(identitySection(block.name, "Name", (v) =>
      this.host.updateBlock(block.id, (b) => ({ ...(b as WaitBlock), name: v })),
    ));

    const input = h("input", {
      className: "pl-field-input",
      attrs: { type: "number", min: "0", step: "100" },
      on: {
        input: (e) => {
          const n = Number((e.currentTarget as HTMLInputElement).value);
          this.host.updateBlock(block.id, (b) => ({ ...(b as WaitBlock), durationMs: Number.isFinite(n) && n >= 0 ? n : 0 }));
        },
      },
    });
    input.value = String(block.durationMs);
    form.appendChild(
      inspectorSection(
        ICON_WAIT,
        "Delay",
        h("div", { className: "pl-field" }, h("label", { className: "pl-field-label", textContent: "Duration (milliseconds)" }), input),
      ),
    );

    form.appendChild(dangerRemoveSection(() => this.host.removeBlock(block.id)));
    this.host.panelBody.appendChild(form);
  }

  private renderReduceInspector(block: ReduceBlock): void {
    const form = h("div", { className: "pl-inspector-form" });
    form.appendChild(identitySection(block.name, "Name", (v) =>
      this.host.updateBlock(block.id, (b) => ({ ...(b as ReduceBlock), name: v })),
    ));

    form.appendChild(
      inspectorSection(
        ICON_REDUCE,
        "Input",
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "Input variable (its lines are the items)" }),
          bareTextInput(block.inputVar, (v) =>
            this.host.updateBlock(block.id, (b) => ({ ...(b as ReduceBlock), inputVar: v })),
          ),
        ),
      ),
    );

    form.appendChild(
      inspectorSection(
        ICON_SLIDERS,
        "Mode",
        h(
          "div",
          { className: "pl-field" },
          h("label", { className: "pl-field-label", textContent: "How to combine" }),
          selectFromOptions(REDUCE_MODE_OPTIONS, block.mode, (v) =>
            this.host.updateBlock(block.id, (b) => ({ ...(b as ReduceBlock), mode: v as ReduceMode })),
          ),
        ),
      ),
    );

    if (block.mode === "concat") {
      form.appendChild(
        inspectorSection(
          ICON_FILE_TEXT,
          "Separator",
          h(
            "div",
            { className: "pl-field" },
            h("label", { className: "pl-field-label", textContent: "Joined with (use \\n for newline)" }),
            bareTextInput(block.separator, (v) =>
              this.host.updateBlock(block.id, (b) => ({ ...(b as ReduceBlock), separator: v })),
            ),
          ),
        ),
      );
    } else {
      const goal = boundTextarea(block.mergerGoal, "How should the LLM synthesize the items?", "pl-block-prompt", (v) =>
        this.host.updateBlock(block.id, (b) => ({ ...(b as ReduceBlock), mergerGoal: v })),
      );
      form.appendChild(inspectorSection(ICON_FILE_TEXT, "Merger goal", goal));
      form.appendChild(
        inspectorSection(
          ICON_SLIDERS,
          "Model",
          fieldModel(block.mergerModel, (v) => this.host.updateBlock(block.id, (b) => ({ ...(b as ReduceBlock), mergerModel: v }))),
        ),
      );
    }

    form.appendChild(
      inspectorSection(
        ICON_TAG,
        "Output",
        outputVarField(block.outputVar, (v) =>
          this.host.updateBlock(block.id, (b) => ({ ...(b as ReduceBlock), outputVar: v })),
        ),
      ),
    );

    form.appendChild(dangerRemoveSection(() => this.host.removeBlock(block.id)));
    this.host.panelBody.appendChild(form);
  }

  private renderLlmInspector(block: LlmBlock): void {
    const form = h("div", { className: "pl-inspector-form" });
    form.appendChild(identitySection(block.name, "Name", (v) =>
      this.host.updateBlock(block.id, (b) => ({ ...(b as LlmBlock), name: v })),
    ));

    const prompt = boundTextarea(block.prompt, "Prompt for a single Claude reply…", "pl-block-prompt", (v) =>
      this.host.updateBlock(block.id, (b) => ({ ...(b as LlmBlock), prompt: v })),
    );
    form.appendChild(inspectorSection(ICON_FILE_TEXT, "Prompt", h("div", {}, prompt, refHint())));

    form.appendChild(
      inspectorSection(
        ICON_SLIDERS,
        "Execution",
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "12px" } },
          fieldModel(block.model, (v) => this.host.updateBlock(block.id, (b) => ({ ...(b as LlmBlock), model: v }))),
          fieldEffort(block.effort, (v) => this.host.updateBlock(block.id, (b) => ({ ...(b as LlmBlock), effort: v }))),
        ),
      ),
    );

    form.appendChild(
      inspectorSection(
        ICON_TAG,
        "Output",
        outputVarField(block.outputVar, (v) =>
          this.host.updateBlock(block.id, (b) => ({ ...(b as LlmBlock), outputVar: v })),
        ),
      ),
    );

    form.appendChild(dangerRemoveSection(() => this.host.removeBlock(block.id)));
    this.host.panelBody.appendChild(form);
  }

  private renderEvaluatorInspector(block: EvaluatorBlock): void {
    const form = h("div", { className: "pl-inspector-form" });
    form.appendChild(identitySection(block.name, "Name", (v) =>
      this.host.updateBlock(block.id, (b) => ({ ...(b as EvaluatorBlock), name: v })),
    ));

    const goal = boundTextarea(block.goal, "What must be true for the run to continue?", "pl-block-prompt", (v) =>
      this.host.updateBlock(block.id, (b) => ({ ...(b as EvaluatorBlock), goal: v })),
    );
    form.appendChild(inspectorSection(ICON_EVALUATOR, "Pass criteria", h("div", {}, goal, refHint())));

    form.appendChild(
      inspectorSection(
        ICON_SLIDERS,
        "Model",
        fieldModel(block.evaluatorModel, (v) => this.host.updateBlock(block.id, (b) => ({ ...(b as EvaluatorBlock), evaluatorModel: v }))),
      ),
    );

    form.appendChild(dangerRemoveSection(() => this.host.removeBlock(block.id)));
    this.host.panelBody.appendChild(form);
  }

  private renderMapInspector(block: MapBlock): void {
    const form = h("div", { className: "pl-inspector-form" });
    form.appendChild(identitySection(block.name, "Name", (v) =>
      this.host.updateBlock(block.id, (b) => ({ ...(b as MapBlock), name: v })),
    ));

    form.appendChild(
      inspectorSection(
        ICON_MAP,
        "Iterate",
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "12px" } },
          h(
            "div",
            { className: "pl-field" },
            h("label", { className: "pl-field-label", textContent: "List variable (one item per line)" }),
            bareTextInput(block.listVar, (v) => this.host.updateBlock(block.id, (b) => ({ ...(b as MapBlock), listVar: v }))),
          ),
          h(
            "div",
            { className: "pl-field" },
            h("label", { className: "pl-field-label", textContent: "Item variable name" }),
            bareTextInput(block.itemVar, (v) => this.host.updateBlock(block.id, (b) => ({ ...(b as MapBlock), itemVar: v }))),
            h("div", { className: "pl-field-hint", textContent: "Each item is exposed to the prompt as ${vars.<name>}." }),
          ),
        ),
      ),
    );

    const prompt = boundTextarea(block.prompt, "Prompt run once per item…", "pl-block-prompt", (v) =>
      this.host.updateBlock(block.id, (b) => ({ ...(b as MapBlock), prompt: v })),
    );
    form.appendChild(inspectorSection(ICON_FILE_TEXT, "Per-item prompt", h("div", {}, prompt, refHint())));

    form.appendChild(
      inspectorSection(
        ICON_SLIDERS,
        "Execution",
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "12px" } },
          fieldModel(block.model, (v) => this.host.updateBlock(block.id, (b) => ({ ...(b as MapBlock), model: v }))),
          fieldEffort(block.effort, (v) => this.host.updateBlock(block.id, (b) => ({ ...(b as MapBlock), effort: v }))),
        ),
      ),
    );

    form.appendChild(
      inspectorSection(
        ICON_TAG,
        "Output",
        outputVarField(block.outputVar, (v) =>
          this.host.updateBlock(block.id, (b) => ({ ...(b as MapBlock), outputVar: v })),
        ),
      ),
    );

    form.appendChild(dangerRemoveSection(() => this.host.removeBlock(block.id)));
    this.host.panelBody.appendChild(form);
  }

  private renderApprovalInspector(block: ApprovalBlock): void {
    const form = h("div", { className: "pl-inspector-form" });
    form.appendChild(identitySection(block.name, "Name", (v) =>
      this.host.updateBlock(block.id, (b) => ({ ...(b as ApprovalBlock), name: v })),
    ));

    const message = boundTextarea(block.message, "Message shown to the reviewer when the run pauses…", "pl-block-prompt", (v) =>
      this.host.updateBlock(block.id, (b) => ({ ...(b as ApprovalBlock), message: v })),
    );
    form.appendChild(inspectorSection(ICON_APPROVAL, "Approval prompt", h("div", {}, message, refHint())));

    form.appendChild(dangerRemoveSection(() => this.host.removeBlock(block.id)));
    this.host.panelBody.appendChild(form);
  }

  private blocksAfter(blockId: string): readonly Block[] {
    const blocks = this.host.getDraftBlocks();
    const idx = blocks.findIndex((b) => b.id === blockId);
    return idx < 0 ? [] : blocks.slice(idx + 1);
  }
}
