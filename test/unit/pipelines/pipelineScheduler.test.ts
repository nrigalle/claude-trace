import { describe, expect, it } from "vitest";
import {
  applyBlockCrashed,
  applyBlockResumed,
  applyBlockSpawned,
  applyBlockStopped,
  applyDecision,
  applyInterrupted,
  applyPoolOrchestrator,
  applyResumeInterrupted,
  initialRunState,
  nextPendingBlock,
} from "../../../src/features/pipelines/domain/scheduler";
import {
  toBlockId,
  toPipelineId,
  toRunId,
  type Pipeline,
  type WorkerBlock,
} from "../../../src/features/pipelines/domain/types";

const worker = (id: string, name: string, prompt: string): WorkerBlock => ({
  id: toBlockId(id),
  kind: "worker",
  name,
  prompt,
  model: "claude-sonnet-4-6",
  effort: "medium",
});

const threeStep = (): Pipeline => ({
  id: toPipelineId("p1"),
  name: "Three step",
  createdAtMs: 0,
  updatedAtMs: 0,
  blocks: [
    worker("a", "Plan", "Plan the refactor"),
    worker("b", "Implement", "Apply the plan"),
    worker("c", "Verify", "Verify the result"),
  ],
});

describe("initialRunState", () => {
  it("starts every block as pending and the run as running", () => {
    const s = initialRunState(threeStep(), toRunId("r1"), 100);
    expect(s.status).toBe("running");
    expect(s.endedAtMs).toBeNull();
    expect(s.blocks.map((b) => b.status)).toEqual(["pending", "pending", "pending"]);
  });

  it("snapshots the pipeline definition so later edits don't affect the run", () => {
    const p = threeStep();
    const s = initialRunState(p, toRunId("r1"), 100);
    expect(s.pipelineSnapshot.blocks.length).toBe(3);
  });
});

describe("nextPendingBlock", () => {
  it("returns the first pending block by declaration order", () => {
    const s = initialRunState(threeStep(), toRunId("r1"), 0);
    expect(nextPendingBlock(s)).toBe(toBlockId("a"));
  });

  it("returns null when no pending blocks remain", () => {
    const p = threeStep();
    let s = initialRunState(p, toRunId("r1"), 0);
    for (const b of p.blocks) {
      s = applyBlockSpawned(s, b.id, `session-${b.id}`, "p", 0);
      s = applyBlockStopped(s, b.id, 0);
      s = applyDecision(s, b.id, { kind: "success", summary: "ok" }, 0);
    }
    expect(nextPendingBlock(s)).toBeNull();
  });
});

describe("worker lifecycle", () => {
  it("moves a block pending → running → judging → done as work proceeds", () => {
    let s = initialRunState(threeStep(), toRunId("r1"), 0);
    s = applyBlockSpawned(s, toBlockId("a"), "session-a", "Plan the refactor", 10);
    expect(s.blocks[0]!.status).toBe("running");
    expect(s.blocks[0]!.sessions[0]!.sessionId).toBe("session-a");
    expect(s.blocks[0]!.sessions[0]!.promptSent).toBe("Plan the refactor");
    expect(s.blocks[0]!.startedAtMs).toBe(10);

    s = applyBlockStopped(s, toBlockId("a"), 0);
    expect(s.blocks[0]!.status).toBe("judging");

    s = applyDecision(s, toBlockId("a"), { kind: "success", summary: "Plan ready" }, 20);
    expect(s.blocks[0]!.status).toBe("done");
    expect(s.blocks[0]!.sessions[0]!.summary).toBe("Plan ready");
    expect(s.blocks[0]!.endedAtMs).toBe(20);
  });

  it("does not advance any other block when one succeeds — dispatch is the controller's job", () => {
    let s = initialRunState(threeStep(), toRunId("r1"), 0);
    s = applyBlockSpawned(s, toBlockId("a"), "session-a", "p", 0);
    s = applyBlockStopped(s, toBlockId("a"), 0);
    s = applyDecision(s, toBlockId("a"), { kind: "success", summary: "ok" }, 0);
    expect(s.blocks[1]!.status).toBe("pending");
    expect(s.blocks[2]!.status).toBe("pending");
  });
});

