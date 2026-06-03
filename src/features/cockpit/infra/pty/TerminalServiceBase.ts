import type * as pty from "node-pty";
import type { TerminalBackend, TerminalSpawnSpec } from "../../app/CockpitController";
import type { ShellQuote } from "../../../../shared/permissionModes";

const INITIAL_INPUT_DELAY_MS = 700;
const WRITE_CHUNK_SIZE = 4096;
const WRITE_CHUNK_DELAY_MS = 4;

export abstract class TerminalServiceBase implements TerminalBackend {
  protected readonly procs = new Map<string, pty.IPty>();
  protected readonly exited = new Set<string>();
  private readonly dataListeners = new Set<(sessionId: string, data: string) => void>();
  private readonly exitListeners = new Set<(sessionId: string, exitCode: number) => void>();
  private readonly pendingInitial = new Map<string, string>();
  private readonly initialTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly writeQueues = new Map<string, string[]>();
  private readonly writeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  abstract spawn(spec: TerminalSpawnSpec): void;
  abstract kill(sessionId: string): void;

  shellQuoteStyle(): ShellQuote {
    return "posix";
  }

  protected track(sessionId: string, proc: pty.IPty, initialInput: string | undefined): void {
    this.procs.set(sessionId, proc);
    this.exited.delete(sessionId);
    proc.onData((data) => {
      if (this.procs.get(sessionId) !== proc) return;
      for (const listener of this.dataListeners) listener(sessionId, data);
    });
    proc.onExit(({ exitCode }) => {
      if (this.procs.get(sessionId) !== proc) return;
      this.notifyExit(sessionId, exitCode);
    });
    if (initialInput) {
      this.pendingInitial.set(sessionId, initialInput);
      this.initialTimers.set(sessionId, setTimeout(() => this.flushInitial(sessionId), INITIAL_INPUT_DELAY_MS));
    }
  }

  protected notifyExit(sessionId: string, exitCode: number): void {
    if (this.exited.has(sessionId)) return;
    this.exited.add(sessionId);
    for (const listener of this.exitListeners) listener(sessionId, exitCode);
  }

  protected forget(sessionId: string): pty.IPty | undefined {
    const proc = this.procs.get(sessionId);
    this.procs.delete(sessionId);
    this.clearPending(sessionId);
    this.clearWriteQueue(sessionId);
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
    this.write(sessionId, input);
  }

  write(sessionId: string, data: string): void {
    if (!this.procs.has(sessionId) || this.exited.has(sessionId)) return;
    const chunks = chunkTerminalInput(data);
    const queue = this.writeQueues.get(sessionId);
    if (queue) {
      queue.push(...chunks);
      return;
    }
    if (chunks.length === 1) {
      this.procs.get(sessionId)?.write(chunks[0]!);
      return;
    }
    this.writeQueues.set(sessionId, chunks);
    this.flushWriteQueue(sessionId);
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

  captureHistory(_sessionId: string): string | null {
    return null;
  }

  forceRedraw(_sessionId: string): boolean {
    return false;
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
    for (const timer of this.writeTimers.values()) clearTimeout(timer);
    this.writeTimers.clear();
    this.writeQueues.clear();
    for (const proc of this.procs.values()) {
      try {
        proc.kill();
      } catch {}
    }
    this.procs.clear();
    this.dataListeners.clear();
    this.exitListeners.clear();
  }

  private flushWriteQueue(sessionId: string): void {
    const queue = this.writeQueues.get(sessionId);
    const proc = this.procs.get(sessionId);
    if (!queue || !proc || this.exited.has(sessionId)) {
      this.clearWriteQueue(sessionId);
      return;
    }
    const chunk = queue.shift();
    if (chunk === undefined) {
      this.clearWriteQueue(sessionId);
      return;
    }
    proc.write(chunk);
    if (queue.length === 0) {
      this.clearWriteQueue(sessionId);
      return;
    }
    this.writeTimers.set(sessionId, setTimeout(() => this.flushWriteQueue(sessionId), WRITE_CHUNK_DELAY_MS));
  }

  private clearWriteQueue(sessionId: string): void {
    this.writeQueues.delete(sessionId);
    const timer = this.writeTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.writeTimers.delete(sessionId);
    }
  }
}

const chunkTerminalInput = (data: string): string[] => {
  if (data.length <= WRITE_CHUNK_SIZE) return [data];
  const chunks: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + WRITE_CHUNK_SIZE, data.length);
    if (end < data.length && isHighSurrogate(data.charCodeAt(end - 1)) && isLowSurrogate(data.charCodeAt(end))) {
      end -= 1;
    }
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
};

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
