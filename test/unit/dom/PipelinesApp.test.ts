import { describe, expect, it } from "vitest";
import { PipelinesApp } from "../../../media/src/pipelines/PipelinesApp";
import {
  toBlockId,
  toPipelineId,
  toRunId,
  type BlockRun,
  type FileBlock,
  type HttpBlock,
  type Pipeline,
  type RunState,
  type ScriptBlock,
  type WorkerBlock,
} from "../../../src/features/pipelines/domain/types";
import type { PipelinesListPayload, RunSummary } from "../../../src/features/pipelines/protocol";

const worker = (id: string, name: string): WorkerBlock => ({
  id: toBlockId(id),
  kind: "worker",
  name,
  prompt: "do the thing",
  model: "claude-sonnet-4-6",
  effort: "medium",
});

const pipeline = (id: string, name: string, blocks: WorkerBlock[]): Pipeline => ({
  id: toPipelineId(id),
  name,
  createdAtMs: 0,
  updatedAtMs: 0,
  blocks,
  triggers: [],
});

const runSummary = (opts: { runId: string; pipelineId: string; status?: RunSummary["status"]; blockCount?: number }): RunSummary => ({
  runId: toRunId(opts.runId),
  pipelineId: toPipelineId(opts.pipelineId),
  pipelineName: "p",
  name: "",
  startedAtMs: 0,
  endedAtMs: null,
  status: opts.status ?? "running",
  blockCount: opts.blockCount ?? 1,
});

const blockRun = (blockId: string, status: BlockRun["status"], sessionsCount = 0): BlockRun => ({
  blockId: toBlockId(blockId),
  status,
  sessions: Array.from({ length: sessionsCount }, (_, i) => ({
    sessionId: `s-${blockId}-${i}`,
    iteration: i,
    promptSent: "p",
    summary: null,
    workerOutput: null,
    startedAtMs: 0,
    endedAtMs: null,
  })),
  parallel: null,
  output: null,
  stuckReason: null,
  failureReason: null,
  startedAtMs: null,
  endedAtMs: null,
});

const runState = (
  runId: string,
  pipelineSnapshot: Pipeline,
  blocks: BlockRun[],
  status: RunState["status"] = "running",
): RunState => ({
  runId: toRunId(runId),
  pipelineId: pipelineSnapshot.id,
  name: "",
  pipelineSnapshot,
  startedAtMs: 0,
  endedAtMs: null,
  status,
  blocks,
  variables: {},
});

const noopSend = () => {};

describe("PipelinesApp — view identity", () => {
  it("element() returns the same DOM node across pipelines list updates", () => {
    const app = new PipelinesApp({ send: noopSend });
    const before = app.element();
    app.receive({
      type: "pipelinesList",
      payload: { pipelines: [pipeline("p1", "First", [worker("w1", "Worker")])], runs: [] } as PipelinesListPayload,
    });
    app.receive({
      type: "pipelinesList",
      payload: { pipelines: [pipeline("p1", "Renamed", [worker("w1", "Worker")])], runs: [] } as PipelinesListPayload,
    });
    expect(app.element()).toBe(before);
  });

  it("sidebar pipeline button keeps its DOM identity when only metadata changes", () => {
    const app = new PipelinesApp({ send: noopSend });
    app.receive({
      type: "pipelinesList",
      payload: { pipelines: [pipeline("p1", "Build", [worker("w1", "Worker")])], runs: [] } as PipelinesListPayload,
    });
    const root = app.element();
    const buttonBefore = root.querySelector<HTMLButtonElement>(".pl-sidebar-item")!;
    expect(buttonBefore).toBeTruthy();

    app.receive({
      type: "pipelinesList",
      payload: {
        pipelines: [pipeline("p1", "Build v2", [worker("w1", "Worker"), worker("w2", "Worker 2")])],
        runs: [runSummary({ runId: "r1", pipelineId: "p1" })],
      } as PipelinesListPayload,
    });
    const buttonAfter = root.querySelector<HTMLButtonElement>(".pl-sidebar-item")!;
    expect(buttonAfter).toBe(buttonBefore);
    expect(buttonAfter.querySelector(".pl-sidebar-item-name")!.textContent).toBe("Build v2");
    expect(buttonAfter.querySelector(".pl-sidebar-item-meta span")!.textContent).toBe("2 blocks");
    expect(buttonAfter.querySelector(".pl-run-count-badge")!.textContent).toBe("1 run");
  });

  it("removing a pipeline removes only its row; remaining pipeline buttons keep identity", () => {
    const app = new PipelinesApp({ send: noopSend });
    app.receive({
      type: "pipelinesList",
      payload: {
        pipelines: [
          pipeline("p1", "Alpha", [worker("w1", "W1")]),
          pipeline("p2", "Beta", [worker("w2", "W2")]),
        ],
        runs: [],
      } as PipelinesListPayload,
    });
    const root = app.element();
    const buttons = root.querySelectorAll<HTMLButtonElement>(".pl-sidebar-item");
    expect(buttons).toHaveLength(2);
    const betaButton = buttons[1]!;

    app.receive({
      type: "pipelinesList",
      payload: {
        pipelines: [pipeline("p2", "Beta", [worker("w2", "W2")])],
        runs: [],
      } as PipelinesListPayload,
    });
    const remaining = root.querySelectorAll<HTMLButtonElement>(".pl-sidebar-item");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!).toBe(betaButton);
  });
});

