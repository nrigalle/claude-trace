import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PipelinesController,
  newRunIdFromClock,
  type PipelinesActions,
  type PipelinesHost,
} from "../../src/features/pipelines/app/PipelinesController";
import { StubAutomationRunner } from "../stubs/StubAutomationRunner";
import { StubDeterministicRunner } from "../stubs/StubDeterministicRunner";
import { PipelineStore } from "../../src/features/pipelines/infra/PipelineStore";
import { RunStore } from "../../src/features/pipelines/infra/RunStore";
import {
  toBlockId,
  toPipelineId,
  type Block,
  type Pipeline,
  type RunId,
  type RunState,
} from "../../src/features/pipelines/domain/types";
import type {
  PipelinesHostToWebview,
  PipelinesWebviewToHost,
} from "../../src/features/pipelines/protocol";

class MockHost implements PipelinesHost {
  readonly messages: PipelinesHostToWebview[] = [];
  private messageListener: ((m: PipelinesWebviewToHost) => void) | null = null;
  postMessage(msg: PipelinesHostToWebview): void { this.messages.push(msg); }
  onMessage(l: (m: PipelinesWebviewToHost) => void): { dispose(): void } {
    this.messageListener = l;
    return { dispose: () => { this.messageListener = null; } };
  }
  onDispose(_l: () => void): { dispose(): void } {
    return { dispose: () => {} };
  }
  send(msg: PipelinesWebviewToHost): void {
    if (!this.messageListener) throw new Error("no listener");
    this.messageListener(msg);
  }
  latestRunId(): RunId | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      if (m.type === "runUpdate") return m.run.runId;
    }
    return null;
  }
}

let tmp: string;
let host: MockHost;
let pipelineStore: PipelineStore;
let runStore: RunStore;
let det: StubDeterministicRunner;
let clockMs: number;

const tick = () => { clockMs += 1; return clockMs; };
let runCounter = 0;
const newRunId = (): RunId => newRunIdFromClock(clockMs + ++runCounter);

const actions: PipelinesActions = {
  askPipelineName: () => Promise.resolve("x"),
  confirmDeletePipeline: () => Promise.resolve(true),
  confirmDeleteRun: () => Promise.resolve(true),
  openSessionInTerminal: () => {},
};

const makeController = (runner = new StubAutomationRunner({ workerDurationMs: 1, judgeDurationMs: 1 })) =>
  new PipelinesController({ host, pipelineStore, runStore, runner, deterministic: det, actions, clock: tick, newRunId });

const pipe = (id: string, blocks: readonly Block[]): Pipeline => ({
  id: toPipelineId(id),
  name: id,
  createdAtMs: 1,
  updatedAtMs: 1,
  blocks,
  triggers: [],
});

const waitFor = async (pred: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out");
};

