import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssistantSessionStore } from "../../../src/features/pipelines/infra/AssistantSessionStore";
import { toPipelineId } from "../../../src/features/pipelines/domain/types";

const pid = toPipelineId("wf-1");
const other = toPipelineId("wf-2");

describe("AssistantSessionStore — many conversations per workflow", () => {
  let dir: string;
  let store: AssistantSessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "asst-sessions-"));
    store = new AssistantSessionStore(path.join(dir, "sessions.json"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const conv = (id: string, updatedAtMs: number) => ({
    id,
    sessionId: `sess-${id}`,
    cwd: "/repo",
    title: `Chat ${id}`,
    createdAtMs: 1,
    updatedAtMs,
  });

  it("keeps multiple conversations for one workflow, newest first", () => {
    store.upsert(pid, conv("a", 100));
    store.upsert(pid, conv("b", 300));
    store.upsert(pid, conv("c", 200));
    const list = store.list(pid);
    expect(list.map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  it("upsert updates an existing conversation in place (no duplicates)", () => {
    store.upsert(pid, conv("a", 100));
    store.upsert(pid, { ...conv("a", 500), title: "Renamed" });
    const list = store.list(pid);
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe("Renamed");
    expect(list[0]!.updatedAtMs).toBe(500);
  });

  it("rename changes only the title and keeps order (updatedAtMs untouched)", () => {
    store.upsert(pid, conv("a", 100));
    store.upsert(pid, conv("b", 300));
    store.rename(pid, "a", "My cleanup chat");
    const a = store.get(pid, "a")!;
    expect(a.title).toBe("My cleanup chat");
    expect(a.updatedAtMs).toBe(100);
    // order unchanged: b (300) still before a (100)
    expect(store.list(pid).map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("rename of a missing conversation is a no-op", () => {
    store.upsert(pid, conv("a", 100));
    store.rename(pid, "missing", "x");
    expect(store.list(pid)).toHaveLength(1);
  });

  it("get returns a specific conversation or null", () => {
    store.upsert(pid, conv("a", 100));
    expect(store.get(pid, "a")?.sessionId).toBe("sess-a");
    expect(store.get(pid, "missing")).toBeNull();
  });

  it("delete removes only the named conversation and isolates workflows", () => {
    store.upsert(pid, conv("a", 100));
    store.upsert(pid, conv("b", 200));
    store.upsert(other, conv("z", 100));
    store.delete(pid, "a");
    expect(store.list(pid).map((c) => c.id)).toEqual(["b"]);
    expect(store.list(other).map((c) => c.id)).toEqual(["z"]);
  });

  it("persists across instances (survives reload)", () => {
    store.upsert(pid, conv("a", 100));
    const reopened = new AssistantSessionStore(path.join(dir, "sessions.json"));
    expect(reopened.list(pid).map((c) => c.id)).toEqual(["a"]);
  });

  it("returns empty for an unknown workflow", () => {
    expect(store.list(toPipelineId("nope"))).toEqual([]);
  });
});