interface PrivateSelect {
  handleSelectRun(runId: ReturnType<typeof toRunId>): void;
}

describe("PipelinesApp — run detail in-place mutation", () => {
  const setupRunningRun = () => {
    const p = pipeline("p1", "Demo", [worker("w1", "Step 1"), worker("w2", "Step 2")]);
    const app = new PipelinesApp({ send: noopSend });
    app.receive({
      type: "pipelinesList",
      payload: { pipelines: [p], runs: [runSummary({ runId: "r1", pipelineId: "p1" })] },
    });
    (app as unknown as PrivateSelect).handleSelectRun(toRunId("r1"));
    const initial = runState("r1", p, [blockRun("w1", "running", 1), blockRun("w2", "pending")]);
    app.receive({ type: "runUpdate", run: initial });

    const root = app.element();
    const stack = root.querySelector<HTMLElement>(".pl-canvas-stack")!;
    const block1Bubble = stack.querySelector<HTMLElement>(`.pl-node-bubble[data-block-id="w1"]`)!;
    const block1Badge = stack.querySelector<HTMLElement>(`.pl-node[data-block-id="w1"] .pl-status-badge`)!;
    expect(block1Bubble.getAttribute("data-status")).toBe("running");
    return { app, p, stack, block1Bubble, block1Badge };
  };

  it("same-run runUpdate mutates status in place without rebuilding the stack", () => {
    const { app, p, stack, block1Bubble, block1Badge } = setupRunningRun();

    const advanced = runState("r1", p, [blockRun("w1", "done", 1), blockRun("w2", "running", 1)]);
    app.receive({ type: "runUpdate", run: advanced });

    const root = app.element();
    const stackAfter = root.querySelector<HTMLElement>(".pl-canvas-stack")!;
    expect(stackAfter).toBe(stack);

    const block1BubbleAfter = stackAfter.querySelector<HTMLElement>(`.pl-node-bubble[data-block-id="w1"]`)!;
    expect(block1BubbleAfter).toBe(block1Bubble);
    expect(block1BubbleAfter.getAttribute("data-status")).toBe("done");

    const block1BadgeAfter = stackAfter.querySelector<HTMLElement>(`.pl-node[data-block-id="w1"] .pl-status-badge`)!;
    expect(block1BadgeAfter).toBe(block1Badge);
    expect(block1BadgeAfter.textContent).toBe("done");
  });

  it("a different runId triggers a full rebuild (new stack identity)", () => {
    const { app, stack } = setupRunningRun();
    const otherPipeline = pipeline("p1", "Demo", [worker("w1", "Step 1"), worker("w2", "Step 2")]);
    app.receive({
      type: "pipelinesList",
      payload: {
        pipelines: [otherPipeline],
        runs: [
          runSummary({ runId: "r1", pipelineId: "p1" }),
          runSummary({ runId: "r2", pipelineId: "p1" }),
        ],
      },
    });
    (app as unknown as PrivateSelect).handleSelectRun(toRunId("r2"));
    const otherRun = runState("r2", otherPipeline, [blockRun("w1", "running", 1), blockRun("w2", "pending")]);
    app.receive({ type: "runUpdate", run: otherRun });

    const stackAfter = app.element().querySelector<HTMLElement>(".pl-canvas-stack")!;
    expect(stackAfter).not.toBe(stack);
  });

  it("end-node state flips to completed when the run completes without rebuilding the stack", () => {
    const { app, p, stack } = setupRunningRun();
    const doneA = blockRun("w1", "done", 1);
    const doneB = { ...blockRun("w2", "done", 1), output: "final output" };
    const completed = runState("r1", p, [doneA, doneB], "completed");
    app.receive({ type: "runUpdate", run: completed });

    const stackAfter = app.element().querySelector<HTMLElement>(".pl-canvas-stack")!;
    expect(stackAfter).toBe(stack);
    const endNode = stackAfter.querySelector<HTMLElement>(`.pl-static-node[data-pos="end"] .pl-node-bubble`);
    expect(endNode?.getAttribute("data-run-state")).toBe("completed");
    expect(app.element().querySelector(".pl-run-results")?.textContent).toContain("final output");
  });

  it("leaving run view clears the run-render cache before the next same-run render", () => {
    const { app, p } = setupRunningRun();
    app.receive({ type: "pipelineDetail", pipeline: p });

    const editorStack = app.element().querySelector<HTMLElement>(".pl-canvas-stack")!;
    expect(editorStack.querySelector(".pl-node-remove")).not.toBeNull();

    const completed = runState("r1", p, [blockRun("w1", "done", 1), blockRun("w2", "done", 1)], "completed");
    (app as unknown as { renderRunDetail(run: RunState): void }).renderRunDetail(completed);

    const runStack = app.element().querySelector<HTMLElement>(".pl-canvas-stack")!;
    expect(runStack).not.toBe(editorStack);
    expect(runStack.querySelector(".pl-node-remove")).toBeNull();
    expect(runStack.querySelector<HTMLElement>(`.pl-static-node[data-pos="end"] .pl-node-bubble`)?.getAttribute("data-run-state")).toBe("completed");
  });
});

