import type * as pty from "node-pty";
import type { TerminalBackend, TerminalSpawnSpec } from "../../app/CockpitController";

const INITIAL_INPUT_DELAY_MS = 700;

export abstract class TerminalServiceBase implements TerminalBackend {
  protected readonly procs = new Map<string, pty.IPty>();
  protected readonly exited = new Set<string>();
  private readonly dataListeners = new Set<(sessionId: string, data: string) => void>();
  private readonly exitListeners = new Set<(sessionId: string, exitCode: number) => void>();
  private readonly pendingInitial = new Map<string, string>();
  private readonly initialTimers = new Map<string, ReturnType<typeof setTimeout>>();

  abstract spawn(spec: TerminalSpawnSpec): void;
  abstract kill(sessionId: string): void;

  protected track(sessionId: string, proc: pty.IPty, initialInput: string | undefined): void {
    this.procs.set(sessionId, proc);
    this.exited.delete(sessionId);
    proc.onData((data) => {
      for (const listener of this.dataListeners) listener(sessionId, data);
    });
    proc.onExit(({ exitCode }) => {
      this.exited.add(sessionId);
      for (const listener of this.exitListeners) listener(sessionId, exitCode);
    });
    if (initialInput) {
      this.pendingInitial.set(sessionId, initialInput);
      this.initialTimers.set(sessionId, setTimeout(() => this.flushInitial(sessionId), INITIAL_INPUT_DELAY_MS));
    }
  }

  protected forget(sessionId: string): pty.IPty | undefined {
    const proc = this.procs.get(sessionId);
    this.procs.delete(sessionId);
    this.clearPending(sessionId);
    return proc;
  }

  private clearPending(sessionId: string): void {
    this.pendingInitial.delete(sessionId);
    const timer = this.initialTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.initialTimers.delete(sessionId);
    }
  }

  protected flushInitial(sessionId: string): void {
    const input = this.pendingInitial.get(sessionId);
    if (input === undefined) return;
    this.clearPending(sessionId);
    this.procs.get(sessionId)?.write(input);
  }

  write(sessionId: string, data: string): void {
    this.procs.get(sessionId)?.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const proc = this.procs.get(sessionId);
    if (!proc || this.exited.has(sessionId)) return;
    if (cols < 2 || rows < 2) return;
    try {
      proc.resize(cols, rows);
    } catch {}
    this.flushInitial(sessionId);
  }

  isAlive(sessionId: string): boolean {
    return this.procs.has(sessionId) && !this.exited.has(sessionId);
  }

  onData(listener: (sessionId: string, data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (sessionId: string, exitCode: number) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  dispose(): void {
    for (const timer of this.initialTimers.values()) clearTimeout(timer);
    this.initialTimers.clear();
    this.pendingInitial.clear();
    for (const proc of this.procs.values()) {
      try {
        proc.kill();
      } catch {}
    }
    this.procs.clear();
    this.dataListeners.clear();
    this.exitListeners.clear();
  }
}
