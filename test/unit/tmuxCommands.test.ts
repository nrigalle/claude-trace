import { describe, expect, it } from "vitest";
import { tmuxSessionName, tmuxAttachArgs } from "../../src/features/cockpit/infra/pty/TmuxTerminalService";

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
});