describe("applyDecision", () => {
  it("marks the run completed when the LAST block succeeds", () => {
    const p = threeStep();
    let s = initialRunState(p, toRunId("r1"), 0);
    for (const b of p.blocks) {
      s = applyBlockSpawned(s, b.id, `session-${b.id}`, "p", 0);
      s = applyBlockStopped(s, b.id, 0);
      s = applyDecision(s, b.id, { kind: "success", summary: "ok" }, 50);
    }
    expect(s.status).toBe("completed");
    expect(s.endedAtMs).toBe(50);
  });

  it("does NOT mark the run completed when an earlier block succeeds — others remain", () => {
    let s = initialRunState(threeStep(), toRunId("r1"), 0);
    s = applyBlockSpawned(s, toBlockId("a"), "session-a", "p", 0);
    s = applyBlockStopped(s, toBlockId("a"), 0);
    s = applyDecision(s, toBlockId("a"), { kind: "success", summary: "ok" }, 0);
    expect(s.status).toBe("running");
    expect(s.endedAtMs).toBeNull();
  });

  it("treats loop-done identically to success in v1", () => {
    let s = initialRunState(threeStep(), toRunId("r1"), 0);
    s = applyBlockSpawned(s, toBlockId("a"), "session-a", "p", 0);
    s = applyBlockStopped(s, toBlockId("a"), 0);
    s = applyDecision(s, toBlockId("a"), { kind: "loop-done", summary: "loop ended" }, 30);
    expect(s.blocks[0]!.status).toBe("done");
    expect(s.blocks[0]!.sessions[0]!.summary).toBe("loop ended");
  });

  it("pauses the run when the orchestrator returns needs-input", () => {
    let s = initialRunState(threeStep(), toRunId("r1"), 0);
    s = applyBlockSpawned(s, toBlockId("a"), "session-a", "p", 0);
    s = applyBlockStopped(s, toBlockId("a"), 0);
    s = applyDecision(
      s,
      toBlockId("a"),
      { kind: "needs-input", reason: "Claude asked a clarifying question" },
      0,
    );
    expect(s.blocks[0]!.status).toBe("stuck");
    expect(s.blocks[0]!.stuckReason).toBe("Claude asked a clarifying question");
    expect(s.status).toBe("paused-needs-input");
  });
});

describe("recovering from needs-input", () => {
  it("a stuck block stopping again moves it back to judging", () => {
    let s = initialRunState(threeStep(), toRunId("r1"), 0);
    s = applyBlockSpawned(s, toBlockId("a"), "session-a", "Plan", 0);
    s = applyBlockStopped(s, toBlockId("a"), 0);
    s = applyDecision(s, toBlockId("a"), { kind: "needs-input", reason: "?" }, 0);

    s = applyBlockStopped(s, toBlockId("a"), 0);
    expect(s.blocks[0]!.status).toBe("judging");
  });

  it("applyBlockResumed returns the run to running and clears the stuck reason", () => {
    let s = initialRunState(threeStep(), toRunId("r1"), 0);
    s = applyBlockSpawned(s, toBlockId("a"), "session-a", "p", 0);
    s = applyBlockStopped(s, toBlockId("a"), 0);
    s = applyDecision(s, toBlockId("a"), { kind: "needs-input", reason: "x" }, 0);
    expect(s.status).toBe("paused-needs-input");

    s = applyBlockResumed(s, toBlockId("a"), "new prompt", 0);
    expect(s.status).toBe("running");
    expect(s.blocks[0]!.status).toBe("running");
    expect(s.blocks[0]!.sessions[0]!.promptSent).toBe("new prompt");
    expect(s.blocks[0]!.stuckReason).toBeNull();
  });
});

