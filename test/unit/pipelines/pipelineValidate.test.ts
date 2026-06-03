import { describe, expect, it } from "vitest";
import { isPipelineValid, validatePipeline } from "../../../src/features/pipelines/domain/validate";
import {
  toBlockId,
  toPipelineId,
  type Pipeline,
  type WorkerBlock,
} from "../../../src/features/pipelines/domain/types";

const block = (overrides: Partial<WorkerBlock> = {}): WorkerBlock => ({
  id: toBlockId("b1"),
  kind: "worker",
  name: "Step one",
  prompt: "Do the thing",
  model: "claude-sonnet-4-6",
  effort: "medium",
  ...overrides,
});

const pipeline = (overrides: Partial<Pipeline> = {}): Pipeline => ({
  id: toPipelineId("p1"),
  name: "My pipeline",
  createdAtMs: 1,
  updatedAtMs: 1,
  blocks: [block()],
  triggers: [],
  ...overrides,
});

describe("validatePipeline", () => {
  it("accepts a single-block pipeline with all fields filled", () => {
    expect(validatePipeline(pipeline())).toEqual([]);
    expect(isPipelineValid(pipeline())).toBe(true);
  });

  it("rejects an empty pipeline name", () => {
    const errors = validatePipeline(pipeline({ name: "   " }));
    expect(errors.map((e) => e.code)).toContain("empty-name");
  });

  it("rejects a pipeline with no blocks", () => {
    const errors = validatePipeline(pipeline({ blocks: [] }));
    expect(errors.map((e) => e.code)).toEqual(["no-blocks"]);
  });

  it("rejects a block with empty name", () => {
    const errors = validatePipeline(pipeline({ blocks: [block({ name: "" })] }));
    const found = errors.find((e) => e.code === "block-empty-name");
    expect(found?.blockId).toBe("b1");
  });

  it("rejects a block with whitespace-only prompt", () => {
    const errors = validatePipeline(pipeline({ blocks: [block({ prompt: "   \n " })] }));
    expect(errors.some((e) => e.code === "block-empty-prompt")).toBe(true);
  });

  it("rejects duplicate block ids", () => {
    const errors = validatePipeline(
      pipeline({
        blocks: [
          block({ id: toBlockId("dup"), name: "A" }),
          block({ id: toBlockId("dup"), name: "B" }),
        ],
      }),
    );
    expect(errors.some((e) => e.code === "duplicate-block-id")).toBe(true);
  });

  it("reports multiple errors at once when a pipeline has several issues", () => {
    const errors = validatePipeline(
      pipeline({
        name: "",
        blocks: [block({ name: "", prompt: "" })],
      }),
    );
    const codes = errors.map((e) => e.code).sort();
    expect(codes).toEqual(["block-empty-name", "block-empty-prompt", "empty-name"]);
  });
});

describe("validatePipeline — Parallel block", () => {
  it("rejects a Parallel block with no parallel workers", () => {
    const errors = validatePipeline(
      pipeline({
        blocks: [
          {
            id: toBlockId("p1"),
            kind: "parallel",
            name: "Split",
            mergerGoal: "Combine",
            mergerModel: "default",
            workers: [],
          },
        ],
      }),
    );
    expect(errors.some((e) => e.code === "parallel-needs-worker")).toBe(true);
  });

  it("rejects a Parallel block whose merger goal is empty", () => {
    const errors = validatePipeline(
      pipeline({
        blocks: [
          {
            id: toBlockId("p1"),
            kind: "parallel",
            name: "Split",
            mergerGoal: "   ",
            mergerModel: "default",
            workers: [block({ id: toBlockId("w1") })],
          },
        ],
      }),
    );
    expect(errors.some((e) => e.code === "merger-empty-goal")).toBe(true);
  });

  it("propagates worker-level errors up with the parallel block id", () => {
    const errors = validatePipeline(
      pipeline({
        blocks: [
          {
            id: toBlockId("p1"),
            kind: "parallel",
            name: "Split",
            mergerGoal: "Combine",
            mergerModel: "default",
            workers: [block({ id: toBlockId("w1"), prompt: "" })],
          },
        ],
      }),
    );
    const propagated = errors.find((e) => e.code === "block-empty-prompt");
    expect(propagated?.blockId).toBe("p1");
  });
});

