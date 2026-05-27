import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PipelineStore } from "../../../src/features/pipelines/infra/PipelineStore";
import { RunStore } from "../../../src/features/pipelines/infra/RunStore";
import {
  toBlockId,
  toPipelineId,
  toRunId,
  type Pipeline,
  type RunState,
} from "../../../src/features/pipelines/domain/types";

const makePipeline = (id: string, name: string, updatedAtMs: number): Pipeline => ({
  id: toPipelineId(id),
  name,
  createdAtMs: 1,
  updatedAtMs,
  blocks: [
    {
      id: toBlockId(`${id}-b1`),
      kind: "worker",
      name: "Only step",
      prompt: "Do",
      model: "default",
      effort: "medium",
    },
  ],
  triggers: [],
});

const makeRunState = (runId: string, pipelineId: string, startedAtMs: number): RunState => ({
  runId: toRunId(runId),
  pipelineId: toPipelineId(pipelineId),
  pipelineSnapshot: makePipeline(pipelineId, "Snapshot", startedAtMs),
  startedAtMs,
  endedAtMs: null,
  status: "running",
  blocks: [
    {
      blockId: toBlockId(`${pipelineId}-b1`),
      status: "pending",
      sessions: [],
      parallel: null,
      output: null,
      stuckReason: null,
      failureReason: null,
      startedAtMs: null,
      endedAtMs: null,
    },
  ],
  variables: {},
});

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-trace-test-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("PipelineStore", () => {
  it("returns an empty list when the directory does not exist", () => {
    const store = new PipelineStore(path.join(tmp, "missing"));
    expect(store.list()).toEqual([]);
  });

  it("creates the directory and persists a pipeline that survives a fresh read", () => {
    const store = new PipelineStore(path.join(tmp, "automations"));
    const p = makePipeline("alpha", "Alpha", 100);
    store.save(p);

    const fresh = new PipelineStore(path.join(tmp, "automations"));
    expect(fresh.get(toPipelineId("alpha"))).toEqual(p);
  });

  it("lists pipelines in descending updatedAt order", () => {
    const store = new PipelineStore(path.join(tmp, "automations"));
    store.save(makePipeline("old", "Old", 100));
    store.save(makePipeline("new", "New", 500));
    store.save(makePipeline("mid", "Mid", 300));
    expect(store.list().map((p) => p.name)).toEqual(["New", "Mid", "Old"]);
  });

  it("delete removes the pipeline file", () => {
    const store = new PipelineStore(path.join(tmp, "automations"));
    const p = makePipeline("alpha", "Alpha", 100);
    store.save(p);
    expect(store.get(p.id)).not.toBeNull();
    store.delete(p.id);
    expect(store.get(p.id)).toBeNull();
  });

  it("skips corrupt files when listing instead of throwing", () => {
    const dir = path.join(tmp, "automations");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "broken.json"), "{not json", "utf8");

    const store = new PipelineStore(dir);
    const p = makePipeline("good", "Good", 1);
    store.save(p);
    expect(store.list().map((x) => x.name)).toEqual(["Good"]);
  });

  it("save is atomic — no .tmp file is left behind after writing", () => {
    const dir = path.join(tmp, "automations");
    const store = new PipelineStore(dir);
    store.save(makePipeline("alpha", "Alpha", 1));
    const stragglers = fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"));
    expect(stragglers).toEqual([]);
  });
});

describe("RunStore", () => {
  it("returns an empty list when the runs directory does not exist", () => {
    const store = new RunStore(path.join(tmp, "missing-runs"));
    expect(store.list()).toEqual([]);
  });

  it("persists a run state and reads it back identically", () => {
    const store = new RunStore(path.join(tmp, "runs"));
    const run = makeRunState("run-1", "alpha", 100);
    store.save(run);

    const fresh = new RunStore(path.join(tmp, "runs"));
    expect(fresh.get(toRunId("run-1"))).toEqual(run);
  });

  it("lists runs sorted by startedAt descending and summarises status + pipeline name", () => {
    const store = new RunStore(path.join(tmp, "runs"));
    store.save(makeRunState("run-old", "alpha", 100));
    store.save(makeRunState("run-new", "alpha", 500));
    store.save(makeRunState("run-mid", "alpha", 300));

    const summaries = store.list();
    expect(summaries.map((r) => r.runId)).toEqual([
      toRunId("run-new"),
      toRunId("run-mid"),
      toRunId("run-old"),
    ]);
    expect(summaries[0]!.status).toBe("running");
    expect(summaries[0]!.pipelineName).toBe("Snapshot");
  });

  it("provides a per-pipeline cwd inside the run directory", () => {
    const store = new RunStore(path.join(tmp, "runs"));
    const cwd = store.pipelineCwdFor(toRunId("run-1"), toPipelineId("alpha"));
    expect(cwd.endsWith(path.join("runs", "run-1", "alpha"))).toBe(true);
  });
});
