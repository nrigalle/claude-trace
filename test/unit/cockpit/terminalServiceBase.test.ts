import type * as pty from "node-pty";
import { describe, expect, it } from "vitest";
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

describe("TerminalServiceBase — pty writes", () => {
  it("writes a long paste atomically in ONE pty write (regression: 4096-byte chunking with delays broke the TUI bracketed paste, dropping most of a big paste)", () => {
    const service = new TestTerminalService();
    service.spawn(spawnSpec());
    const input = `[200~${"review ".repeat(3000)}🙂 done[201~`;

    service.write("s", input);

    expect(service.proc.writes, "the whole paste is delivered in a single contiguous write, surrogate pair intact").toEqual([input]);
  });

  it("preserves order when a long paste is immediately followed by a submit CR", () => {
    const service = new TestTerminalService();
    service.spawn(spawnSpec());
    const input = "x".repeat(9000);

    service.write("s", input);
    service.write("s", "\r");

    expect(service.proc.writes).toEqual([input, "\r"]);
  });

  it("drops writes once the terminal is killed", () => {
    const service = new TestTerminalService();
    service.spawn(spawnSpec());

    service.kill("s");
    service.write("s", "x".repeat(9000));

    expect(service.proc.writes).toHaveLength(0);
  });
});
