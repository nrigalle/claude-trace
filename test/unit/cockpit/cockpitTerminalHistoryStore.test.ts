import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitTerminalHistoryStore } from "../../../src/features/cockpit/infra/CockpitTerminalHistoryStore";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-term-history-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("CockpitTerminalHistoryStore", () => {
  it("persists terminal output across store instances once flushed (flushAll runs on controller dispose)", () => {
    const first = new CockpitTerminalHistoryStore(dir);
    first.append("s1", "one\r\n");
    first.append("s1", "two\r\n");
    first.flushAll();
    const second = new CockpitTerminalHistoryStore(dir);
    expect([...second.read("s1")].join("")).toBe("one\r\ntwo\r\n");
  });

  it("append never touches the disk synchronously — output is buffered off the pty hot path", () => {
    const store = new CockpitTerminalHistoryStore(dir);
    store.append("s1", "streaming chunk");
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : [], "no disk write may happen during append").toHaveLength(0);
    expect([...store.read("s1")].join(""), "read flushes the pending buffer first").toBe("streaming chunk");
  });

  it("keeps sessions isolated", () => {
    const store = new CockpitTerminalHistoryStore(dir);
    store.append("s1", "one");
    store.append("s2", "two");
    store.append("s1", " three");
    expect([...store.read("s1")].join("")).toBe("one three");
    expect([...store.read("s2")].join("")).toBe("two");
  });

  it("trims old output to the bounded disk budget", () => {
    const store = new CockpitTerminalHistoryStore(dir, 10);
    store.append("s1", "abcdef");
    store.append("s1", "ghijkl");
    expect([...store.read("s1")].join("")).toBe("cdefghijkl");
  });

  it("removes closed session history", () => {
    const store = new CockpitTerminalHistoryStore(dir);
    store.append("s1", "old output");
    store.delete("s1");
    expect([...store.read("s1")]).toEqual([]);
  });

  it("trims at a UTF-8 boundary", () => {
    const store = new CockpitTerminalHistoryStore(dir, 8);
    store.append("s1", "alpha € beta");
    expect([...store.read("s1")].join("")).toBe("€ beta");
  });

  it("live streaming NEVER touches the disk — history lives in a bounded RAM ring while the session runs", () => {
    const store = new CockpitTerminalHistoryStore(dir, 1024);
    for (let i = 0; i < 5000; i++) {
      store.append("s1", `chunk-${i}\r\n`);
      store.append("s2", `other-${i}\r\n`);
    }
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : [], "no flush timer, no trim cycle, no disk IO").toHaveLength(0);
    expect([...store.read("s1")].join("").endsWith("chunk-4999\r\n")).toBe(true);
  });

  it("session exit persists the bounded ring once, atomically, and a fresh store (host restart) replays it", async () => {
    const store = new CockpitTerminalHistoryStore(dir, 10);
    store.append("s1", "0123456789abcdefgh");
    store.persistSession("s1");
    await vi.waitFor(() => {
      expect(fs.readdirSync(dir).filter((f) => f.endsWith(".log"))).toHaveLength(1);
    }, { timeout: 2000 });
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), "atomic write leaves no tmp file").toHaveLength(0);
    const file = path.join(dir, fs.readdirSync(dir)[0]!);
    expect(fs.statSync(file).size, "the file is written already bounded to the budget").toBeLessThanOrEqual(10);
    const restarted = new CockpitTerminalHistoryStore(dir, 10);
    expect([...restarted.read("s1")].join("")).toBe("89abcdefgh");
  });

  it("replay prefers the live RAM ring over a stale file", () => {
    const store = new CockpitTerminalHistoryStore(dir, 1024);
    store.append("s1", "old");
    store.flushAll();
    store.append("s1", " new");
    expect([...store.read("s1")].join(""), "same host: the ring is authoritative").toBe("old new");
    const restarted = new CockpitTerminalHistoryStore(dir, 1024);
    expect([...restarted.read("s1")].join(""), "after a host restart only the file remains").toBe("old");
  });

  it("flushAll persists every session's ring (dispose edge: window reload / deactivate)", () => {
    const store = new CockpitTerminalHistoryStore(dir, 1024);
    store.append("s1", "one");
    store.append("s2", "two");
    store.flushAll();
    const restarted = new CockpitTerminalHistoryStore(dir, 1024);
    expect([...restarted.read("s1")].join("")).toBe("one");
    expect([...restarted.read("s2")].join("")).toBe("two");
  });

  it("class guardrail: streaming 20MB through the hot path stays in RAM and completes fast", () => {
    const store = new CockpitTerminalHistoryStore(dir, 64 * 1024);
    const chunk = "x".repeat(1024);
    const startedAt = performance.now();
    for (let i = 0; i < 20_000; i++) store.append("s1", chunk);
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs, "any per-append disk IO or O(n^2) buffering blows this bound by 10-100x").toBeLessThan(2000);
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : [], "the hot path never touches the disk").toHaveLength(0);
    expect([...store.read("s1")].join("").length).toBe(64 * 1024);
  });
});
