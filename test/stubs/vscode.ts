import { spawn as childSpawn, type ChildProcessWithoutNullStreams } from "child_process";

export interface FakeTerminal {
  readonly id: number;
  readonly name: string;
  readonly cwd: string;
  sendText(text: string, addNewLine?: boolean): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

interface SentEntry {
  readonly terminalId: number;
  readonly text: string;
  readonly addNewLine: boolean;
  readonly atMs: number;
}

interface TestState {
  sentTexts: SentEntry[];
  terminals: Map<number, FakeTerminal>;
  processes: Map<number, ChildProcessWithoutNullStreams>;
  closeListeners: Set<(t: FakeTerminal) => void>;
  mockBinary: string | null;
  workspaceFolders: { uri: { fsPath: string } }[] | undefined;
  disposedTerminalIds: number[];
}

export const __testState: TestState = {
  sentTexts: [],
  terminals: new Map(),
  processes: new Map(),
  closeListeners: new Set(),
  mockBinary: null,
  workspaceFolders: undefined,
  disposedTerminalIds: [],
};

let terminalCounter = 0;

export const __reset = (): void => {
  for (const child of __testState.processes.values()) {
    try { child.kill("SIGKILL"); } catch {}
  }
  __testState.sentTexts = [];
  __testState.terminals.clear();
  __testState.processes.clear();
  __testState.closeListeners.clear();
  __testState.mockBinary = null;
  __testState.workspaceFolders = undefined;
  __testState.disposedTerminalIds = [];
  terminalCounter = 0;
};

const makeTerminal = (opts: { name?: string; cwd?: string }): FakeTerminal => {
  const id = ++terminalCounter;
  const cwd = opts.cwd ?? process.cwd();
  let child: ChildProcessWithoutNullStreams | null = null;
  let inputBuffer = "";

  const writeToChildIfReady = (text: string): void => {
    if (child && !child.killed) {
      child.stdin.write(text);
    } else {
      inputBuffer += text;
    }
  };

  const terminal: FakeTerminal = {
    id,
    name: opts.name ?? `terminal-${id}`,
    cwd,
    sendText(text: string, addNewLine = true): void {
      __testState.sentTexts.push({ terminalId: id, text, addNewLine, atMs: Date.now() });
      const trimmed = text.trim();
      const mockBinary = __testState.mockBinary;
      if (mockBinary && trimmed.startsWith("MOCK_CLAUDE")) {
        const remainder = trimmed.slice("MOCK_CLAUDE".length).trim();
        const shellCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(mockBinary)} ${remainder}`;
        child = childSpawn(shellCommand, [], {
          cwd,
          env: { ...process.env },
          stdio: ["pipe", "pipe", "pipe"],
          shell: true,
        });
        __testState.processes.set(id, child);
        child.stderr.on("data", (d: Buffer) => { if (process.env.MOCK_DEBUG === "1") process.stderr.write(`[mock-stderr ${id}] ${d.toString()}`); });
        child.stdout.on("data", (d: Buffer) => { if (process.env.MOCK_DEBUG === "1") process.stderr.write(`[mock-stdout ${id}] ${d.toString()}`); });
        child.on("exit", (code: number | null, sig: string | null) => {
          if (process.env.MOCK_DEBUG === "1") process.stderr.write(`[mock-exit ${id}] code=${code} sig=${sig}\n`);
          __testState.processes.delete(id);
        });
        if (inputBuffer.length > 0) {
          child.stdin.write(inputBuffer);
          inputBuffer = "";
        }
        return;
      }
      writeToChildIfReady(addNewLine ? text + "\n" : text);
    },
    show(): void {},
    dispose(): void {
      __testState.disposedTerminalIds.push(id);
      const c = __testState.processes.get(id);
      if (c && !c.killed) {
        try { c.kill("SIGTERM"); } catch {}
      }
      __testState.processes.delete(id);
      for (const listener of __testState.closeListeners) listener(terminal);
    },
  };
  __testState.terminals.set(id, terminal);
  return terminal;
};

export const window = {
  createTerminal(opts: { name?: string; cwd?: string }): FakeTerminal {
    return makeTerminal(opts);
  },
  onDidCloseTerminal(listener: (t: FakeTerminal) => void): { dispose(): void } {
    __testState.closeListeners.add(listener);
    return { dispose: () => __testState.closeListeners.delete(listener) };
  },
};

export const workspace = {
  get workspaceFolders(): { uri: { fsPath: string } }[] | undefined {
    return __testState.workspaceFolders;
  },
};

export class Disposable {
  constructor(private readonly callOnDispose?: () => void) {}
  dispose(): void {
    this.callOnDispose?.();
  }
}

export class Uri {
  static file(p: string): { fsPath: string } { return { fsPath: p }; }
  static joinPath(base: { fsPath: string }, ...segments: string[]): { fsPath: string } {
    return { fsPath: [base.fsPath, ...segments].join("/") };
  }
}
