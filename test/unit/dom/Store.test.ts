import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface MockApi {
  postMessage(m: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
  _state: unknown;
}

const installVsCodeStub = (initial?: unknown): MockApi => {
  const api: MockApi = {
    _state: initial,
    postMessage() {},
    setState(s) { this._state = s; },
    getState() { return this._state; },
  };
  (globalThis as unknown as { acquireVsCodeApi: () => MockApi }).acquireVsCodeApi = () => api;
  return api;
};

const cleanupVsCodeStub = (): void => {
  delete (globalThis as unknown as { acquireVsCodeApi?: () => MockApi }).acquireVsCodeApi;
};

const loadStore = async (): Promise<typeof import("../../../media/src/state/Store").Store> => {
  const mod = await import("../../../media/src/state/Store?ts=" + Date.now());
  return mod.Store;
};

describe("Store active tab persistence", () => {
  beforeEach(() => installVsCodeStub());
  afterEach(() => cleanupVsCodeStub());

  it("defaults the active tab to sessions", async () => {
    const Store = await loadStore();
    expect(new Store().state.activeTab).toBe("sessions");
  });

  it("restores a persisted active tab so a rebuilt webview lands on the same tab", async () => {
    installVsCodeStub({ activeTab: "pipelines" });
    const Store = await loadStore();
    expect(new Store().state.activeTab).toBe("pipelines");
  });

  it("falls back to sessions when the persisted active tab is invalid", async () => {
    installVsCodeStub({ activeTab: "garbage" });
    const Store = await loadStore();
    expect(new Store().state.activeTab).toBe("sessions");
  });

  it("flush persists the current state synchronously before the debounce fires", async () => {
    const api = installVsCodeStub();
    const Store = await loadStore();
    const store = new Store();
    store.update({ activeTab: "library" });
    expect(api._state).toBeUndefined();
    store.flush();
    expect((api._state as { activeTab?: string }).activeTab).toBe("library");
  });
});
