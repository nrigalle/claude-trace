import { describe, expect, it } from "vitest";
import {
  initialRunState,
  applyDeterministicStarted,
  applyDeterministicDone,
  applyDeterministicFailed,
  applyBlockSpawned,
  applyBlockStopped,
  applyWorkerOutput,
  setVariable,
  blockOutputsOf,
  applyBlocksSkipped,
  conditionSkipRange,
} from "../../../src/features/pipelines/domain/scheduler";
import {
  toBlockId,
  toPipelineId,
  toRunId,
  fromBlockId,
  type ConditionBlock,
  type Pipeline,
  type ScriptBlock,
  type HttpBlock,
  type WorkerBlock,
} from "../../../src/features/pipelines/domain/types";

const scriptBlock = (id: string): ScriptBlock => ({
  id: toBlockId(id),
  kind: "script",
  name: "Build",
  interpreter: "bash",
  code: "echo hi",
  outputVar: null,
});

const httpBlock = (id: string): HttpBlock => ({
  id: toBlockId(id),
  kind: "http",
  name: "Notify",
  method: "POST",
  url: "https://example.test/hook",
  headers: [],
  body: null,
  outputVar: null,
});

const workerBlock = (id: string): WorkerBlock => ({
  id: toBlockId(id),
  kind: "worker",
  name: "Worker",
  prompt: "do it",
  model: "default",
  effort: "medium",
});

const pipeline = (...blocks: readonly (ScriptBlock | HttpBlock | WorkerBlock)[]): Pipeline => ({
  id: toPipelineId("p"),
  name: "P",
  createdAtMs: 0,
  updatedAtMs: 0,
  blocks,
  triggers: [],
});

const blockRunFor = (state: ReturnType<typeof initialRunState>, id: string) =>
  state.blocks.find((b) => b.blockId === toBlockId(id))!;

describe("deterministic block reducers", () => {
  it("initialRunState seeds empty variables and null block output", () => {
    const state = initialRunState(pipeline(scriptBlock("s1")), toRunId("r"), 100);
    expect(state.variables).toEqual({});
    expect(blockRunFor(state, "s1").output).toBeNull();
    expect(blockRunFor(state, "s1").status).toBe("pending");
  });

  it("applyDeterministicStarted moves the block to running and stamps startedAt", () => {
    const state = applyDeterministicStarted(
      initialRunState(pipeline(scriptBlock("s1")), toRunId("r"), 100),
      toBlockId("s1"),
      200,
    );
    const br = blockRunFor(state, "s1");
    expect(br.status).toBe("running");
    expect(br.startedAtMs).toBe(200);
  });

  it("applyDeterministicDone records the output, marks done, and ends the block", () => {
    const started = applyDeterministicStarted(
      initialRunState(pipeline(scriptBlock("s1")), toRunId("r"), 100),
      toBlockId("s1"),
      200,
    );
    const done = applyDeterministicDone(started, toBlockId("s1"), "build output", 300);
    const br = blockRunFor(done, "s1");
    expect(br.status).toBe("done");
    expect(br.output).toBe("build output");
    expect(br.endedAtMs).toBe(300);
  });

  it("applyDeterministicDone completes the whole run when it is the last pending block", () => {
    const state = initialRunState(pipeline(scriptBlock("s1")), toRunId("r"), 100);
    const done = applyDeterministicDone(state, toBlockId("s1"), "out", 300);
    expect(done.status).toBe("completed");
    expect(done.endedAtMs).toBe(300);
  });

  it("applyDeterministicDone does NOT complete the run while later blocks remain pending", () => {
    const state = initialRunState(pipeline(scriptBlock("s1"), httpBlock("h2")), toRunId("r"), 100);
    const done = applyDeterministicDone(state, toBlockId("s1"), "out", 300);
    expect(done.status).toBe("running");
    expect(done.endedAtMs).toBeNull();
  });

  it("applyDeterministicFailed fails the block and the run", () => {
    const state = initialRunState(pipeline(scriptBlock("s1"), httpBlock("h2")), toRunId("r"), 100);
    const failed = applyDeterministicFailed(state, toBlockId("s1"), "exit 1", 300);
    expect(blockRunFor(failed, "s1").status).toBe("failed");
    expect(blockRunFor(failed, "s1").failureReason).toBe("exit 1");
    expect(failed.status).toBe("failed");
  });

  it("setVariable adds and overwrites without mutating the prior state", () => {
    const s0 = initialRunState(pipeline(scriptBlock("s1")), toRunId("r"), 100);
    const s1 = setVariable(s0, "ticket", "API-1");
    const s2 = setVariable(s1, "ticket", "API-2");
    expect(s0.variables).toEqual({});
    expect(s1.variables).toEqual({ ticket: "API-1" });
    expect(s2.variables).toEqual({ ticket: "API-2" });
  });

  it("blockOutputsOf exposes deterministic outputs keyed by block id", () => {
    const state = applyDeterministicDone(
      initialRunState(pipeline(scriptBlock("s1"), httpBlock("h2")), toRunId("r"), 100),
      toBlockId("s1"),
      "the build log",
      300,
    );
    expect(blockOutputsOf(state)).toEqual({ s1: "the build log" });
  });

  it("blockOutputsOf falls back to a worker block's last assistant text", () => {
    let state = initialRunState(pipeline(workerBlock("w1")), toRunId("r"), 100);
    state = applyBlockSpawned(state, toBlockId("w1"), "sess", "prompt", 110);
    state = applyBlockStopped(state, toBlockId("w1"), 120);
    state = applyWorkerOutput(state, toBlockId("w1"), "the worker said this");
    expect(blockOutputsOf(state)).toEqual({ w1: "the worker said this" });
  });
});

