import { describe, expect, it } from "vitest";
import { desktopNotifyCommand } from "../../src/shared/desktopNotification";

describe("desktopNotifyCommand — OS-level notification so it shows even when VS Code is unfocused", () => {
  it("builds an osascript command on macOS", () => {
    const cmd = desktopNotifyCommand("darwin", "✦ Claude Trace", "Reviewer 1 finished — your turn.");
    expect(cmd).not.toBeNull();
    expect(cmd!.command).toBe("osascript");
    expect(cmd!.args[0]).toBe("-e");
    expect(cmd!.args[1]).toContain('display notification "Reviewer 1 finished — your turn."');
    expect(cmd!.args[1]).toContain('with title "✦ Claude Trace"');
  });

  it("escapes double quotes and backslashes so a crafted name cannot break the AppleScript", () => {
    const cmd = desktopNotifyCommand("darwin", 'a"b\\c', 'say "hi"');
    expect(cmd!.args[1]).toContain('with title "a\\"b\\\\c"');
    expect(cmd!.args[1]).toContain('display notification "say \\"hi\\""');
  });

  it("passes title and message as separate args on Linux (no shell interpolation)", () => {
    const cmd = desktopNotifyCommand("linux", "Title", "Message; rm -rf ~");
    expect(cmd).toEqual({ command: "notify-send", args: ["Title", "Message; rm -rf ~"] });
  });

  it("produces a PowerShell toast invocation on Windows", () => {
    const cmd = desktopNotifyCommand("win32", "Title", "Body");
    expect(cmd!.command).toBe("powershell");
    expect(cmd!.args).toContain("-Command");
    expect(cmd!.args.join(" ")).toContain("ToastNotification");
  });

  it("falls back to sane defaults for empty title/message", () => {
    const cmd = desktopNotifyCommand("darwin", "   ", "   ");
    expect(cmd!.args[1]).toContain('with title "Claude Trace"');
    expect(cmd!.args[1]).toContain('display notification "Claude Trace"');
  });

  it("returns null for unsupported platforms (caller keeps the in-app toast)", () => {
    expect(desktopNotifyCommand("aix", "t", "m")).toBeNull();
    expect(desktopNotifyCommand("freebsd", "t", "m")).toBeNull();
  });

  it("PREFERS alerter (signed+notarized, actually shows on modern macOS) with icon + group", () => {
    const cmd = desktopNotifyCommand("darwin", "Claude Trace", "Reviewer 1 is ready for you", {
      alerterBin: "/opt/homebrew/bin/alerter",
      terminalNotifierBin: "/opt/homebrew/bin/terminal-notifier",
      iconPath: "/ext/media/icon.png",
    });
    expect(cmd!.command).toBe("/opt/homebrew/bin/alerter");
    expect(cmd!.args[cmd!.args.indexOf("--title") + 1]).toBe("Claude Trace");
    expect(cmd!.args[cmd!.args.indexOf("--message") + 1]).toBe("Reviewer 1 is ready for you");
    expect(cmd!.args[cmd!.args.indexOf("--app-icon") + 1]).toBe("/ext/media/icon.png");
    expect(cmd!.args[cmd!.args.indexOf("--group") + 1]).toBe("claude-trace");
  });

  it("uses terminal-notifier with our icon + grouping when it is available (branded, replaces in place)", () => {
    const cmd = desktopNotifyCommand("darwin", "Claude Trace", "Reviewer 1 is ready for you", {
      terminalNotifierBin: "/opt/homebrew/bin/terminal-notifier",
      iconPath: "/ext/media/icon.png",
    });
    expect(cmd!.command).toBe("/opt/homebrew/bin/terminal-notifier");
    expect(cmd!.args[cmd!.args.indexOf("-title") + 1]).toBe("Claude Trace");
    expect(cmd!.args[cmd!.args.indexOf("-message") + 1]).toBe("Reviewer 1 is ready for you");
    expect(cmd!.args[cmd!.args.indexOf("-appIcon") + 1]).toBe("/ext/media/icon.png");
    expect(cmd!.args[cmd!.args.indexOf("-group") + 1]).toBe("claude-trace");
  });

  it("falls back to osascript when terminal-notifier is not installed", () => {
    const cmd = desktopNotifyCommand("darwin", "Claude Trace", "hi", { terminalNotifierBin: null });
    expect(cmd!.command).toBe("osascript");
  });

  it("uses a caller-supplied group so distinct finishes stack instead of replacing one another", () => {
    const a = desktopNotifyCommand("darwin", "Claude Trace", "Reviewer 1 is ready", {
      alerterBin: "/opt/homebrew/bin/alerter",
      group: "claude-trace-1",
    });
    const b = desktopNotifyCommand("darwin", "Claude Trace", "Reviewer 2 is ready", {
      alerterBin: "/opt/homebrew/bin/alerter",
      group: "claude-trace-2",
    });
    expect(a!.args[a!.args.indexOf("--group") + 1]).toBe("claude-trace-1");
    expect(b!.args[b!.args.indexOf("--group") + 1]).toBe("claude-trace-2");
  });
});