describe("failure paths", () => {
  it("applyBlockCrashed marks the run AND the block failed with the reason", () => {
    let s = initialRunState(threeStep(), toRunId("r1"), 0);
    s = applyBlockSpawned(s, toBlockId("a"), "session-a", "p", 0);
    s = applyBlockCrashed(s, toBlockId("a"), "process exited 137", 99);
    expect(s.blocks[0]!.status).toBe("failed");
    expect(s.blocks[0]!.failureReason).toBe("process exited 137");
    expect(s.blocks[0]!.endedAtMs).toBe(99);
    expect(s.status).toBe("failed");
    expect(s.endedAtMs).toBe(99);
  });

  it("applyBlockCrashed closes every open session on the failed block", () => {
    let s = initialRunState(threeStep(), toRunId("r1"), 0);
    s = applyBlockSpawned(s, toBlockId("a"), "session-a", "p1", 0);
    s = applyBlockSpawned(s, toBlockId("a"), "session-b", "p2", 1);
    s = applyBlockCrashed(s, toBlockId("a"), "process exited 137", 99);
    expect(s.blocks[0]!.sessions.map((session) => session.endedAtMs)).toEqual([99, 99]);
  });

  it("applyInterrupted marks EVERY not-done block interrupted (in-flight and never-started), closing open sessions", () => {
    let s = initialRunState(threeStep(), toRunId("r1"), 0);
    s = applyBlockSpawned(s, toBlockId("a"), "session-a", "p", 0);
    s = applyInterrupted(s, 500);
    expect(s.status).toBe("interrupted");
    expect(s.endedAtMs).toBe(500);
    expect(s.blocks[0]!.status).toBe("interrupted");
    expect(s.blocks[0]!.endedAtMs).toBe(500);
    expect(s.blocks[0]!.sessions[0]!.endedAtMs).toBe(500);
    expect(s.blocks[1]!.status).toBe("interrupted");
    expect(s.blocks[1]!.endedAtMs).toBeNull();
    expect(s.blocks[2]!.status).toBe("interrupted");
    expect(s.blocks[2]!.endedAtMs).toBeNull();
  });

  it("applyInterrupted leaves already-finished blocks untouched", () => {
    let s = initialRunState(threeStep(), toRunId("r1"), 0);
    s = applyBlockSpawned(s, toBlockId("a"), "session-a", "p", 0);
    s = applyBlockStopped(s, toBlockId("a"), 0);
    s = applyDecision(s, toBlockId("a"), { kind: "success", summary: "ok" }, 20);
    s = applyInterrupted(s, 500);
    expect(s.blocks[0]!.status).toBe("done");
    expect(s.blocks[0]!.endedAtMs).toBe(20);
  });

  it("applyResumeInterrupted re-runs interrupted blocks (pending) and sets the run back to running, leaving done blocks alone", () => {
    let s = initialRunState(threeStep(), toRunId("r1"), 0);
    s = applyBlockSpawned(s, toBlockId("a"), "session-a", "p", 0);
    s = applyBlockStopped(s, toBlockId("a"), 0);
    s = applyDecision(s, toBlockId("a"), { kind: "success", summary: "ok" }, 20);
    s = applyBlockSpawned(s, toBlockId("b"), "session-b", "p", 30);
    s = applyInterrupted(s, 500);
    expect(s.blocks[1]!.status).toBe("interrupted");
    const r = applyResumeInterrupted(s);
    expect(r.status).toBe("running");
    expect(r.endedAtMs).toBeNull();
    expect(r.blocks[0]!.status).toBe("done");
    expect(r.blocks[1]!.status).toBe("pending");
    expect(r.blocks[2]!.status).toBe("pending");
    expect(nextPendingBlock(r)).toBe(toBlockId("b"));
  });

  it("applyResumeInterrupted keeps a worker block's session thread so the linear resume can continue it", () => {
    let s = initialRunState(threeStep(), toRunId("r1"), 0);
    s = applyBlockSpawned(s, toBlockId("a"), "session-a", "p", 0);
    s = applyInterrupted(s, 500);
    const r = applyResumeInterrupted(s);
    expect(r.blocks[0]!.sessions, "worker sessions survive resume for --resume continuity").toHaveLength(1);
  });

  it("applyResumeInterrupted clears stale sessions on pool blocks so a resumed pool does not show ghost iterations", () => {
    const p: Pipeline = {
      id: toPipelineId("p-pool"),
      name: "Pool",
      createdAtMs: 0,
      updatedAtMs: 0,
      blocks: [
        {
          id: toBlockId("pool"),
          kind: "pool",
          name: "Drain",
          listVar: "rows",
          itemVar: "item",
          concurrency: 2,
          prompt: "Process ${vars.item}",
          model: "default",
          effort: "medium",
          outputVar: "results",
        },
      ],
      triggers: [],
    };
    let s = initialRunState(p, toRunId("r2"), 0);
    s = applyBlockSpawned(s, toBlockId("pool"), "frozen-1", "p", 0);
    s = applyBlockSpawned(s, toBlockId("pool"), "frozen-2", "p", 0);
    s = applyPoolOrchestrator(s, toBlockId("pool"), "orch-old");
    s = applyInterrupted(s, 500);
    const r = applyResumeInterrupted(s);
    expect(r.blocks[0]!.status).toBe("pending");
    expect(r.blocks[0]!.sessions, "ghost sessions from the frozen attempt must not count as iterations").toHaveLength(0);
    expect(r.blocks[0]!.orchestratorSessionId).toBeNull();
  });
});

describe("end-to-end pipeline trace", () => {
  it("walks a three-step pipeline from start to completion using only public operations", () => {
    const p = threeStep();
    const runId = toRunId("r1");
    let s = initialRunState(p, runId, 0);

    expect(nextPendingBlock(s)).toBe(toBlockId("a"));
    s = applyBlockSpawned(s, toBlockId("a"), "sess-a", "Plan the refactor", 1);
    s = applyBlockStopped(s, toBlockId("a"), 0);
    s = applyDecision(s, toBlockId("a"), { kind: "success", summary: "Plan ready" }, 2);

    expect(nextPendingBlock(s)).toBe(toBlockId("b"));
    s = applyBlockSpawned(s, toBlockId("b"), "sess-b", "Apply the plan", 3);
    s = applyBlockStopped(s, toBlockId("b"), 0);
    s = applyDecision(s, toBlockId("b"), { kind: "success", summary: "Applied" }, 4);

    expect(nextPendingBlock(s)).toBe(toBlockId("c"));
    s = applyBlockSpawned(s, toBlockId("c"), "sess-c", "Verify the result", 5);
    s = applyBlockStopped(s, toBlockId("c"), 0);
    s = applyDecision(s, toBlockId("c"), { kind: "success", summary: "All good" }, 6);

    expect(s.status).toBe("completed");
    expect(s.blocks.map((b) => b.status)).toEqual(["done", "done", "done"]);
    expect(s.blocks.map((b) => b.sessions.at(-1)!.summary)).toEqual([
      "Plan ready",
      "Applied",
      "All good",
    ]);
  });
});
