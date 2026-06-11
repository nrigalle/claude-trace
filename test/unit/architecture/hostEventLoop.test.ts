import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.join(__dirname, "..", "..", "..", "src");

const SYNC_EXEC_ALLOWLIST = new Set(["src/features/cockpit/infra/pty/TmuxTerminalService.ts"]);

const listSourceFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
};

describe("architecture — extension host event loop must never block", () => {
  it("no synchronous child_process calls outside the tmux allowlist (sync exec freezes typing, paste and every webview)", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const rel = path.relative(path.join(SRC_ROOT, ".."), file).split(path.sep).join("/");
      if (SYNC_EXEC_ALLOWLIST.has(rel)) continue;
      const content = fs.readFileSync(file, "utf8");
      if (/execFileSync|execSync\(|spawnSync/.test(content)) offenders.push(rel);
    }
    expect(
      offenders,
      "These files call sync child_process APIs on the extension host. Use async execFile/promisify instead — sync exec blocks the event loop and makes typing/paste lag in every terminal. If a call is truly one-shot at startup, add the file to SYNC_EXEC_ALLOWLIST with justification.",
    ).toEqual([]);
  });

  it("the tmux allowlist file keeps its sync calls bounded (one-shot probes only, never per-keystroke or per-resize paths)", () => {
    const file = path.join(SRC_ROOT, "features", "cockpit", "infra", "pty", "TmuxTerminalService.ts");
    const count = (fs.readFileSync(file, "utf8").match(/execFileSync/g) ?? []).length;
    expect(
      count,
      "TmuxTerminalService gained sync exec calls. Verify none of them sit on a hot path (resize, data, attention) before raising this bound.",
    ).toBeLessThanOrEqual(4);
  });
});
