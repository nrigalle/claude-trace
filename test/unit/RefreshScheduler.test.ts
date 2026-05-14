import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefreshScheduler } from "../../src/app/RefreshScheduler";

describe("RefreshScheduler — visible path", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst of 100 schedules into a single flush after the trailing window", async () => {
    const flush = vi.fn();
    const sch = new RefreshScheduler({ isVisible: () => true, flush });
    for (let i = 0; i < 100; i++) sch.schedule();
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(349);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("debounces while bursts continue, then fires once after silence", async () => {
    const flush = vi.fn();
    const sch = new RefreshScheduler({ isVisible: () => true, flush });
    for (let i = 0; i < 6; i++) {
      sch.schedule();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("hits max-wait cap when bursts never stop (15-30 flushes in 30s of 10ms tick)", async () => {
    const flush = vi.fn();
    const sch = new RefreshScheduler({ isVisible: () => true, flush });
    for (let t = 0; t < 30_000; t += 10) {
      sch.schedule();
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(400);
    expect(flush.mock.calls.length).toBeGreaterThanOrEqual(15);
    expect(flush.mock.calls.length).toBeLessThanOrEqual(30);
  });
});

describe("RefreshScheduler — visibility transitions (P0 regression)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("queued schedule while invisible does NOT flush; notifyVisible fires exactly once", async () => {
    const flush = vi.fn();
    let visible = false;
    const sch = new RefreshScheduler({ isVisible: () => visible, flush });
    sch.schedule(); sch.schedule(); sch.schedule();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(flush).not.toHaveBeenCalled();
    visible = true;
    sch.notifyVisible();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("schedule while visible then transition to hidden cancels the pending fire", async () => {
    const flush = vi.fn();
    let visible = true;
    const sch = new RefreshScheduler({ isVisible: () => visible, flush });
    sch.schedule();
    visible = false;
    sch.notifyHidden();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(flush).not.toHaveBeenCalled();
  });

  it("after hide, fire() still gates on visibility (defensive double-check)", async () => {
    const flush = vi.fn();
    let visible = true;
    const sch = new RefreshScheduler({ isVisible: () => visible, flush });
    sch.schedule();
    visible = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(flush).not.toHaveBeenCalled();
  });

  it("show -> hide -> show without intervening schedule does not flush", async () => {
    const flush = vi.fn();
    let visible = true;
    const sch = new RefreshScheduler({ isVisible: () => visible, flush });
    visible = false;
    sch.notifyHidden();
    visible = true;
    sch.notifyVisible();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(flush).not.toHaveBeenCalled();
  });

  it("notifyVisible without pendingWhileHidden does NOT flush", async () => {
    const flush = vi.fn();
    const sch = new RefreshScheduler({ isVisible: () => true, flush });
    sch.notifyVisible();
    expect(flush).not.toHaveBeenCalled();
  });

  it("after notifyHidden, subsequent schedule while invisible just queues without timers", async () => {
    const flush = vi.fn();
    let visible = false;
    const sch = new RefreshScheduler({ isVisible: () => visible, flush });
    sch.notifyHidden();
    sch.schedule();
    sch.schedule();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(flush).not.toHaveBeenCalled();
    visible = true;
    sch.notifyVisible();
    expect(flush).toHaveBeenCalledTimes(1);
  });
});

describe("RefreshScheduler — dispose semantics", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("dispose mid-pending cancels any scheduled flush", async () => {
    const flush = vi.fn();
    const sch = new RefreshScheduler({ isVisible: () => true, flush });
    sch.schedule();
    sch.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(flush).not.toHaveBeenCalled();
  });

  it("after dispose, schedule is a no-op", async () => {
    const flush = vi.fn();
    const sch = new RefreshScheduler({ isVisible: () => true, flush });
    sch.dispose();
    sch.schedule();
    sch.schedule();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(flush).not.toHaveBeenCalled();
  });

  it("after dispose, notifyVisible is a no-op", async () => {
    const flush = vi.fn();
    const sch = new RefreshScheduler({ isVisible: () => true, flush });
    sch.schedule();
    sch.dispose();
    sch.notifyVisible();
    expect(flush).not.toHaveBeenCalled();
  });
});
