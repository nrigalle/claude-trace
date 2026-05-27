import * as os from "os";
import * as pty from "node-pty";
import type { TerminalSpawnSpec } from "../../app/CockpitController";
import { TerminalServiceBase } from "./TerminalServiceBase";

const defaultShell = (): string => {
  if (process.platform === "win32") return process.env["COMSPEC"] ?? "powershell.exe";
  return process.env["SHELL"] ?? "/bin/bash";
};

export class PtyTerminalService extends TerminalServiceBase {
  spawn(spec: TerminalSpawnSpec): void {
    const proc = pty.spawn(defaultShell(), [], {
      name: "xterm-256color",
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd ?? os.homedir(),
      env: { ...process.env, CLAUDE_CODE_NO_FLICKER: "1" } as Record<string, string>,
    });
    this.track(spec.sessionId, proc, spec.initialInput);
  }

  kill(sessionId: string): void {
    const proc = this.forget(sessionId);
    try {
      proc?.kill();
    } catch {}
  }
}
