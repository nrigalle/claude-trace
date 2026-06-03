import { describe, expect, it } from "vitest";
import {
  parsePipeline,
  parseRunState,
  serializePipeline,
  serializeRunState,
} from "../../../src/features/pipelines/domain/parse";
import {
  toBlockId,
  toPipelineId,
  toRunId,
  type Pipeline,
  type RunState,
} from "../../../src/features/pipelines/domain/types";

const samplePipeline = (): Pipeline => ({
  id: toPipelineId("p1"),
  name: "Sample",
  createdAtMs: 100,
  updatedAtMs: 200,
  blocks: [
    {
      id: toBlockId("b1"),
      kind: "worker",
      name: "Step one",
      prompt: "Do the thing",
      model: "claude-sonnet-4-6",
      effort: "high",
    },
  ],
  triggers: [],
});

const sampleRunState = (): RunState => ({
  runId: toRunId("r1"),
  pipelineId: toPipelineId("p1"),
  pipelineSnapshot: samplePipeline(),
  startedAtMs: 500,
  endedAtMs: 600,
  status: "completed",
  blocks: [
    {
      blockId: toBlockId("b1"),
      status: "done",
      sessions: [
        {
          sessionId: "sess-xyz",
          iteration: 0,
          promptSent: "Do the thing",
          summary: "Done",
          workerOutput: null,
          startedAtMs: 510,
          endedAtMs: 590,
        },
      ],
      parallel: null,
      output: null,
      stuckReason: null,
      failureReason: null,
      startedAtMs: 510,
      endedAtMs: 590,
    },
  ],
  variables: {},
});

describe("serializePipeline + parsePipeline", () => {
  it("round-trips a pipeline byte-for-equivalent through JSON", () => {
    const original = samplePipeline();
    const parsed = parsePipeline(JSON.parse(serializePipeline(original)));
    expect(parsed).toEqual(original);
  });

  it("rejects raw input that is not an object", () => {
    expect(parsePipeline(null)).toBeNull();
    expect(parsePipeline(42)).toBeNull();
    expect(parsePipeline("string")).toBeNull();
    expect(parsePipeline([])).toBeNull();
  });

  it("rejects pipelines with a missing or different schema version", () => {
    const ok = JSON.parse(serializePipeline(samplePipeline()));
    delete ok["schemaVersion"];
    expect(parsePipeline(ok)).toBeNull();

    const wrongVersion = JSON.parse(serializePipeline(samplePipeline()));
    wrongVersion["schemaVersion"] = 99;
    expect(parsePipeline(wrongVersion)).toBeNull();
  });

  it("rejects unknown model and effort values", () => {
    const obj = JSON.parse(serializePipeline(samplePipeline()));
    obj["blocks"][0]["model"] = "claude-not-a-real-model";
    expect(parsePipeline(obj)).toBeNull();

    const obj2 = JSON.parse(serializePipeline(samplePipeline()));
    obj2["blocks"][0]["effort"] = "transcend";
    expect(parsePipeline(obj2)).toBeNull();
  });

  it("rejects a non-worker block kind", () => {
    const obj = JSON.parse(serializePipeline(samplePipeline()));
    obj["blocks"][0]["kind"] = "supervisor";
    expect(parsePipeline(obj)).toBeNull();
  });
});

describe("serializeRunState + parseRunState", () => {
  it("round-trips a run state through JSON", () => {
    const original = sampleRunState();
    const parsed = parseRunState(JSON.parse(serializeRunState(original)));
    expect(parsed).toEqual(original);
  });

  it("rejects a corrupt pipelineSnapshot embedded in the run state", () => {
    const obj = JSON.parse(serializeRunState(sampleRunState()));
    obj["pipelineSnapshot"]["blocks"][0]["model"] = "claude-bogus";
    expect(parseRunState(obj)).toBeNull();
  });

  it("rejects unknown block status values", () => {
    const obj = JSON.parse(serializeRunState(sampleRunState()));
    obj["blocks"][0]["status"] = "exploding";
    expect(parseRunState(obj)).toBeNull();
  });
});

