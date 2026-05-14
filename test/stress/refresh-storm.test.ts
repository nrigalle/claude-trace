import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECTS_DIR } from "../../src/config";
import { SessionFileReader } from "../../src/infra/fs/SessionFileReader";
import { RefreshScheduler } from "../../src/app/RefreshScheduler";
import { toSessionId } from "../../src/domain/types";
import type { SessionRef } from "../../src/infra/fs/paths";

const makeRef = (id: string): SessionRef => {
  const projectDirName = "-stress-test";
  const projectDir = path.join(PROJECTS_DIR, projectDirName);
  fs.mkdirSync(projectDir, { recursive: true });
  return {
    sessionId: toSessionId(id),
    projectDirName,
    filePath: path.join(projectDir, `${id}.jsonl`),
  };
};

const assistantLine = (ts: string, n: number) =>
  JSON.stringify({
    type: "assistant",
    timestamp: ts,
    sessionId: "s",
    message: {
      model: "claude-opus-4-7",
      content: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: { n } }],
      usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }) + "\n";

describe("refresh storm — smoothness regression suite", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("100 events/sec for 30s produces at most 30 flushes", async () => {
    const flush = vi.fn();
    const sch = new RefreshScheduler({ isVisible: () => true, flush });
    for (let t = 0; t < 30_000; t += 10) {
      sch.schedule();
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(400);
    expect(flush.mock.calls.length).toBeLessThanOrEqual(30);
    expect(flush.mock.calls.length).toBeGreaterThanOrEqual(15);
  });

  it("tail-read mutates cache in place — same array reference grows across appends", () => {
    const id = `stress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ref = makeRef(id);
    fs.writeFileSync(ref.filePath, "");

    const reader = new SessionFileReader();
    fs.appendFileSync(ref.filePath, assistantLine("2026-05-01T10:00:00Z", 1) + assistantLine("2026-05-01T10:00:01Z", 2));
    const s1 = reader.statSafe(ref)!;
    const arrRef = reader.read(ref, s1);
    expect(arrRef).toHaveLength(2);

    let counter = 3;
    for (let i = 0; i < 30; i++) {
      let chunk = "";
      while (chunk.length < 1024) {
        chunk += assistantLine(`2026-05-01T10:00:${String(counter % 60).padStart(2, "0")}Z`, counter++);
      }
      fs.appendFileSync(ref.filePath, chunk);
      const s = reader.statSafe(ref)!;
      const events = reader.read(ref, s);
      expect(events).toBe(arrRef);
    }
    expect(arrRef.length).toBeGreaterThan(30);
  });

  it("re-reading unchanged transcript returns same reference (cache hit)", () => {
    const id = `cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ref = makeRef(id);
    fs.writeFileSync(ref.filePath, assistantLine("2026-05-01T10:00:00Z", 1));

    const reader = new SessionFileReader();
    const stats = reader.statSafe(ref)!;
    const first = reader.read(ref, stats);
    for (let i = 0; i < 100; i++) {
      expect(reader.read(ref, stats)).toBe(first);
    }
  });
});
