import { describe, expect, it, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECTS_DIR, SESSION_CACHE_LRU_LIMIT } from "../../../src/shared/config";
import { SessionFileReader } from "../../../src/features/dashboard/infra/SessionFileReader";
import { toSessionId, type SessionId } from "../../../src/features/dashboard/domain/types";
import type { SessionRef } from "../../../src/features/dashboard/infra/paths";

const newSessionId = (): SessionId =>
  toSessionId(`test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

const makeRef = (id: SessionId, subdir = "-tmp-test-project"): SessionRef => {
  const projectDir = path.join(PROJECTS_DIR, subdir);
  fs.mkdirSync(projectDir, { recursive: true });
  return { sessionId: id, projectDirName: subdir, filePath: path.join(projectDir, `${id}.jsonl`) };
};

const assistantLine = (toolName: string, ts = "2026-05-01T10:00:00Z") =>
  JSON.stringify({
    type: "assistant",
    timestamp: ts,
    cwd: "/p",
    sessionId: "s",
    message: {
      model: "claude-opus-4-7",
      content: [{ type: "tool_use", id: "t", name: toolName, input: { command: "ls" } }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });

const aiTitleLine = (title: string) =>
  JSON.stringify({ type: "ai-title", aiTitle: title, sessionId: "s" });

describe("SessionFileReader — basic semantics", () => {
  let reader: SessionFileReader;
  beforeEach(() => { reader = new SessionFileReader(); });

  it("returns empty events when file missing", () => {
    const id = newSessionId();
    const ref = makeRef(id);
    expect(reader.statSafe(ref)).toBeNull();
  });

  it("reads a fresh transcript producing one PostToolUse per tool_use", () => {
    const id = newSessionId();
    const ref = makeRef(id);
    fs.writeFileSync(ref.filePath, assistantLine("Bash") + "\n" + assistantLine("Read") + "\n");
    const stats = reader.statSafe(ref)!;
    const events = reader.read(ref, stats);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.tool_name)).toEqual(["Bash", "Read"]);
  });
});

describe("SessionFileReader — cache identity guarantees", () => {
  let reader: SessionFileReader;
  beforeEach(() => { reader = new SessionFileReader(); });

  it("cache-hit returns same array reference", () => {
    const id = newSessionId();
    const ref = makeRef(id);
    fs.writeFileSync(ref.filePath, assistantLine("Bash") + "\n");
    const stats = reader.statSafe(ref)!;
    const a = reader.read(ref, stats);
    for (let i = 0; i < 50; i++) expect(reader.read(ref, stats)).toBe(a);
  });

  it("tail-read mutates cache in place — same array reference grows", () => {
    const id = newSessionId();
    const ref = makeRef(id);
    fs.writeFileSync(ref.filePath, assistantLine("Bash") + "\n");
    const s1 = reader.statSafe(ref)!;
    const arr = reader.read(ref, s1);
    fs.appendFileSync(ref.filePath, assistantLine("Read") + "\n");
    const s2 = reader.statSafe(ref)!;
    const after = reader.read(ref, s2);
    expect(after).toBe(arr);
    expect(after.map((e) => e.tool_name)).toEqual(["Bash", "Read"]);
  });

  it("invalidate forces a fresh array reference on next read", () => {
    const id = newSessionId();
    const ref = makeRef(id);
    fs.writeFileSync(ref.filePath, assistantLine("Bash") + "\n");
    const stats = reader.statSafe(ref)!;
    const a = reader.read(ref, stats);
    reader.invalidate(id);
    const b = reader.read(ref, stats);
    expect(b).not.toBe(a);
    expect(b.map((e) => e.tool_name)).toEqual(a.map((e) => e.tool_name));
  });
});

describe("SessionFileReader — partial-line buffer", () => {
  let reader: SessionFileReader;
  beforeEach(() => { reader = new SessionFileReader(); });

  it("does not emit events for mid-line writes; emits once the newline arrives", () => {
    const id = newSessionId();
    const ref = makeRef(id);
    const full = assistantLine("Bash");
    fs.writeFileSync(ref.filePath, full.slice(0, 20));
    let stats = reader.statSafe(ref)!;
    expect(reader.read(ref, stats)).toHaveLength(0);

    fs.appendFileSync(ref.filePath, full.slice(20) + "\n");
    stats = reader.statSafe(ref)!;
    const events = reader.read(ref, stats);
    expect(events).toHaveLength(1);
    expect(events[0]!.tool_name).toBe("Bash");
  });

  it("survives many partial chunks across one logical line", () => {
    const id = newSessionId();
    const ref = makeRef(id);
    const full = assistantLine("Read");
    fs.writeFileSync(ref.filePath, "");
    let cursor = 0;
    const chunkSize = 7;
    while (cursor < full.length) {
      const next = Math.min(cursor + chunkSize, full.length);
      fs.appendFileSync(ref.filePath, full.slice(cursor, next));
      const stats = reader.statSafe(ref)!;
      reader.read(ref, stats);
      cursor = next;
    }
    fs.appendFileSync(ref.filePath, "\n");
    const stats = reader.statSafe(ref)!;
    const events = reader.read(ref, stats);
    expect(events).toHaveLength(1);
    expect(events[0]!.tool_name).toBe("Read");
  });
});

describe("SessionFileReader — file shrink/truncate", () => {
  let reader: SessionFileReader;
  beforeEach(() => { reader = new SessionFileReader(); });

  it("when the file shrinks (size < cached.size), a full re-read happens", () => {
    const id = newSessionId();
    const ref = makeRef(id);
    fs.writeFileSync(ref.filePath, assistantLine("Bash") + "\n" + assistantLine("Read") + "\n");
    const s1 = reader.statSafe(ref)!;
    const a = reader.read(ref, s1);
    expect(a).toHaveLength(2);

    fs.writeFileSync(ref.filePath, assistantLine("Edit") + "\n");
    const s2 = reader.statSafe(ref)!;
    const b = reader.read(ref, s2);
    expect(b).not.toBe(a);
    expect(b).toHaveLength(1);
    expect(b[0]!.tool_name).toBe("Edit");
  });
});

describe("SessionFileReader — title extraction", () => {
  let reader: SessionFileReader;
  beforeEach(() => { reader = new SessionFileReader(); });

  it("getTitle returns aiTitle once seen", () => {
    const id = newSessionId();
    const ref = makeRef(id);
    fs.writeFileSync(ref.filePath, aiTitleLine("Plan migration") + "\n" + assistantLine("Bash") + "\n");
    const stats = reader.statSafe(ref)!;
    reader.read(ref, stats);
    expect(reader.getTitle(id)).toBe("Plan migration");
  });

  it("getTitle returns null before the file is read", () => {
    expect(reader.getTitle(toSessionId("never-read"))).toBeNull();
  });

  it("late ai-title (after tool_use) is captured on tail-read", () => {
    const id = newSessionId();
    const ref = makeRef(id);
    fs.writeFileSync(ref.filePath, assistantLine("Bash") + "\n");
    let stats = reader.statSafe(ref)!;
    reader.read(ref, stats);
    expect(reader.getTitle(id)).toBeNull();

    fs.appendFileSync(ref.filePath, aiTitleLine("Late title") + "\n");
    stats = reader.statSafe(ref)!;
    reader.read(ref, stats);
    expect(reader.getTitle(id)).toBe("Late title");
  });
});

describe("SessionFileReader — LRU eviction", () => {
  let reader: SessionFileReader;
  beforeEach(() => { reader = new SessionFileReader(); });

  it("oldest entries are evicted once cache exceeds the LRU limit", () => {
    const refs: SessionRef[] = [];
    for (let i = 0; i < SESSION_CACHE_LRU_LIMIT + 5; i++) {
      const id = toSessionId(`lru-${i}-${Date.now()}`);
      const ref = makeRef(id);
      fs.writeFileSync(ref.filePath, assistantLine("Bash", `2026-05-01T10:00:${String(i % 60).padStart(2, "0")}Z`) + "\n");
      const stats = reader.statSafe(ref)!;
      reader.read(ref, stats);
      refs.push(ref);
    }
    const oldestId = refs[0]!.sessionId;
    expect(reader.getTitle(oldestId)).toBeNull();

    const newestId = refs[refs.length - 1]!.sessionId;
    expect(reader.statSafe(refs[refs.length - 1]!)).not.toBeNull();
    const fresh = reader.read(refs[refs.length - 1]!, reader.statSafe(refs[refs.length - 1]!)!);
    expect(fresh.length).toBe(1);
    void newestId;
  });
});

describe("SessionFileReader — multi-session isolation", () => {
  let reader: SessionFileReader;
  beforeEach(() => { reader = new SessionFileReader(); });

  it("two sessions in the same project dir have independent caches", () => {
    const ref1 = makeRef(toSessionId(`iso-a-${Date.now()}`));
    const ref2 = makeRef(toSessionId(`iso-b-${Date.now()}`));
    fs.writeFileSync(ref1.filePath, assistantLine("Bash") + "\n");
    fs.writeFileSync(ref2.filePath, assistantLine("Read") + "\n");
    const a = reader.read(ref1, reader.statSafe(ref1)!);
    const b = reader.read(ref2, reader.statSafe(ref2)!);
    expect(a).not.toBe(b);
    expect(a[0]!.tool_name).toBe("Bash");
    expect(b[0]!.tool_name).toBe("Read");
  });
});

describe("SessionFileReader — memory discipline (slim by default, materialize only for detail)", () => {
  let reader: SessionFileReader;
  beforeEach(() => { reader = new SessionFileReader(); });

  const writeToolEdit = (ref: SessionRef, lines: string[]): void => {
    fs.writeFileSync(ref.filePath, lines.map((l) => l + "\n").join(""));
  };
  const editLine = (file: string) =>
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-05-01T10:00:00Z",
      cwd: "/p",
      sessionId: "s",
      message: {
        model: "claude-opus-4-7",
        content: [{ type: "tool_use", id: "t", name: "Write", input: { file_path: file, content: "x".repeat(500) } }],
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });

  it("readDelta returns all events with reset=true on first read, then only the appended ones", () => {
    const id = newSessionId();
    const ref = makeRef(id);
    writeToolEdit(ref, [assistantLine("Bash")]);
    const first = reader.readDelta(ref, reader.statSafe(ref)!);
    expect(first.reset).toBe(true);
    expect(first.events.length).toBeGreaterThan(0);

    fs.appendFileSync(ref.filePath, assistantLine("Read") + "\n");
    const second = reader.readDelta(ref, reader.statSafe(ref)!);
    expect(second.reset).toBe(false);
    expect(second.events.length).toBeLessThan(first.events.length + second.events.length);
    expect(second.events.some((e) => e.tool_name === "Read")).toBe(true);
    expect(second.events.some((e) => e.tool_name === "Bash")).toBe(false);
  });

  it("readDelta with mustReset replays the full history so a lost fold accumulator can rebuild", () => {
    const id = newSessionId();
    const ref = makeRef(id);
    writeToolEdit(ref, [assistantLine("Bash")]);
    reader.readDelta(ref, reader.statSafe(ref)!);
    fs.appendFileSync(ref.filePath, assistantLine("Read") + "\n");
    const replay = reader.readDelta(ref, reader.statSafe(ref)!, true);
    expect(replay.reset).toBe(true);
    expect(replay.events.some((e) => e.tool_name === "Bash")).toBe(true);
    expect(replay.events.some((e) => e.tool_name === "Read")).toBe(true);
  });

  it("readDelta never retains file-edit contents in memory; read() materializes them for the detail view", () => {
    const id = newSessionId();
    const ref = makeRef(id);
    writeToolEdit(ref, [editLine("/p/big.ts")]);
    reader.readDelta(ref, reader.statSafe(ref)!);
    expect(reader.getFileEdits(id)).toEqual([]);

    reader.read(ref, reader.statSafe(ref)!);
    expect(reader.getFileEdits(id).length).toBe(1);
  });

  it("caps fully-materialized sessions at 3, demoting the oldest back to slim (regression: 32 parsed transcripts pinned ~1GB of heap)", () => {
    const ids: SessionId[] = [];
    for (let i = 0; i < 5; i++) {
      const id = newSessionId();
      const ref = makeRef(id);
      writeToolEdit(ref, [editLine(`/p/f${i}.ts`)]);
      reader.read(ref, reader.statSafe(ref)!);
      ids.push(id);
    }
    const retained = ids.filter((id) => reader.getFileEdits(id).length > 0);
    expect(retained.length).toBe(3);
    expect(retained).toEqual(ids.slice(2));
  });

  it("a session demoted to slim still serves correct incremental deltas afterwards", () => {
    const id = newSessionId();
    const ref = makeRef(id);
    writeToolEdit(ref, [assistantLine("Bash")]);
    reader.read(ref, reader.statSafe(ref)!);
    for (let i = 0; i < 4; i++) {
      const other = makeRef(newSessionId());
      writeToolEdit(other, [assistantLine("Bash")]);
      reader.read(other, reader.statSafe(other)!);
    }
    fs.appendFileSync(ref.filePath, assistantLine("Read") + "\n");
    const delta = reader.readDelta(ref, reader.statSafe(ref)!);
    expect(delta.reset).toBe(false);
    expect(delta.events.some((e) => e.tool_name === "Read")).toBe(true);
  });
});