describe("serializePipeline — Parallel + Loop", () => {
  it("round-trips a Parallel block with workers and merger settings", () => {
    const original: Pipeline = {
      id: toPipelineId("p1"),
      name: "Has parallel",
      createdAtMs: 100,
      updatedAtMs: 200,
      blocks: [
        {
          id: toBlockId("par1"),
          kind: "parallel",
          name: "Fan out",
          mergerGoal: "Combine the parallel summaries",
          mergerModel: "claude-sonnet-4-6",
          workers: [
            {
              id: toBlockId("w-a-1"),
              kind: "worker",
              name: "Step A",
              prompt: "Do A",
              model: "default",
              effort: "high",
            },
            {
              id: toBlockId("w-b-1"),
              kind: "worker",
              name: "Step B",
              prompt: "Do B",
              model: "claude-sonnet-4-6",
              effort: "medium",
            },
          ],
        },
      ],
      triggers: [],
    };
    const parsed = parsePipeline(JSON.parse(serializePipeline(original)));
    expect(parsed).toEqual(original);
  });

  it("round-trips a Loop block with anchor + goal + evaluator model", () => {
    const original: Pipeline = {
      id: toPipelineId("p1"),
      name: "Has loop",
      createdAtMs: 100,
      updatedAtMs: 200,
      blocks: [
        {
          id: toBlockId("lp1"),
          kind: "loop",
          name: "Repeat",
          loopBackToBlockId: toBlockId("earlier"),
          goal: "Stop when refined enough",
          maxIterations: 4,
          evaluatorModel: "claude-opus-4-7",
        },
      ],
      triggers: [],
    };
    const parsed = parsePipeline(JSON.parse(serializePipeline(original)));
    expect(parsed).toEqual(original);
  });

  it("rejects a Loop with zero max iterations on read", () => {
    const obj = {
      schemaVersion: 1,
      id: "p",
      name: "p",
      createdAtMs: 1,
      updatedAtMs: 1,
      blocks: [
        {
          id: "l",
          kind: "loop",
          name: "L",
          loopBackToBlockId: "x",
          goal: "g",
          maxIterations: 0,
          evaluatorModel: "default",
        },
      ],
    };
    expect(parsePipeline(obj)).toBeNull();
  });
});


describe("new deterministic block kinds round-trip", () => {
  const withBlock = (b: unknown): Pipeline =>
    ({
      id: toPipelineId("p"),
      name: "P",
      createdAtMs: 1,
      updatedAtMs: 2,
      blocks: [b],
      triggers: [],
    } as unknown as Pipeline);

  it("round-trips a script block", () => {
    const p = withBlock({
      id: toBlockId("s1"),
      kind: "script",
      name: "Build",
      interpreter: "python",
      code: "print('hi')",
      outputVar: "build_log",
    });
    expect(parsePipeline(JSON.parse(serializePipeline(p)))).toEqual(p);
  });

  it("round-trips an http block with headers and a null body", () => {
    const p = withBlock({
      id: toBlockId("h1"),
      kind: "http",
      name: "Call",
      method: "POST",
      url: "https://api.test/x",
      headers: [{ name: "Authorization", value: "Bearer ${vars.token}" }],
      body: null,
      outputVar: null,
    });
    expect(parsePipeline(JSON.parse(serializePipeline(p)))).toEqual(p);
  });

  it("round-trips a file block", () => {
    const p = withBlock({
      id: toBlockId("f1"),
      kind: "file",
      name: "Save",
      operation: "write",
      path: "out/report.md",
      content: "# ${vars.title}",
      outputVar: null,
    });
    expect(parsePipeline(JSON.parse(serializePipeline(p)))).toEqual(p);
  });

  it("rejects a script block missing its code", () => {
    const obj = JSON.parse(serializePipeline(withBlock({
      id: toBlockId("s1"), kind: "script", name: "x", interpreter: "bash", code: "echo", outputVar: null,
    })));
    delete obj["blocks"][0]["code"];
    expect(parsePipeline(obj)).toBeNull();
  });

  it("rejects an http block with an unknown method", () => {
    const obj = JSON.parse(serializePipeline(withBlock({
      id: toBlockId("h1"), kind: "http", name: "x", method: "POST", url: "https://a.test", headers: [], body: null, outputVar: null,
    })));
    obj["blocks"][0]["method"] = "TRACE";
    expect(parsePipeline(obj)).toBeNull();
  });
});

