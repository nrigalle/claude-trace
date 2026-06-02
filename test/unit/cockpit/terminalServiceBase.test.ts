import type * as pty from "node-pty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSpawnSpec } from "../../../src/features/cockpit/app/CockpitController";
import { TerminalServiceBase } from "../../../src/features/cockpit/infra/pty/TerminalServiceBase";

class FakePty {
  readonly writes: string[] = [];

  onData(): void {}

  onExit(): void {}

  write(data: string): void {
    this.writes.push(data);
  }

  resize(): void {}

  kill(): void {}
}

class TestTerminalService extends TerminalServiceBase {
  readonly proc = new FakePty();

  spawn(spec: TerminalSpawnSpec): void {
    this.track(spec.sessionId, this.proc as unknown as pty.IPty, spec.initialInput);
  }

  kill(sessionId: string): void {
    this.forget(sessionId);
  }
}

const spawnSpec = (initialInput = ""): TerminalSpawnSpec => ({
  sessionId: "s",
  cwd: null,
  cols: 80,
  rows: 24,
  initialInput,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TerminalServiceBase — pty writes", () => {
  it("chunks long terminal input so a large paste is not one oversized pty write", async () => {
    const service = new TestTerminalService();
    service.spawn(spawnSpec());
    const input = `${"review ".repeat(3000)}🙂 done`;

    service.write("s", input);
    expect(service.proc.writes).toHaveLength(1);
    expect(service.proc.writes[0]!.length).toBeLessThan(input.length);

    await vi.runAllTimersAsync();
    expect(service.proc.writes.length).toBeGreaterThan(1);
    expect(service.proc.writes.join("")).toBe(input);
  });

  it("keeps later keystrokes behind an in-flight long paste", async () => {
    const service = new TestTerminalService();
    service.spawn(spawnSpec());
    const input = "x".repeat(9000);

    service.write("s", input);
    service.write("s", "\r");

    await vi.runAllTimersAsync();
    expect(service.proc.writes.join("")).toBe(`${input}\r`);
    expect(service.proc.writes.at(-1)).toBe("\r");
  });

  it("cancels queued paste chunks when the terminal is killed", async () => {
    const service = new TestTerminalService();
    service.spawn(spawnSpec());

    service.write("s", "x".repeat(9000));
    service.kill("s");
    await vi.runAllTimersAsync();

    expect(service.proc.writes).toHaveLength(1);
  });
});