const scriptB = (id: string, name: string): ScriptBlock => ({
  id: toBlockId(id), kind: "script", name, interpreter: "bash", code: "echo hi", outputVar: "out",
});
const httpB = (id: string, name: string): HttpBlock => ({
  id: toBlockId(id), kind: "http", name, method: "POST", url: "https://api.test/x", headers: [], body: null, outputVar: null,
});
const fileB = (id: string, name: string): FileBlock => ({
  id: toBlockId(id), kind: "file", name, operation: "write", path: "out.txt", content: "x", outputVar: null,
});

const mixedPipeline = (id: string): Pipeline => ({
  id: toPipelineId(id),
  name: id,
  createdAtMs: 0,
  updatedAtMs: 0,
  blocks: [scriptB("s1", "Build"), httpB("h1", "Notify"), fileB("f1", "Save")],
  triggers: [],
});

describe("PipelinesApp — deterministic block rendering", () => {
  it("renders canvas nodes for script, http, and file blocks with their kind sublabels", () => {
    const app = new PipelinesApp({ send: noopSend });
    app.receive({ type: "pipelineDetail", pipeline: mixedPipeline("mix") });
    const root = app.element();

    expect(root.querySelector(`.pl-node-bubble.kind-script[data-block-id="s1"]`)).not.toBeNull();
    expect(root.querySelector(`.pl-node-bubble.kind-http[data-block-id="h1"]`)).not.toBeNull();
    expect(root.querySelector(`.pl-node-bubble.kind-file[data-block-id="f1"]`)).not.toBeNull();

    const labels = Array.from(root.querySelectorAll(".pl-node-label-kind")).map((e) => e.textContent);
    expect(labels.some((l) => l?.includes("Script · bash"))).toBe(true);
    expect(labels.some((l) => l?.includes("HTTP · POST"))).toBe(true);
    expect(labels.some((l) => l?.includes("File · write"))).toBe(true);
  });

  it("opens a script block inspector with interpreter, code, and output-variable fields", () => {
    const app = new PipelinesApp({ send: noopSend });
    app.receive({ type: "pipelineDetail", pipeline: mixedPipeline("mix") });
    (app as unknown as { openInspector(id: string): void }).openInspector("s1");
    const root = app.element();

    const selects = Array.from(root.querySelectorAll<HTMLSelectElement>(".pl-field-select"));
    const values = selects.flatMap((s) => Array.from(s.options).map((o) => o.value));
    expect(values).toContain("python");
    expect(root.querySelector(".pl-code")).not.toBeNull();
  });

  it("a script block's run node mutates status in place across runUpdates (same node identity)", () => {
    const p = mixedPipeline("mix");
    const app = new PipelinesApp({ send: noopSend });
    app.receive({ type: "pipelinesList", payload: { pipelines: [p], runs: [runSummary({ runId: "r1", pipelineId: "mix", blockCount: 3 })] } });
    (app as unknown as { handleSelectRun(id: ReturnType<typeof toRunId>): void }).handleSelectRun(toRunId("r1"));

    app.receive({ type: "runUpdate", run: runState("r1", p, [blockRun("s1", "running"), blockRun("h1", "pending"), blockRun("f1", "pending")]) });
    const stack = app.element().querySelector<HTMLElement>(".pl-canvas-stack")!;
    const bubble = stack.querySelector<HTMLElement>(`.pl-node-bubble[data-block-id="s1"]`)!;
    expect(bubble.getAttribute("data-status")).toBe("running");

    app.receive({ type: "runUpdate", run: runState("r1", p, [blockRun("s1", "done"), blockRun("h1", "running"), blockRun("f1", "pending")]) });
    const stackAfter = app.element().querySelector<HTMLElement>(".pl-canvas-stack")!;
    const bubbleAfter = stackAfter.querySelector<HTMLElement>(`.pl-node-bubble[data-block-id="s1"]`)!;
    expect(stackAfter).toBe(stack);
    expect(bubbleAfter).toBe(bubble);
    expect(bubbleAfter.getAttribute("data-status")).toBe("done");
  });
});

