import { describe, expect, it } from "vitest";
import { PendingNameStore } from "../../src/app/PendingNameStore";

describe("PendingNameStore", () => {
  it("returns null when no claim has been set", () => {
    const store = new PendingNameStore();
    expect(store.take()).toBeNull();
  });

  it("returns the claimed name on take, then clears the slot", () => {
    const store = new PendingNameStore();
    store.set("Refactor auth", 60_000);
    expect(store.take()).toBe("Refactor auth");
    expect(store.take()).toBeNull();
  });

  it("expires claims after the TTL", () => {
    let now = 1_000;
    const store = new PendingNameStore(() => now);
    store.set("Stale name", 5_000);
    now = 6_001;
    expect(store.take()).toBeNull();
  });

  it("treats setting a new claim as overwriting any prior claim", () => {
    const store = new PendingNameStore();
    store.set("first", 60_000);
    store.set("second", 60_000);
    expect(store.take()).toBe("second");
  });

  it("clear discards any active claim", () => {
    const store = new PendingNameStore();
    store.set("anything", 60_000);
    store.clear();
    expect(store.take()).toBeNull();
  });

  it("isPending reports false after expiry", () => {
    let now = 0;
    const store = new PendingNameStore(() => now);
    store.set("x", 1_000);
    expect(store.isPending()).toBe(true);
    now = 1_001;
    expect(store.isPending()).toBe(false);
  });
});