const finalState = (): RunState => {
  const id = host.latestRunId();
  if (!id) throw new Error("no run id seen");
  const s = runStore.get(id);
  if (!s) throw new Error("run not persisted");
  return s;
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-trace-det-"));
  host = new MockHost();
  pipelineStore = new PipelineStore(path.join(tmp, "automations"));
  runStore = new RunStore(path.join(tmp, "runs"));
  det = new StubDeterministicRunner();
  clockMs = 1000;
  runCounter = 0;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("complex deterministic + agent workflow", () => {
  it("threads state through script -> http -> file write -> file read -> worker, with interpolation at every hop", async () => {
    det.scriptHandler = () => ({ stdout: "PAYLOAD_DATA\n", stderr: "", exitCode: 0 });
    det.httpHandler = () => ({ status: 200, body: "HTTP_RESPONSE_BODY" });

    const blocks: readonly Block[] = [
      { id: toBlockId("gen"), kind: "script", name: "Generate", interpreter: "bash", code: "echo data", outputVar: "payload" },
      { id: toBlockId("post"), kind: "http", name: "Post", method: "POST", url: "https://api.test/ingest", headers: [{ name: "X-Token", value: "Bearer ${vars.payload}" }], body: "${vars.payload}", outputVar: "resp" },
      { id: toBlockId("save"), kind: "file", name: "Save", operation: "write", path: "out/result.txt", content: "${vars.resp}", outputVar: null },
      { id: toBlockId("load"), kind: "file", name: "Load", operation: "read", path: "out/result.txt", content: "", outputVar: "loaded" },
      { id: toBlockId("report"), kind: "worker", name: "Report", prompt: "Summarize: ${vars.loaded}", model: "default", effort: "medium" },
    ];
    pipelineStore.save(pipe("flow", blocks));

    makeController();
    host.send({ type: "runPipeline", pipelineId: toPipelineId("flow") });
    await waitFor(() => finalState().status === "completed");

    const state = finalState();
    expect(state.status).toBe("completed");

    expect(state.variables["payload"]).toBe("PAYLOAD_DATA");

    expect(det.httpCalls).toHaveLength(1);
    expect(det.httpCalls[0]!.body).toBe("PAYLOAD_DATA");
    expect(det.httpCalls[0]!.headers[0]!.value).toBe("Bearer PAYLOAD_DATA");
    expect(state.variables["resp"]).toBe("HTTP_RESPONSE_BODY");

    expect(det.fileWrites).toHaveLength(1);
    expect(det.fileWrites[0]!.content).toBe("HTTP_RESPONSE_BODY");
    expect(det.fileWrites[0]!.path).toBe("out/result.txt");
    expect(state.variables["loaded"]).toBe("HTTP_RESPONSE_BODY");

    const report = state.blocks.find((b) => b.blockId === toBlockId("report"))!;
    const prompt = report.sessions.at(-1)!.promptSent;
    expect(prompt).toContain("Summarize: HTTP_RESPONSE_BODY");
    expect(prompt).toContain("<previous_steps>");
  });

  it("propagates a counter through 40 chained script blocks via pipeline variables", async () => {
    det.scriptHandler = (req) => ({
      stdout: String(Number(req.env["counter"] ?? "0") + 1),
      stderr: "",
      exitCode: 0,
    });

    const blocks: Block[] = [];
    for (let i = 0; i < 40; i++) {
      blocks.push({
        id: toBlockId(`s${i}`),
        kind: "script",
        name: `Step ${i}`,
        interpreter: "bash",
        code: "echo next",
        outputVar: "counter",
      });
    }
    pipelineStore.save(pipe("chain", blocks));

    makeController();
    host.send({ type: "runPipeline", pipelineId: toPipelineId("chain") });
    await waitFor(() => finalState().status === "completed");

    expect(finalState().variables["counter"]).toBe("40");
    expect(det.scriptCalls).toHaveLength(40);
    expect(det.scriptCalls.at(-1)!.env["counter"]).toBe("39");
  });

  it("fails the run when a script exits non-zero and leaves later blocks pending", async () => {
    det.scriptHandler = () => ({ stdout: "", stderr: "boom", exitCode: 2 });

    const blocks: readonly Block[] = [
      { id: toBlockId("bad"), kind: "script", name: "Bad", interpreter: "bash", code: "exit 2", outputVar: null },
      { id: toBlockId("after"), kind: "script", name: "After", interpreter: "bash", code: "echo nope", outputVar: null },
    ];
    pipelineStore.save(pipe("failing", blocks));

    makeController();
    host.send({ type: "runPipeline", pipelineId: toPipelineId("failing") });
    await waitFor(() => finalState().status === "failed");

    const state = finalState();
    const bad = state.blocks.find((b) => b.blockId === toBlockId("bad"))!;
    const after = state.blocks.find((b) => b.blockId === toBlockId("after"))!;
    expect(bad.status).toBe("failed");
    expect(bad.failureReason).toContain("code 2");
    expect(after.status).toBe("pending");
    expect(det.scriptCalls).toHaveLength(1);
  });

  it("fails the run when an HTTP block returns a 4xx/5xx status", async () => {
    det.httpHandler = () => ({ status: 503, body: "unavailable" });

    const blocks: readonly Block[] = [
      { id: toBlockId("call"), kind: "http", name: "Call", method: "GET", url: "https://api.test/down", headers: [], body: null, outputVar: null },
    ];
    pipelineStore.save(pipe("http-fail", blocks));

    makeController();
    host.send({ type: "runPipeline", pipelineId: toPipelineId("http-fail") });
    await waitFor(() => finalState().status === "failed");

    expect(finalState().blocks[0]!.failureReason).toContain("503");
  });
});

describe("control-flow: conditions, branching, wait, reduce", () => {
  it("a realistic branch: condition TRUE runs the gated blocks, condition FALSE skips them to the rejoin point", async () => {
    det.scriptHandler = (req) => {
      if (req.code.includes("classify")) return { stdout: "deploy", stderr: "", exitCode: 0 };
      if (req.code.includes("gate-a")) return { stdout: "ran-A", stderr: "", exitCode: 0 };
      if (req.code.includes("rejoin")) return { stdout: "rejoined", stderr: "", exitCode: 0 };
      return { stdout: "x", stderr: "", exitCode: 0 };
    };

    const blocks: readonly Block[] = [
      { id: toBlockId("classify"), kind: "script", name: "Classify", interpreter: "bash", code: "echo classify", outputVar: "intent" },
      { id: toBlockId("cond"), kind: "condition", name: "If deploy", expression: "${vars.intent} == deploy", skipToBlockId: toBlockId("rejoin") },
      { id: toBlockId("gateA"), kind: "script", name: "Deploy step", interpreter: "bash", code: "echo gate-a", outputVar: "deployed" },
      { id: toBlockId("rejoin"), kind: "script", name: "Rejoin", interpreter: "bash", code: "echo rejoin", outputVar: null },
    ];
    pipelineStore.save(pipe("branch-true", blocks));

    makeController();
    host.send({ type: "runPipeline", pipelineId: toPipelineId("branch-true") });
    await waitFor(() => finalState().status === "completed");

    let state = finalState();
    expect(state.blocks.find((b) => b.blockId === toBlockId("cond"))!.status).toBe("done");
    expect(state.blocks.find((b) => b.blockId === toBlockId("gateA"))!.status).toBe("done");
    expect(state.variables["deployed"]).toBe("ran-A");

    det.scriptHandler = (req) => {
      if (req.code.includes("classify")) return { stdout: "ignore", stderr: "", exitCode: 0 };
      if (req.code.includes("gate-a")) return { stdout: "SHOULD-NOT-RUN", stderr: "", exitCode: 0 };
      return { stdout: "x", stderr: "", exitCode: 0 };
    };
    host = new MockHost();
    det.scriptCalls.length = 0;
    pipelineStore.save(pipe("branch-false", blocks.map((b) => b)));
    makeController();
    host.send({ type: "runPipeline", pipelineId: toPipelineId("branch-false") });
    await waitFor(() => finalState().status === "completed");

    state = finalState();
    expect(state.blocks.find((b) => b.blockId === toBlockId("gateA"))!.status).toBe("skipped");
    expect(state.variables["deployed"]).toBeUndefined();
    expect(det.scriptCalls.some((c) => c.code.includes("gate-a"))).toBe(false);
  });

  it("a wait block delays then completes", async () => {
    det.scriptHandler = () => ({ stdout: "ok", stderr: "", exitCode: 0 });
    const blocks: readonly Block[] = [
      { id: toBlockId("w"), kind: "wait", name: "Pause", durationMs: 30 },
      { id: toBlockId("s"), kind: "script", name: "After", interpreter: "bash", code: "echo ok", outputVar: null },
    ];
    pipelineStore.save(pipe("with-wait", blocks));
    makeController();
    const t0 = Date.now();
    host.send({ type: "runPipeline", pipelineId: toPipelineId("with-wait") });
    await waitFor(() => finalState().status === "completed");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(finalState().blocks.find((b) => b.blockId === toBlockId("w"))!.status).toBe("done");
  });

  it("a concat reduce joins the lines of its input variable into the configured separator", async () => {
    det.scriptHandler = () => ({ stdout: "alpha\n\nbeta\ngamma", stderr: "", exitCode: 0 });
    const blocks: readonly Block[] = [
      { id: toBlockId("gen"), kind: "script", name: "Gen list", interpreter: "bash", code: "echo list", outputVar: "items" },
      { id: toBlockId("red"), kind: "reduce", name: "Join", inputVar: "items", mode: "concat", separator: ", ", mergerGoal: "", mergerModel: "default", outputVar: "joined" },
    ];
    pipelineStore.save(pipe("reduce-concat", blocks));
    makeController();
    host.send({ type: "runPipeline", pipelineId: toPipelineId("reduce-concat") });
    await waitFor(() => finalState().status === "completed");
    expect(finalState().variables["joined"]).toBe("alpha, beta, gamma");
  });
});

describe("agent blocks: llm, evaluator, map", () => {
  it("an llm block stores its reply in a variable that a later block reads", async () => {
    det.scriptHandler = () => ({ stdout: "ok", stderr: "", exitCode: 0 });
    const blocks: readonly Block[] = [
      { id: toBlockId("ask"), kind: "llm", name: "Ask", prompt: "Say something", model: "default", effort: "low", outputVar: "answer" },
      { id: toBlockId("use"), kind: "file", name: "Save", operation: "write", path: "answer.txt", content: "${vars.answer}", outputVar: null },
    ];
    pipelineStore.save(pipe("llm-flow", blocks));
    makeController();
    host.send({ type: "runPipeline", pipelineId: toPipelineId("llm-flow") });
    await waitFor(() => finalState().status === "completed");

    const state = finalState();
    expect(state.variables["answer"]).toContain("stub assistant output");
    expect(det.fileWrites[0]!.content).toBe(state.variables["answer"]);
  });

  it("an evaluator that passes lets the run complete", async () => {
    const blocks: readonly Block[] = [
      { id: toBlockId("gate"), kind: "evaluator", name: "Gate", goal: "Everything looks good", evaluatorModel: "default" },
      { id: toBlockId("after"), kind: "llm", name: "After", prompt: "go", model: "default", effort: "low", outputVar: null },
    ];
    pipelineStore.save(pipe("eval-pass", blocks));
    makeController(new StubAutomationRunner({ workerDurationMs: 1, judgeDurationMs: 1 }));
    host.send({ type: "runPipeline", pipelineId: toPipelineId("eval-pass") });
    await waitFor(() => finalState().status === "completed");

    const state = finalState();
    expect(state.blocks.find((b) => b.blockId === toBlockId("gate"))!.status).toBe("done");
    expect(state.blocks.find((b) => b.blockId === toBlockId("after"))!.status).toBe("done");
  });

  it("an evaluator that fails halts the run and leaves later blocks pending", async () => {
    const blocks: readonly Block[] = [
      { id: toBlockId("gate"), kind: "evaluator", name: "Gate", goal: "Must be perfect", evaluatorModel: "default" },
      { id: toBlockId("after"), kind: "llm", name: "After", prompt: "go", model: "default", effort: "low", outputVar: null },
    ];
    pipelineStore.save(pipe("eval-fail", blocks));
    makeController(new StubAutomationRunner({
      workerDurationMs: 1,
      judgeDurationMs: 1,
      decide: () => ({ kind: "needs-input", reason: "criteria not met" }),
    }));
    host.send({ type: "runPipeline", pipelineId: toPipelineId("eval-fail") });
    await waitFor(() => finalState().status === "failed");

    const state = finalState();
    expect(state.blocks.find((b) => b.blockId === toBlockId("gate"))!.status).toBe("failed");
    expect(state.blocks.find((b) => b.blockId === toBlockId("after"))!.status).toBe("pending");
  });

  it("a map block runs the prompt once per list item and collects every result", async () => {
    det.scriptHandler = () => ({ stdout: "apple\nbanana\ncherry", stderr: "", exitCode: 0 });
    const blocks: readonly Block[] = [
      { id: toBlockId("list"), kind: "script", name: "List", interpreter: "bash", code: "echo fruits", outputVar: "fruits" },
      { id: toBlockId("each"), kind: "map", name: "Per fruit", listVar: "fruits", itemVar: "fruit", prompt: "Describe ${vars.fruit}", model: "default", effort: "low", outputVar: "described" },
    ];
    pipelineStore.save(pipe("map-flow", blocks));
    makeController();
    host.send({ type: "runPipeline", pipelineId: toPipelineId("map-flow") });
    await waitFor(() => finalState().status === "completed");

    const state = finalState();
    const mapRun = state.blocks.find((b) => b.blockId === toBlockId("each"))!;
    expect(mapRun.sessions).toHaveLength(3);
    expect(mapRun.sessions[0]!.promptSent).toContain("Describe apple");
    expect(mapRun.sessions[2]!.promptSent).toContain("Describe cherry");
    expect((state.variables["described"] ?? "").split("\n")).toHaveLength(3);
  });

  it("realistic fan-out/fan-in: script list -> map per item -> reduce concat into one value", async () => {
    det.scriptHandler = () => ({ stdout: "one\ntwo", stderr: "", exitCode: 0 });
    const blocks: readonly Block[] = [
      { id: toBlockId("gen"), kind: "script", name: "Gen", interpreter: "bash", code: "echo items", outputVar: "items" },
      { id: toBlockId("map"), kind: "map", name: "Map", listVar: "items", itemVar: "x", prompt: "handle ${vars.x}", model: "default", effort: "low", outputVar: "results" },
      { id: toBlockId("join"), kind: "reduce", name: "Join", inputVar: "results", mode: "concat", separator: " || ", mergerGoal: "", mergerModel: "default", outputVar: "final" },
    ];
    pipelineStore.save(pipe("fanout", blocks));
    makeController();
    host.send({ type: "runPipeline", pipelineId: toPipelineId("fanout") });
    await waitFor(() => finalState().status === "completed");

    const finalVar = finalState().variables["final"] ?? "";
    expect(finalVar.split(" || ")).toHaveLength(2);
  });
});

describe("approval: human-in-the-loop pause and resume", () => {
  it("pauses at an approval block, then resumeRun completes the rest of the pipeline", async () => {
    det.scriptHandler = () => ({ stdout: "ok", stderr: "", exitCode: 0 });
    const blocks: readonly Block[] = [
      { id: toBlockId("pre"), kind: "script", name: "Pre", interpreter: "bash", code: "echo pre", outputVar: "pre" },
      { id: toBlockId("gate"), kind: "approval", name: "Review", message: "Check ${vars.pre} before continuing" },
      { id: toBlockId("post"), kind: "script", name: "Post", interpreter: "bash", code: "echo post", outputVar: "post" },
    ];
    pipelineStore.save(pipe("approve", blocks));
    makeController();

    host.send({ type: "runPipeline", pipelineId: toPipelineId("approve") });
    await waitFor(() => finalState().status === "paused-needs-input");

    let state = finalState();
    const gate = state.blocks.find((b) => b.blockId === toBlockId("gate"))!;
    expect(gate.status).toBe("stuck");
    expect(gate.stuckReason).toBe("Check ok before continuing");
    expect(state.blocks.find((b) => b.blockId === toBlockId("post"))!.status).toBe("pending");
    expect(state.variables["post"]).toBeUndefined();

    const runId = host.latestRunId()!;
    host.send({ type: "resumeRun", runId });
    await waitFor(() => finalState().status === "completed");

    state = finalState();
    expect(state.blocks.find((b) => b.blockId === toBlockId("gate"))!.status).toBe("done");
    expect(state.blocks.find((b) => b.blockId === toBlockId("post"))!.status).toBe("done");
    expect(state.variables["post"]).toBe("ok");
  });

  it("resumeRun on a run that is not awaiting approval is a no-op", async () => {
    det.scriptHandler = () => ({ stdout: "x", stderr: "", exitCode: 0 });
    pipelineStore.save(pipe("done-run", [{ id: toBlockId("s"), kind: "script", name: "S", interpreter: "bash", code: "echo x", outputVar: null }]));
    makeController();
    host.send({ type: "runPipeline", pipelineId: toPipelineId("done-run") });
    await waitFor(() => finalState().status === "completed");
    const runId = host.latestRunId()!;
    host.send({ type: "resumeRun", runId });
    await new Promise((r) => setTimeout(r, 20));
    expect(finalState().status).toBe("completed");
  });
});