describe("run-state backward compatibility", () => {
  it("defaults variables to {} and block output to null when absent (old runs)", () => {
    const obj = JSON.parse(serializeRunState(sampleRunState()));
    delete obj["variables"];
    delete obj["blocks"][0]["output"];
    const parsed = parseRunState(obj);
    expect(parsed).not.toBeNull();
    expect(parsed!.variables).toEqual({});
    expect(parsed!.blocks[0]!.output).toBeNull();
  });

  it("preserves stored variables through a round-trip", () => {
    const original = { ...sampleRunState(), variables: { ticket: "API-9", name: "alex" } };
    const parsed = parseRunState(JSON.parse(serializeRunState(original)));
    expect(parsed!.variables).toEqual({ ticket: "API-9", name: "alex" });
  });
});

describe("control-flow block kinds round-trip", () => {
  const withBlock = (b: unknown): Pipeline =>
    ({ id: toPipelineId("p"), name: "P", createdAtMs: 1, updatedAtMs: 2, blocks: [b], triggers: [] } as unknown as Pipeline);

  it("round-trips a condition block (with and without a rejoin target)", () => {
    const withTarget = withBlock({ id: toBlockId("c1"), kind: "condition", name: "If", expression: "${vars.x} == y", skipToBlockId: toBlockId("join") });
    expect(parsePipeline(JSON.parse(serializePipeline(withTarget)))).toEqual(withTarget);
    const toEnd = withBlock({ id: toBlockId("c1"), kind: "condition", name: "If", expression: "${vars.x}", skipToBlockId: null });
    expect(parsePipeline(JSON.parse(serializePipeline(toEnd)))).toEqual(toEnd);
  });

  it("round-trips a wait block", () => {
    const p = withBlock({ id: toBlockId("w1"), kind: "wait", name: "Pause", durationMs: 2500 });
    expect(parsePipeline(JSON.parse(serializePipeline(p)))).toEqual(p);
  });

  it("rejects a wait block with a negative duration", () => {
    const obj = JSON.parse(serializePipeline(withBlock({ id: toBlockId("w1"), kind: "wait", name: "Pause", durationMs: 1 })));
    obj["blocks"][0]["durationMs"] = -5;
    expect(parsePipeline(obj)).toBeNull();
  });

  it("round-trips a reduce block in both modes", () => {
    const concat = withBlock({ id: toBlockId("r1"), kind: "reduce", name: "Join", inputVar: "items", mode: "concat", separator: ", ", mergerGoal: "", mergerModel: "default", outputVar: "joined" });
    expect(parsePipeline(JSON.parse(serializePipeline(concat)))).toEqual(concat);
    const llm = withBlock({ id: toBlockId("r1"), kind: "reduce", name: "Synth", inputVar: "items", mode: "llm", separator: "\n", mergerGoal: "Summarize", mergerModel: "claude-sonnet-4-6", outputVar: null });
    expect(parsePipeline(JSON.parse(serializePipeline(llm)))).toEqual(llm);
  });

  it("preserves a skipped block status through a run-state round-trip", () => {
    const obj = JSON.parse(serializeRunState(sampleRunState()));
    obj["blocks"][0]["status"] = "skipped";
    const parsed = parseRunState(obj);
    expect(parsed).not.toBeNull();
    expect(parsed!.blocks[0]!.status).toBe("skipped");
  });
});