describe("validatePipeline — Loop block", () => {
  it("rejects a Loop with non-positive max iterations", () => {
    const errors = validatePipeline(
      pipeline({
        blocks: [
          {
            id: toBlockId("l1"),
            kind: "loop",
            name: "Loop",
            loopBackToBlockId: toBlockId("target"),
            goal: "Done when X happens",
            maxIterations: 0,
            evaluatorModel: "default",
          },
        ],
      }),
    );
    expect(errors.some((e) => e.code === "loop-needs-iterations")).toBe(true);
  });

  it("rejects a Loop with no loop-back target", () => {
    const errors = validatePipeline(
      pipeline({
        blocks: [
          {
            id: toBlockId("l1"),
            kind: "loop",
            name: "Loop",
            loopBackToBlockId: null,
            goal: "Done when X happens",
            maxIterations: 3,
            evaluatorModel: "default",
          },
        ],
      }),
    );
    expect(errors.some((e) => e.code === "loop-needs-target")).toBe(true);
  });

  it("rejects a Loop with an empty goal", () => {
    const errors = validatePipeline(
      pipeline({
        blocks: [
          {
            id: toBlockId("l1"),
            kind: "loop",
            name: "Loop",
            loopBackToBlockId: toBlockId("target"),
            goal: "   ",
            maxIterations: 3,
            evaluatorModel: "default",
          },
        ],
      }),
    );
    expect(errors.some((e) => e.code === "loop-empty-goal")).toBe(true);
  });

  it("accepts a Loop with iterations, an earlier target, and a non-empty goal", () => {
    expect(
      validatePipeline(
        pipeline({
          blocks: [
            block({ id: toBlockId("target") }),
            {
              id: toBlockId("l1"),
              kind: "loop",
              name: "Loop",
              loopBackToBlockId: toBlockId("target"),
              goal: "Stop when the output is acceptable",
              maxIterations: 5,
              evaluatorModel: "claude-sonnet-4-6",
            },
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe("validatePipeline — loop/condition target resolution", () => {
  it("rejects a loop pointing back to a block that does not exist", () => {
    const p = pipeline({
      blocks: [
        block({ id: toBlockId("a") }),
        { id: toBlockId("loop"), kind: "loop", name: "Loop", goal: "g", maxIterations: 3, loopBackToBlockId: toBlockId("ghost"), evaluatorModel: "default" },
      ],
    });
    expect(validatePipeline(p).map((e) => e.code)).toContain("loop-target-missing");
  });

  it("rejects a loop pointing to a later block instead of an earlier one", () => {
    const p = pipeline({
      blocks: [
        { id: toBlockId("loop"), kind: "loop", name: "Loop", goal: "g", maxIterations: 3, loopBackToBlockId: toBlockId("a"), evaluatorModel: "default" },
        block({ id: toBlockId("a") }),
      ],
    });
    expect(validatePipeline(p).map((e) => e.code)).toContain("loop-target-not-earlier");
  });

  it("rejects a condition that skips to a missing block", () => {
    const p = pipeline({
      blocks: [
        block({ id: toBlockId("a") }),
        { id: toBlockId("cond"), kind: "condition", name: "Cond", expression: "1 == 1", skipToBlockId: toBlockId("ghost") },
      ],
    });
    expect(validatePipeline(p).map((e) => e.code)).toContain("condition-target-missing");
  });

  it("rejects a condition that skips backward instead of ahead", () => {
    const p = pipeline({
      blocks: [
        block({ id: toBlockId("a") }),
        { id: toBlockId("cond"), kind: "condition", name: "Cond", expression: "1 == 1", skipToBlockId: toBlockId("a") },
      ],
    });
    expect(validatePipeline(p).map((e) => e.code)).toContain("condition-target-not-later");
  });

  it("accepts a condition that skips ahead, or to the end (null)", () => {
    const ahead = pipeline({
      blocks: [
        { id: toBlockId("cond"), kind: "condition", name: "Cond", expression: "1 == 1", skipToBlockId: toBlockId("b") },
        block({ id: toBlockId("a") }),
        block({ id: toBlockId("b") }),
      ],
    });
    expect(validatePipeline(ahead)).toEqual([]);
    const toEnd = pipeline({
      blocks: [
        block({ id: toBlockId("a") }),
        { id: toBlockId("cond"), kind: "condition", name: "Cond", expression: "1 == 1", skipToBlockId: null },
      ],
    });
    expect(validatePipeline(toEnd)).toEqual([]);
  });
});

describe("validate — deterministic blocks", () => {
  const wrap = (b: unknown): Pipeline =>
    ({ id: toPipelineId("p"), name: "P", createdAtMs: 1, updatedAtMs: 1, blocks: [b], triggers: [] } as unknown as Pipeline);

  it("flags a script block with empty code", () => {
    const errs = validatePipeline(wrap({
      id: toBlockId("s1"), kind: "script", name: "Build", interpreter: "bash", code: "   ", outputVar: null,
    }));
    expect(errs.map((e) => e.code)).toContain("script-empty-code");
    expect(errs.find((e) => e.code === "script-empty-code")!.blockId).toBe(toBlockId("s1"));
  });

  it("accepts a valid script block", () => {
    expect(validatePipeline(wrap({
      id: toBlockId("s1"), kind: "script", name: "Build", interpreter: "bash", code: "echo hi", outputVar: "log",
    }))).toEqual([]);
  });

  it("flags an invalid output variable name", () => {
    const errs = validatePipeline(wrap({
      id: toBlockId("s1"), kind: "script", name: "Build", interpreter: "bash", code: "echo", outputVar: "not valid",
    }));
    expect(errs.map((e) => e.code)).toContain("invalid-output-var");
  });

  it("flags an http block with an empty url", () => {
    const errs = validatePipeline(wrap({
      id: toBlockId("h1"), kind: "http", name: "Call", method: "GET", url: "", headers: [], body: null, outputVar: null,
    }));
    expect(errs.map((e) => e.code)).toContain("http-empty-url");
  });

  it("flags an http url that is not http(s) and not a variable reference", () => {
    const errs = validatePipeline(wrap({
      id: toBlockId("h1"), kind: "http", name: "Call", method: "GET", url: "ftp://x", headers: [], body: null, outputVar: null,
    }));
    expect(errs.map((e) => e.code)).toContain("http-invalid-url");
  });

  it("accepts an http url that references a variable", () => {
    expect(validatePipeline(wrap({
      id: toBlockId("h1"), kind: "http", name: "Call", method: "GET", url: "${vars.base}/x", headers: [], body: null, outputVar: null,
    }))).toEqual([]);
  });

  it("flags a file block with an empty path", () => {
    const errs = validatePipeline(wrap({
      id: toBlockId("f1"), kind: "file", name: "Save", operation: "write", path: "  ", content: "x", outputVar: null,
    }));
    expect(errs.map((e) => e.code)).toContain("file-empty-path");
  });

  it("accepts a valid file write block", () => {
    expect(validatePipeline(wrap({
      id: toBlockId("f1"), kind: "file", name: "Save", operation: "write", path: "out.txt", content: "x", outputVar: null,
    }))).toEqual([]);
  });
});

describe("validate — control-flow blocks", () => {
  const wrap = (b: unknown): Pipeline =>
    ({ id: toPipelineId("p"), name: "P", createdAtMs: 1, updatedAtMs: 1, blocks: [b], triggers: [] } as unknown as Pipeline);

  it("flags a condition with an empty expression", () => {
    const errs = validatePipeline(wrap({ id: toBlockId("c1"), kind: "condition", name: "If", expression: "  ", skipToBlockId: null }));
    expect(errs.map((e) => e.code)).toContain("condition-empty-expression");
  });

  it("accepts a valid condition", () => {
    expect(validatePipeline(wrap({ id: toBlockId("c1"), kind: "condition", name: "If", expression: "${vars.x} == y", skipToBlockId: null }))).toEqual([]);
  });

  it("flags a negative wait duration", () => {
    const errs = validatePipeline(wrap({ id: toBlockId("w1"), kind: "wait", name: "P", durationMs: -1 }));
    expect(errs.map((e) => e.code)).toContain("wait-invalid-duration");
  });

  it("flags a reduce with no input variable", () => {
    const errs = validatePipeline(wrap({ id: toBlockId("r1"), kind: "reduce", name: "R", inputVar: "", mode: "concat", separator: ",", mergerGoal: "", mergerModel: "default", outputVar: null }));
    expect(errs.map((e) => e.code)).toContain("reduce-empty-input");
  });

  it("flags an llm reduce with no merger goal", () => {
    const errs = validatePipeline(wrap({ id: toBlockId("r1"), kind: "reduce", name: "R", inputVar: "items", mode: "llm", separator: "\n", mergerGoal: "  ", mergerModel: "default", outputVar: null }));
    expect(errs.map((e) => e.code)).toContain("merger-empty-goal");
  });
});

describe("validate — agent blocks", () => {
  const wrap = (b: unknown): Pipeline =>
    ({ id: toPipelineId("p"), name: "P", createdAtMs: 1, updatedAtMs: 1, blocks: [b], triggers: [] } as unknown as Pipeline);

  it("flags an llm block with no prompt", () => {
    const errs = validatePipeline(wrap({ id: toBlockId("l1"), kind: "llm", name: "Ask", prompt: " ", model: "default", effort: "low", outputVar: null }));
    expect(errs.map((e) => e.code)).toContain("block-empty-prompt");
  });

  it("flags an evaluator with no goal", () => {
    const errs = validatePipeline(wrap({ id: toBlockId("e1"), kind: "evaluator", name: "Gate", goal: "", evaluatorModel: "default" }));
    expect(errs.map((e) => e.code)).toContain("evaluator-empty-goal");
  });

  it("flags a map block with no list variable or invalid item var", () => {
    const errs = validatePipeline(wrap({ id: toBlockId("m1"), kind: "map", name: "M", listVar: "", itemVar: "1bad", prompt: "x", model: "default", effort: "low", outputVar: null }));
    expect(errs.map((e) => e.code)).toContain("map-empty-list");
    expect(errs.map((e) => e.code)).toContain("map-invalid-item-var");
  });

  it("accepts a valid map block", () => {
    expect(validatePipeline(wrap({ id: toBlockId("m1"), kind: "map", name: "M", listVar: "items", itemVar: "item", prompt: "do ${vars.item}", model: "default", effort: "low", outputVar: "out" }))).toEqual([]);
  });
});

describe("validate — triggers", () => {
  it("flags a schedule trigger with a non-positive interval", () => {
    const errs = validatePipeline(pipeline({ triggers: [{ kind: "schedule", intervalMs: 0, enabled: true }] }));
    expect(errs.map((e) => e.code)).toContain("trigger-invalid-interval");
  });

  it("flags a webhook trigger with an empty token", () => {
    const errs = validatePipeline(pipeline({ triggers: [{ kind: "webhook", token: "  ", enabled: true }] }));
    expect(errs.map((e) => e.code)).toContain("trigger-empty-token");
  });

  it("accepts valid triggers", () => {
    expect(validatePipeline(pipeline({ triggers: [
      { kind: "schedule", intervalMs: 1000, enabled: true },
      { kind: "webhook", token: "abc", enabled: false },
    ] }))).toEqual([]);
  });
});
