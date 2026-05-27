import * as os from "os";
import * as fs from "fs";
import { execFileSync } from "child_process";
import * as pty from "node-pty";
import type { TerminalSpawnSpec } from "../../app/CockpitController";
import { TerminalServiceBase } from "./TerminalServiceBase";

const SOCKET = "claude-trace";

const TMUX_CONF = [
  "set -g status off",
  "set -g prefix None",
  "unbind C-b",
  "set -s escape-time 0",
  "set -g destroy-unattached off",
  "set -g exit-empty off",
  "setw -g aggressive-resize on",
  "set -g history-limit 10000",
  "set -g focus-events on",
  "set -g mouse on",
  'set -g default-terminal "tmux-256color"',
  'set -as terminal-features ",xterm-256color:RGB"',
  'set -ga terminal-overrides ",xterm-256color:Tc"',
  "set -g allow-passthrough on",
  "",
].join("\n");

export const tmuxSessionName = (sessionId: string): string => `ct-${sessionId}`;

export const tmuxAttachArgs = (confPath: string, name: string, cols: number, rows: number): string[] => [
  "-L",
  SOCKET,
  "-f",
  confPath,
  "new-session",
  "-A",
  "-s",
  name,
  "-x",
  String(cols),
  "-y",
  String(rows),
];

export const findTmux = (): string | null => {
  for (const bin of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux", "tmux"]) {
    try {
      execFileSync(bin, ["-V"], { stdio: "ignore" });
      return bin;
    } catch {}
  }
  return null;
};

export class TmuxTerminalService extends TerminalServiceBase {
  constructor(
    private readonly tmuxBin: string,
    private readonly confPath: string,
  ) {
    super();
    try {
      fs.writeFileSync(this.confPath, TMUX_CONF, "utf8");
    } catch {}
  }

  private tmux(args: readonly string[]): void {
    execFileSync(this.tmuxBin, ["-L", SOCKET, ...args], { stdio: "ignore" });
  }

  private sessionExists(name: string): boolean {
    try {
      this.tmux(["has-session", "-t", name]);
      return true;
    } catch {
      return false;
    }
  }

  spawn(spec: TerminalSpawnSpec): void {
    const name = tmuxSessionName(spec.sessionId);
    const alreadyRunning = this.sessionExists(name);
    const env = { ...process.env, CLAUDE_CODE_NO_FLICKER: "1" } as Record<string, string>;
    delete env["TMUX"];
    const proc = pty.spawn(
      this.tmuxBin,
      tmuxAttachArgs(this.confPath, name, spec.cols, spec.rows),
      { name: "xterm-256color", cols: spec.cols, rows: spec.rows, cwd: spec.cwd ?? os.homedir(), env },
    );
    this.track(spec.sessionId, proc, alreadyRunning ? undefined : spec.initialInput);
  }

  kill(sessionId: string): void {
    const proc = this.forget(sessionId);
    try {
      this.tmux(["kill-session", "-t", tmuxSessionName(sessionId)]);
    } catch {}
    try {
      proc?.kill();
    } catch {}
  }
}
