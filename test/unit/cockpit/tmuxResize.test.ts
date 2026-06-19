import * as os from "os";
import * as path from "path";
import type * as pty from "node-pty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TmuxTerminalService } from "../../../src/features/cockpit/infra/pty/TmuxTerminalService";

class FakePty {
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  onData(): void {}
  onExit(): void {}
  write(): void {}
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  kill(): void {}
}

class TestTmux extends TmuxTerminalService {
  redraws = 0;
  constructor() {
    super("tmux", path.join(os.tmpdir(), `ct-tmux-test-${Math.random().toString(36).slice(2)}.conf`));
  }
  override forceRedraw(): boolean {
    this.redraws += 1;
    return true;
  }
  attach(sessionId: string, proc: pty.IPty): void {
    this.track(sessionId, proc, undefined);
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("TmuxTerminalService — redraw after resize", () => {
  it("forces a tmux redraw shortly after a resize so the TUI repaints the whole pane (regression: blank gaps after resize/window changes)", () => {
    const svc = new TestTmux();
    const proc = new FakePty();
    svc.attach("s", proc as unknown as pty.IPty);

    svc.resize("s", 120, 40);
    expect(svc.redraws, "the redraw is debounced, not immediate").toBe(0);

    vi.advanceTimersByTime(200);
    expect(svc.redraws, "after the debounce a single redraw repaints the pane").toBe(1);
    expect(proc.resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("coalesces a burst of resizes into one redraw", () => {
    const svc = new TestTmux();
    const proc = new FakePty();
    svc.attach("s", proc as unknown as pty.IPty);

    svc.resize("s", 100, 30);
    svc.resize("s", 110, 35);
    svc.resize("s", 120, 40);
    vi.advanceTimersByTime(200);

    expect(svc.redraws).toBe(1);
  });
});