describe("PipelinesApp — run rename survives live updates (regression: typing clobbered by runUpdate)", () => {
  it("defers runUpdate re-renders while the header name input is focused, then applies them after blur commits the rename", async () => {
    const sent: { type: string }[] = [];
    const p = pipeline("p1", "Demo", [worker("w1", "Step 1")]);
    const app = new PipelinesApp({ send: (m) => sent.push(m as { type: string }) });
    document.body.appendChild(app.element());
    app.receive({
      type: "pipelinesList",
      payload: { pipelines: [p], runs: [runSummary({ runId: "r1", pipelineId: "p1" })] },
    });
    (app as unknown as PrivateSelect).handleSelectRun(toRunId("r1"));
    app.receive({ type: "runUpdate", run: runState("r1", p, [blockRun("w1", "running", 1)]) });

    const input = app.element().querySelector<HTMLInputElement>(".pl-run-name-input")!;
    input.focus();
    input.value = "Maquette Namo";
    expect(document.activeElement).toBe(input);

    app.receive({ type: "runUpdate", run: runState("r1", p, [blockRun("w1", "running", 2)]) });
    const inputAfter = app.element().querySelector<HTMLInputElement>(".pl-run-name-input")!;
    expect(inputAfter, "the input must NOT be rebuilt mid-typing").toBe(input);
    expect(inputAfter.value).toBe("Maquette Namo");
    expect(document.activeElement).toBe(input);

    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
    await new Promise((r) => setTimeout(r, 5));

    expect(sent.some((m) => m.type === "renameRun"), "blur commits the rename").toBe(true);
    const rebuilt = app.element().querySelector<HTMLInputElement>(".pl-run-name-input")!;
    expect(rebuilt, "the deferred runUpdate re-render applies once editing ends").not.toBe(input);
    document.body.removeChild(app.element());
  });
});
