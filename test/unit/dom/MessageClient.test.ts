import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostToWebview, WebviewToHost } from "../../../src/protocol";
import { toSessionId, type SessionId } from "../../../src/domain/types";

interface MockApi {
  postMessage(m: WebviewToHost): void;
  setState(state: unknown): void;
  getState(): unknown;
  _posted: WebviewToHost[];
  _state: unknown;
}

const installVsCodeStub = (): MockApi => {
  const api: MockApi = {
    _posted: [],
    _state: undefined,
    postMessage(m) { this._posted.push(m); },
    setState(s) { this._state = s; },
    getState() { return this._state; },
  };
  (globalThis as unknown as { acquireVsCodeApi: () => MockApi }).acquireVsCodeApi = () => api;
  return api;
};

const cleanupVsCodeStub = (): void => {
  delete (globalThis as unknown as { acquireVsCodeApi?: () => MockApi }).acquireVsCodeApi;
};

const loadFreshModules = async (): Promise<{
  Store: typeof import("../../../media/src/state/Store").Store;
  MessageClient: typeof import("../../../media/src/messaging/client").MessageClient;
}> => {
  const storeMod = await import("../../../media/src/state/Store?ts=" + Date.now());
  const clientMod = await import("../../../media/src/messaging/client?ts=" + Date.now());
  return { Store: storeMod.Store, MessageClient: clientMod.MessageClient };
};

const mkSummary = (id: string) => ({
  session_id: toSessionId(id),
  title: null,
  event_count: 0,
  tool_count: 0,
  tools: [] as string[],
  duration_ms: 0,
  started_at: null,
  ended_at: null,
  cwd: null,
  cost: null,
  context_window: null,
  model: null,
  last_modified_ms: 0,
});

const mkDetail = (id: string) => ({
  ...mkSummary(id),
  events: [],
  tool_stats: [],
  context_timeline: [],
  cost_timeline: [],
});

const update = (
  sessions: string[],
  changed: string[] = [],
  removed: string[] = [],
): HostToWebview => ({
  type: "update",
  sessions: sessions.map(mkSummary),
  stats: { total_sessions: sessions.length, total_tool_calls: 0, total_duration_ms: 0, total_cost_usd: 0 },
  changedIds: changed.map((s) => toSessionId(s)),
  removedIds: removed.map((s) => toSessionId(s)),
});

const detail = (id: string): HostToWebview => ({
  type: "sessionDetail",
  sessionId: toSessionId(id),
  detail: mkDetail(id),
});

const flushRaf = async (): Promise<void> => {
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
};

describe("MessageClient — coalesce semantics", () => {
  beforeEach(() => installVsCodeStub());
  afterEach(() => cleanupVsCodeStub());

  it("batches multiple updates within one rAF into a single update message", async () => {
    const { Store, MessageClient } = await loadFreshModules();
    const client = new MessageClient(new Store());
    const seen: HostToWebview[] = [];
    client.onUpdate((m) => seen.push(m));

    window.dispatchEvent(new MessageEvent("message", { data: update(["a", "b"], ["a"], []) }));
    window.dispatchEvent(new MessageEvent("message", { data: update(["a", "b", "c"], ["c"], []) }));
    window.dispatchEvent(new MessageEvent("message", { data: update(["a", "c"], ["b"], ["b"]) }));

    await flushRaf();

    expect(seen).toHaveLength(1);
    const merged = seen[0]! as Extract<HostToWebview, { type: "update" }>;
    expect(merged.sessions.map((s) => s.session_id).sort()).toEqual(["a", "c"]);
    expect(new Set(merged.changedIds)).toEqual(new Set([toSessionId("a"), toSessionId("c"), toSessionId("b")]));
    expect(new Set(merged.removedIds)).toEqual(new Set([toSessionId("b")]));
  });

  it("drops sessionDetail for sessions absent from the coalesced update (P0 regression)", async () => {
    const { Store, MessageClient } = await loadFreshModules();
    const client = new MessageClient(new Store());
    const seen: HostToWebview[] = [];
    client.onUpdate((m) => seen.push(m));

    window.dispatchEvent(new MessageEvent("message", { data: detail("ghost") }));
    window.dispatchEvent(new MessageEvent("message", { data: update(["alive"], [], ["ghost"]) }));
    await flushRaf();

    expect(seen.filter((m) => m.type === "sessionDetail")).toHaveLength(0);
    expect(seen.filter((m) => m.type === "update")).toHaveLength(1);
  });

  it("keeps the LATEST sessionDetail per session_id across a batch", async () => {
    const { Store, MessageClient } = await loadFreshModules();
    const client = new MessageClient(new Store());
    const seen: HostToWebview[] = [];
    client.onUpdate((m) => seen.push(m));

    const first = detail("a") as Extract<HostToWebview, { type: "sessionDetail" }>;
    const second: Extract<HostToWebview, { type: "sessionDetail" }> = {
      ...first,
      detail: { ...first.detail, tool_count: 99 },
    };

    window.dispatchEvent(new MessageEvent("message", { data: first }));
    window.dispatchEvent(new MessageEvent("message", { data: second }));
    window.dispatchEvent(new MessageEvent("message", { data: update(["a"]) }));
    await flushRaf();

    const detailMsgs = seen.filter(
      (m): m is Extract<HostToWebview, { type: "sessionDetail" }> => m.type === "sessionDetail",
    );
    expect(detailMsgs).toHaveLength(1);
    expect(detailMsgs[0]!.detail.tool_count).toBe(99);
  });

  it("emits exactly one batch per animation frame regardless of count", async () => {
    const { Store, MessageClient } = await loadFreshModules();
    const client = new MessageClient(new Store());
    let frameCount = 0;
    client.onUpdate(() => { frameCount += 1; });

    for (let i = 0; i < 100; i++) {
      window.dispatchEvent(new MessageEvent("message", { data: update(["x"]) }));
    }
    await flushRaf();
    expect(frameCount).toBe(1);
  });
});

describe("MessageClient — send forwards directly to host", () => {
  beforeEach(() => installVsCodeStub());
  afterEach(() => cleanupVsCodeStub());

  it("send() forwards a WebviewToHost message to vscode.postMessage", async () => {
    const api = (globalThis as unknown as { acquireVsCodeApi: () => MockApi }).acquireVsCodeApi();
    const { Store, MessageClient } = await loadFreshModules();
    const client = new MessageClient(new Store());
    client.send({ type: "ready" });
    const id = toSessionId("a") as SessionId | null;
    client.send({ type: "selectSession", sessionId: id });
    expect(api._posted).toEqual([
      { type: "ready" },
      { type: "selectSession", sessionId: toSessionId("a") },
    ]);
  });
});
