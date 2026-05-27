import { afterAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TmuxTerminalService, tmuxAttachArgs } from "../../src/features/cockpit/infra/pty/TmuxTerminalService";

const tmpRoots: string[] = [];
const freshRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-onboard-"));
  tmpRoots.push(root);
  return root;
};

afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

describe("onboarding — a brand new install with nothing on disk", () => {
  it("creates the tmux config even though its parent directory does not exist yet", () => {
    const root = freshRoot();
    const confPath = path.join(root, ".claude-trace", "tmux.conf");
    expect(fs.existsSync(path.dirname(confPath))).toBe(false);

    new TmuxTerminalService("tmux", confPath);

    expect(fs.existsSync(confPath)).toBe(true);
    expect(fs.readFileSync(confPath, "utf8")).toContain("status off");
  });

  it("launches the first session against the config that now exists on disk", () => {
    const root = freshRoot();
    const confPath = path.join(root, ".claude-trace", "tmux.conf");
    new TmuxTerminalService("tmux", confPath);

    const args = tmuxAttachArgs(confPath, "ct-first", 80, 24);
    expect(args[args.indexOf("-f") + 1]).toBe(confPath);
    expect(fs.existsSync(args[args.indexOf("-f") + 1]!)).toBe(true);
    expect(args.indexOf("new-session")).toBeGreaterThan(-1);
  });

  it("still forms a valid tmux command when the config cannot be written (read-only home, locked-down box)", () => {
    const args = tmuxAttachArgs(null, "ct-first", 80, 24);
    expect(args).not.toContain("-f");
    expect(args[0]).toBe("-L");
    const ns = args.indexOf("new-session");
    expect(ns).toBeGreaterThan(-1);
    expect(args[ns + 1]).toBe("-A");
    expect(args[args.indexOf("-s") + 1]).toBe("ct-first");
  });

  it("bootstraps the attention hooks and signals directories from an empty home on first session", async () => {
    const root = freshRoot();
    process.env["CLAUDE_TRACE_DATA_DIR"] = path.join(root, ".claude-trace");
    const { writeSessionHooks } = await import("../../src/features/cockpit/infra/cockpitSignals");
    const { COCKPIT_HOOKS_DIR, COCKPIT_SIGNALS_DIR } = await import("../../src/shared/config");

    expect(fs.existsSync(COCKPIT_HOOKS_DIR)).toBe(false);

    const file = writeSessionHooks("sess-1");

    expect(file).not.toBeNull();
    expect(fs.existsSync(COCKPIT_HOOKS_DIR)).toBe(true);
    expect(fs.existsSync(COCKPIT_SIGNALS_DIR)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(file!, "utf8"));
    expect(Object.keys(settings.hooks)).toEqual(
      expect.arrayContaining(["Stop", "Notification", "UserPromptSubmit", "PreToolUse"]),
    );
    expect(JSON.stringify(settings)).toContain(path.join(root, ".claude-trace", "signals"));
  });
});
