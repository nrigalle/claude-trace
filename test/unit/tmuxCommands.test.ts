import { describe, expect, it } from "vitest";
import {
  tmuxSessionName,
  tmuxAttachArgs,
  tmuxCaptureArgs,
  tmuxAlternateOnArgs,
  tmuxConfigText,
} from "../../src/features/cockpit/infra/pty/TmuxTerminalService";

describe("tmux command construction (background-persistent sessions)", () => {
  it("derives a stable, dot-free session name from the session id", () => {
    expect(tmuxSessionName("abc-123")).toBe("ct-abc-123");
  });

  it("uses a PRIVATE socket so it never touches the user's own tmux server", () => {
    const args = tmuxAttachArgs("/conf", "ct-x", 80, 24);
    expect(args[0]).toBe("-L");
    expect(args[1]).toBe("claude-trace");
  });

  it("uses new-session -A so it ATTACHES to a live background session or CREATES one (the core of persistence)", () => {
    const args = tmuxAttachArgs("/conf", "ct-x", 100, 30);
    const idx = args.indexOf("new-session");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("-A");
    expect(args).toContain("-s");
    expect(args[args.indexOf("-s") + 1]).toBe("ct-x");
  });

  it("passes the initial size and the isolating config file", () => {
    const args = tmuxAttachArgs("/my/conf.conf", "ct-x", 120, 40);
    expect(args[args.indexOf("-x") + 1]).toBe("120");
    expect(args[args.indexOf("-y") + 1]).toBe("40");
    expect(args[args.indexOf("-f") + 1]).toBe("/my/conf.conf");
  });

  it("captures the full pane history with escape sequences from the private socket for color-preserving scrollback replay", () => {
    expect(tmuxCaptureArgs("ct-x")).toEqual(["-L", "claude-trace", "capture-pane", "-e", "-p", "-J", "-S", "-", "-t", "ct-x"]);
  });

  it("queries alternate-screen state before replaying scrollback", () => {
    expect(tmuxAlternateOnArgs("ct-x")).toEqual(["-L", "claude-trace", "display-message", "-p", "-t", "ct-x", "#{alternate_on}"]);
  });

  it("lets full-screen terminal apps use the normal alternate screen instead of dumping UI frames into scrollback", () => {
    expect(tmuxConfigText()).toContain("set -g alternate-screen on");
  });

  it("hands the wheel and click-drag selection to xterm.js for native scroll/copy by turning tmux mouse OFF and disabling tmux's OUTER alternate screen (smcup@/rmcup@) so xterm.js stays on its main screen with a populated scrollback (regression: mouse on stole native selection and gave jumpy copy-mode scroll; mouse off without the smcup override would arrow-spam command/prompt history)", () => {
    expect(tmuxConfigText()).toContain("set -g mouse off");
    expect(tmuxConfigText()).not.toContain("set -g mouse on");
    expect(tmuxConfigText()).toContain("smcup@:rmcup@");
  });

  it("keeps OSC 52 clipboard and passthrough so copy-to-clipboard and DCS-wrapped sequences reach the outer terminal", () => {
    expect(tmuxConfigText()).toContain("set -g set-clipboard on");
    expect(tmuxConfigText()).toContain("set -g allow-passthrough on");
  });

  it("drops the redundant Tc truecolor override (RGB is already advertised via terminal-features)", () => {
    expect(tmuxConfigText()).not.toContain(":Tc");
  });
});