describe("agent block kinds round-trip", () => {
  const withBlock = (b: unknown): Pipeline =>
    ({ id: toPipelineId("p"), name: "P", createdAtMs: 1, updatedAtMs: 2, blocks: [b], triggers: [] } as unknown as Pipeline);

  it("round-trips an llm block", () => {
    const p = withBlock({ id: toBlockId("l1"), kind: "llm", name: "Ask", prompt: "hi ${vars.x}", model: "claude-opus-4-7", effort: "high", outputVar: "ans" });
    expect(parsePipeline(JSON.parse(serializePipeline(p)))).toEqual(p);
  });

  it("round-trips an evaluator block", () => {
    const p = withBlock({ id: toBlockId("e1"), kind: "evaluator", name: "Gate", goal: "tests pass", evaluatorModel: "default" });
    expect(parsePipeline(JSON.parse(serializePipeline(p)))).toEqual(p);
  });

  it("round-trips a map block", () => {
    const p = withBlock({ id: toBlockId("m1"), kind: "map", name: "Each", listVar: "items", itemVar: "it", prompt: "do ${vars.it}", model: "claude-sonnet-4-6", effort: "medium", outputVar: "out" });
    expect(parsePipeline(JSON.parse(serializePipeline(p)))).toEqual(p);
  });

  it("rejects an evaluator with an unknown model", () => {
    const obj = JSON.parse(serializePipeline(withBlock({ id: toBlockId("e1"), kind: "evaluator", name: "G", goal: "g", evaluatorModel: "default" })));
    obj["blocks"][0]["evaluatorModel"] = "claude-imaginary";
    expect(parsePipeline(obj)).toBeNull();
  });
});

describe("approval block round-trip", () => {
  it("round-trips an approval block", () => {
    const p = { id: toPipelineId("p"), name: "P", createdAtMs: 1, updatedAtMs: 2, blocks: [{ id: toBlockId("a1"), kind: "approval", name: "Review", message: "ok?" }], triggers: [] } as unknown as Pipeline;
    expect(parsePipeline(JSON.parse(serializePipeline(p)))).toEqual(p);
  });
});

describe("pipeline triggers round-trip + backward compat", () => {
  const withTriggers = (triggers: unknown): unknown => ({
    schemaVersion: 1, id: "p", name: "P", createdAtMs: 1, updatedAtMs: 2, blocks: [], triggers,
  });

  it("round-trips schedule and webhook triggers", () => {
    const p: Pipeline = {
      id: toPipelineId("p"), name: "P", createdAtMs: 1, updatedAtMs: 2, blocks: [],
      triggers: [
        { kind: "schedule", enabled: true, recurrence: { type: "weekly", weekdays: [5], atMinute: 540 } },
        { kind: "schedule", enabled: true, recurrence: { type: "interval", everyMs: 60000 } },
        { kind: "webhook", token: "secret-x", enabled: false },
      ],
    };
    expect(parsePipeline(JSON.parse(serializePipeline(p)))).toEqual(p);
  });

  it("migrates a legacy intervalMs schedule trigger to an interval recurrence", () => {
    const parsed = parsePipeline(withTriggers([
      { kind: "schedule", intervalMs: 90000, enabled: true },
    ]));
    expect(parsed!.triggers).toEqual([
      { kind: "schedule", enabled: true, recurrence: { type: "interval", everyMs: 90000 } },
    ]);
  });

  it("defaults triggers to [] when the field is absent (old pipelines)", () => {
    const obj = JSON.parse(serializePipeline({ id: toPipelineId("p"), name: "P", createdAtMs: 1, updatedAtMs: 2, blocks: [], triggers: [] }));
    delete obj["triggers"];
    expect(parsePipeline(obj)!.triggers).toEqual([]);
  });

  it("drops malformed triggers (bad interval, missing token) on read", () => {
    const parsed = parsePipeline(withTriggers([
      { kind: "schedule", intervalMs: 0, enabled: true },
      { kind: "schedule", intervalMs: 5000, enabled: true },
      { kind: "webhook", enabled: true },
    ]));
    expect(parsed!.triggers).toEqual([{ kind: "schedule", enabled: true, recurrence: { type: "interval", everyMs: 5000 } }]);
  });

  it("rejects fractional weekly weekdays because Date.getDay() can never match them", () => {
    const parsed = parsePipeline(withTriggers([
      { kind: "schedule", enabled: true, recurrence: { type: "weekly", weekdays: [1.5], atMinute: 540 } },
    ]));
    expect(parsed!.triggers).toEqual([]);
  });

  it("rejects fractional monthly days instead of rounding model-generated JSON", () => {
    const parsed = parsePipeline(withTriggers([
      { kind: "schedule", enabled: true, recurrence: { type: "monthly", day: 1.5, atMinute: 540 } },
    ]));
    expect(parsed!.triggers).toEqual([]);
  });
});
