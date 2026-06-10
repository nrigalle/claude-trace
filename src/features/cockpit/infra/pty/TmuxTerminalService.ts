import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import * as pty from "node-pty";
import type { TerminalSpawnSpec } from "../../app/CockpitController";
import { TerminalServiceBase } from "./TerminalServiceBase";

const SOCKET = "claude-trace";
const ignoreBestEffortFailure = (_err: unknown): void => {};

const TMUX_CONF = [
  "set -g status off",
  "set -g prefix None",
  "unbind C-b",
  "set -s escape-time 0",
  "set -g destroy-unattached off",
  "set -g exit-empty off",
  "setw -g aggressive-resize on",
  "set -g history-limit 5000",
  "set -g focus-events on",
  "set -g mouse off",
  "set -g set-clipboard on",
  "set -g extended-keys on",
  "set -g alternate-screen on",
  'set -g default-terminal "tmux-256color"',
  'set -as terminal-features ",xterm-256color:RGB,xterm-256color:clipboard,tmux-256color:RGB,tmux-256color:clipboard"',
  'set -ga terminal-overrides ",xterm-256color:Tc"',
  "",
].join("\n");

export const tmuxSessionName = (sessionId: string): string => `ct-${sessionId}`;

export const tmuxAttachArgs = (
  confPath: string | null,
  name: string,
  cols: number,
  rows: number,
): string[] => [
  "-L",
  SOCKET,
  ...(confPath ? ["-f", confPath] : []),
  "new-session",
  "-A",
  "-s",
  name,
  "-x",
  String(cols),
  "-y",
  String(rows),
];

const tmuxCapturePaneArgs = (name: string): string[] => [
  "capture-pane",
  "-p",
  "-J",
  "-S",
  "-",
  "-t",
  name,
];

export const tmuxCaptureArgs = (name: string): string[] => ["-L", SOCKET, ...tmuxCapturePaneArgs(name)];
export const tmuxAlternateOnArgs = (name: string): string[] => ["-L", SOCKET, "display-message", "-p", "-t", name, "#{alternate_on}"];
export const tmuxConfigText = (): string => TMUX_CONF;

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
    this.ensureConf();
  }

  private ensureConf(): string | null {
    try {
      fs.mkdirSync(path.dirname(this.confPath), { recursive: true });
      fs.writeFileSync(this.confPath, TMUX_CONF, "utf8");
      return this.confPath;
    } catch {
      return fs.existsSync(this.confPath) ? this.confPath : null;
    }
  }

  private tmux(args: readonly string[]): void {
    execFileSync(this.tmuxBin, ["-L", SOCKET, ...args], { stdio: "ignore" });
  }

  private tmuxOutput(args: readonly string[]): string {
    return execFileSync(this.tmuxBin, ["-L", SOCKET, ...args], { encoding: "utf8" });
  }

  private sessionExists(name: string): boolean {
    try {
      this.tmux(["has-session", "-t", name]);
      return true;
    } catch {
      return false;
    }
  }

  private sourceConf(conf: string | null): void {
    if (!conf) return;
    try {
      this.tmux(["source-file", conf]);
    } catch {
      return;
    }
  }

  spawn(spec: TerminalSpawnSpec): void {
    const conf = this.ensureConf();
    const name = tmuxSessionName(spec.sessionId);
    const alreadyRunning = this.sessionExists(name);
    const env = { ...process.env, CLAUDE_CODE_NO_FLICKER: "1" } as Record<string, string>;
    delete env["TMUX"];
    const proc = pty.spawn(
      this.tmuxBin,
      tmuxAttachArgs(conf, name, spec.cols, spec.rows),
      { name: "xterm-256color", cols: spec.cols, rows: spec.rows, cwd: spec.cwd ?? os.homedir(), env },
    );
    this.sourceConf(conf);
    this.track(spec.sessionId, proc, alreadyRunning && spec.forceInitialInput !== true ? undefined : spec.initialInput);
    if (spec.cols >= 2 && spec.rows >= 2) {
      try {
        this.tmux(["resize-window", "-t", name, "-x", String(spec.cols), "-y", String(spec.rows)]);
      } catch (err: unknown) {
        ignoreBestEffortFailure(err);
      }
    }
  }

  override resize(sessionId: string, cols: number, rows: number): void {
    super.resize(sessionId, cols, rows);
    if (cols < 2 || rows < 2) return;
    try {
      this.tmux(["resize-window", "-t", tmuxSessionName(sessionId), "-x", String(cols), "-y", String(rows)]);
    } catch (err: unknown) {
      ignoreBestEffortFailure(err);
    }
  }

  override captureHistory(sessionId: string): string | null {
    try {
      const name = tmuxSessionName(sessionId);
      if (this.tmuxOutput(["display-message", "-p", "-t", name, "#{alternate_on}"]).trim() === "1") return "";
      const text = this.tmuxOutput(tmuxCapturePaneArgs(name));
      return normalizeCapturedText(text);
    } catch {
      return null;
    }
  }

  override forceRedraw(sessionId: string): boolean {
    try {
      const name = tmuxSessionName(sessionId);
      const clients = this.tmuxOutput(["list-clients", "-t", name, "-F", "#{client_name}"])
        .split("\n")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      if (clients.length === 0) return false;
      for (const client of clients) this.tmux(["refresh-client", "-t", client]);
      return true;
    } catch {
      return false;
    }
  }

  kill(sessionId: string): void {
    this.notifyExit(sessionId, 0);
    const proc = this.forget(sessionId);
    try {
      this.tmux(["kill-session", "-t", tmuxSessionName(sessionId)]);
    } catch {}
    try {
      proc?.kill();
    } catch {}
  }
}

const normalizeCapturedText = (text: string): string =>
  text.length === 0 ? "" : text.replace(/\r?\n/g, "\r\n");
