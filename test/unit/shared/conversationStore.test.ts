import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ConversationStore, type StoredConversation } from "../../../src/shared/infra/assistant/conversationStore";

let dir: string;
let store: ConversationStore;

const conv = (id: string, over: Partial<StoredConversation> = {}): StoredConversation => ({
  id,
  sessionId: `s-${id}`,
  cwd: "/repo",
  title: `Chat ${id}`,
  createdAtMs: 1000,
  updatedAtMs: 1000,
  ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-store-"));
  store = new ConversationStore(path.join(dir, "sessions.json"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ConversationStore — string-keyed, shared by both assistants", () => {
  it("keeps conversations independent across keys", () => {
    store.upsert("skill:a", conv("c1"));
    store.upsert("agent:b", conv("c2"));
    expect(store.list("skill:a").map((c) => c.id)).toEqual(["c1"]);
    expect(store.list("agent:b").map((c) => c.id)).toEqual(["c2"]);
  });

  it("lists newest-updated first", () => {
    store.upsert("k", conv("old", { updatedAtMs: 10 }));
    store.upsert("k", conv("new", { updatedAtMs: 99 }));
    expect(store.list("k").map((c) => c.id)).toEqual(["new", "old"]);
  });

  it("upsert replaces an existing conversation by id", () => {
    store.upsert("k", conv("c1", { title: "first" }));
    store.upsert("k", conv("c1", { title: "second" }));
    expect(store.list("k")).toHaveLength(1);
    expect(store.get("k", "c1")?.title).toBe("second");
  });

  it("rename changes the title but preserves the rest", () => {
    store.upsert("k", conv("c1", { sessionId: "keep-me" }));
    store.rename("k", "c1", "Renamed");
    expect(store.get("k", "c1")?.title).toBe("Renamed");
    expect(store.get("k", "c1")?.sessionId).toBe("keep-me");
  });

  it("delete removes one conversation and drops the key when empty", () => {
    store.upsert("k", conv("c1"));
    store.delete("k", "c1");
    expect(store.list("k")).toEqual([]);
  });

  it("persists across instances", () => {
    store.upsert("k", conv("c1"));
    const reopened = new ConversationStore(path.join(dir, "sessions.json"));
    expect(reopened.get("k", "c1")?.id).toBe("c1");
  });

  it("persists an optional per-chat mode and round-trips it (library discuss/writeBody)", () => {
    store.upsert("k", conv("c1", { mode: "discuss" }));
    expect(store.get("k", "c1")?.mode).toBe("discuss");
    const reopened = new ConversationStore(path.join(dir, "sessions.json"));
    expect(reopened.get("k", "c1")?.mode).toBe("discuss");
  });

  it("move re-keys all conversations from the old key to the new one (rename)", () => {
    store.upsert("skill:old", conv("c1"));
    store.upsert("skill:old", conv("c2"));
    store.move("skill:old", "skill:new");
    expect(store.list("skill:old")).toEqual([]);
    expect(store.list("skill:new").map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  it("drops malformed rows at the parsing boundary instead of leaking undefined fields into the UI", () => {
    const file = path.join(dir, "sessions.json");
    fs.writeFileSync(file, JSON.stringify({
      k: [
        conv("good", { updatedAtMs: 20 }),
        { id: "bad-missing-session", title: "Broken", updatedAtMs: 30 },
        "not an object",
        conv("also-good", { updatedAtMs: 10, mode: "writeBody" }),
      ],
    }), "utf8");
    const reopened = new ConversationStore(file);
    expect(reopened.list("k").map((c) => c.id)).toEqual(["good", "also-good"]);
  });

  it("caps a moved key to the 50 newest rows and de-duplicates ids already present on the destination", () => {
    for (let i = 0; i < 55; i += 1) {
      store.upsert("old", conv(`old-${i}`, { updatedAtMs: i }));
    }
    store.upsert("new", conv("old-54", { title: "stale duplicate", updatedAtMs: 1 }));
    store.upsert("new", conv("keep-new", { updatedAtMs: 1000 }));
    store.move("old", "new");
    const rows = store.list("new");
    expect(rows).toHaveLength(50);
    expect(rows[0]!.id).toBe("keep-new");
    expect(rows.filter((c) => c.id === "old-54")).toHaveLength(1);
    expect(rows.some((c) => c.id === "old-0")).toBe(false);
  });

  it("dropKey removes every conversation for a key (delete, so a recreate can't inherit them)", () => {
    store.upsert("k", conv("c1"));
    store.upsert("k", conv("c2"));
    store.dropKey("k");
    expect(store.list("k")).toEqual([]);
    const reopened = new ConversationStore(path.join(dir, "sessions.json"));
    expect(reopened.list("k")).toEqual([]);
  });
});
