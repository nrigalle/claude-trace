import { beforeEach, describe, expect, it } from "vitest";
import { SessionNameStore } from "../../src/infra/vscode/SessionNameStore";
import { toSessionId } from "../../src/domain/types";

interface MockMemento {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
  keys(): readonly string[];
  setKeysForSync?(keys: readonly string[]): void;
}

const makeMemento = (): MockMemento => {
  const data = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return (data.has(key) ? (data.get(key) as T) : defaultValue);
    },
    update(key: string, value: unknown): Thenable<void> {
      data.set(key, value);
      return Promise.resolve();
    },
    keys(): readonly string[] { return [...data.keys()]; },
  };
};

describe("SessionNameStore", () => {
  let memento: MockMemento;
  let store: SessionNameStore;

  beforeEach(() => {
    memento = makeMemento();
    store = new SessionNameStore(memento as unknown as Parameters<typeof SessionNameStore.prototype.constructor>[0]);
  });

  it("get returns null when no name was ever set", () => {
    expect(store.get(toSessionId("never-set"))).toBeNull();
  });

  it("set then get round-trips a name", async () => {
    await store.set(toSessionId("a"), "My custom name");
    expect(store.get(toSessionId("a"))).toBe("My custom name");
  });

  it("setting null removes the override", async () => {
    await store.set(toSessionId("a"), "Initial");
    await store.set(toSessionId("a"), null);
    expect(store.get(toSessionId("a"))).toBeNull();
  });

  it("setting empty string removes the override", async () => {
    await store.set(toSessionId("a"), "Initial");
    await store.set(toSessionId("a"), "");
    expect(store.get(toSessionId("a"))).toBeNull();
  });

  it("isolates names across session ids", async () => {
    await store.set(toSessionId("a"), "Alpha");
    await store.set(toSessionId("b"), "Beta");
    expect(store.get(toSessionId("a"))).toBe("Alpha");
    expect(store.get(toSessionId("b"))).toBe("Beta");
  });

  it("overwriting replaces the previous value", async () => {
    await store.set(toSessionId("a"), "First");
    await store.set(toSessionId("a"), "Second");
    expect(store.get(toSessionId("a"))).toBe("Second");
  });
});