const condBlock = (id: string, skipTo: string | null): ConditionBlock => ({
  id: toBlockId(id),
  kind: "condition",
  name: "Cond",
  expression: "${vars.x} == y",
  skipToBlockId: skipTo === null ? null : toBlockId(skipTo),
});

describe("conditionSkipRange", () => {
  const blocks = [scriptBlock("a"), condBlock("c", "join"), scriptBlock("b1"), scriptBlock("b2"), scriptBlock("join")];

  it("returns the blocks between the condition and the rejoin point (exclusive)", () => {
    expect(conditionSkipRange(blocks, toBlockId("c"), toBlockId("join")).map(fromBlockId)).toEqual(["b1", "b2"]);
  });

  it("skips to the end when no rejoin point is given", () => {
    expect(conditionSkipRange(blocks, toBlockId("c"), null).map(fromBlockId)).toEqual(["b1", "b2", "join"]);
  });

  it("returns nothing when the rejoin point is immediately after the condition", () => {
    const adjacent = [condBlock("c", "next"), scriptBlock("next")];
    expect(conditionSkipRange(adjacent, toBlockId("c"), toBlockId("next"))).toEqual([]);
  });
});

describe("applyBlocksSkipped", () => {
  it("marks pending blocks skipped and completes the run when nothing else is pending", () => {
    const state = initialRunState(pipeline(scriptBlock("a"), scriptBlock("b")), toRunId("r"), 0);
    const afterA = applyDeterministicDone(state, toBlockId("a"), "out", 10);
    const skipped = applyBlocksSkipped(afterA, [toBlockId("b")], 20);
    expect(blockRunFor(skipped, "b").status).toBe("skipped");
    expect(skipped.status).toBe("completed");
  });

  it("does not resurrect or alter a block that already ran", () => {
    const state = initialRunState(pipeline(scriptBlock("a"), scriptBlock("b")), toRunId("r"), 0);
    const afterA = applyDeterministicDone(state, toBlockId("a"), "out", 10);
    const skipped = applyBlocksSkipped(afterA, [toBlockId("a"), toBlockId("b")], 20);
    expect(blockRunFor(skipped, "a").status).toBe("done");
    expect(blockRunFor(skipped, "b").status).toBe("skipped");
  });
});
