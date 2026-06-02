import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CockpitTerminalHistoryStore } from "../../../src/features/cockpit/infra/CockpitTerminalHistoryStore";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-term-history-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("CockpitTerminalHistoryStore", () => {
  it("persists terminal output across store instances", () => {
    const first = new CockpitTerminalHistoryStore(dir);
    first.append("s1", "one\r\n");
    first.append("s1", "two\r\n");
    const second = new CockpitTerminalHistoryStore(dir);
    expect([...second.read("s1")].join("")).toBe("one\r\ntwo\r\n");
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
});
