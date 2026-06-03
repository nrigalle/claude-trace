import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECTS_DIR } from "../../../src/shared/config";
import * as os from "node:os";
import {
  cwdForProjectDir,
  discoverSessionRefs,
  filenameToSessionId,
  parseUriPath,
} from "../../../src/features/dashboard/infra/paths";

describe("filenameToSessionId", () => {
  it("returns null when missing extension", () => {
    expect(filenameToSessionId("abc")).toBeNull();
    expect(filenameToSessionId("abc.json")).toBeNull();
  });

  it("returns null on empty stem", () => {
    expect(filenameToSessionId(".jsonl")).toBeNull();
  });

  it("strips .jsonl suffix", () => {
    expect(filenameToSessionId("abc.jsonl")).toBe("abc");
    expect(filenameToSessionId("session-a1b2c3.jsonl")).toBe("session-a1b2c3");
  });
});

describe("parseUriPath", () => {
  it("returns null for non-jsonl paths", () => {
    expect(parseUriPath("/foo/bar/baz.txt")).toBeNull();
  });

  it("extracts session id and project dir name", () => {
    const parsed = parseUriPath("/home/x/.claude/projects/-Users-x-proj/abc.jsonl");
    expect(parsed).not.toBeNull();
    expect(parsed!.sessionId).toBe("abc");
    expect(parsed!.projectDirName).toBe("-Users-x-proj");
  });

  it("handles UUID-style session ids", () => {
    const parsed = parseUriPath(
      "/p/-home-x-y/a6b4a8b9-58b3-4e09-b212-badeae366259.jsonl",
    );
    expect(parsed!.sessionId).toBe("a6b4a8b9-58b3-4e09-b212-badeae366259");
  });
});

describe("cwdForProjectDir", () => {
  it("reads the real cwd from a transcript (handles paths the lossy decoder mangled, e.g. hyphens/dots)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-proj-"));
    const realCwd = "/Users/me/Desktop/lead-pipeline.v2";
    fs.writeFileSync(
      path.join(dir, "abc.jsonl"),
      `${JSON.stringify({ type: "user", cwd: realCwd })}\n${JSON.stringify({ type: "assistant" })}\n`,
    );
    expect(cwdForProjectDir(dir)).toBe(realCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no transcript carries a cwd", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-proj-"));
    fs.writeFileSync(path.join(dir, "abc.jsonl"), `${JSON.stringify({ type: "assistant" })}\n`);
    expect(cwdForProjectDir(dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for a missing directory", () => {
    expect(cwdForProjectDir(path.join(os.tmpdir(), `nope-${Date.now()}`))).toBeNull();
  });
});

describe("discoverSessionRefs", () => {
  it("returns refs from all project subdirs", () => {
    const projA = path.join(PROJECTS_DIR, "-discover-a");
    const projB = path.join(PROJECTS_DIR, "-discover-b");
    fs.mkdirSync(projA, { recursive: true });
    fs.mkdirSync(projB, { recursive: true });
    fs.writeFileSync(path.join(projA, "s1.jsonl"), "");
    fs.writeFileSync(path.join(projA, "s2.jsonl"), "");
    fs.writeFileSync(path.join(projB, "s3.jsonl"), "");
    fs.writeFileSync(path.join(projB, "not-a-session.txt"), "");

    const refs = discoverSessionRefs();
    const ids = new Set(refs.map((r) => r.sessionId));
    expect(ids.has("s1")).toBe(true);
    expect(ids.has("s2")).toBe(true);
    expect(ids.has("s3")).toBe(true);
    for (const r of refs) {
      expect(r.filePath.endsWith(".jsonl")).toBe(true);
    }
  });

  it("returns empty array when projects dir missing", () => {
    const tmp = path.join(PROJECTS_DIR, "..", `nonexistent-${Date.now()}`);
    const prevEnv = process.env["CLAUDE_TRACE_PROJECTS_DIR"];
    process.env["CLAUDE_TRACE_PROJECTS_DIR"] = tmp;
    expect(() => discoverSessionRefs()).not.toThrow();
    process.env["CLAUDE_TRACE_PROJECTS_DIR"] = prevEnv;
  });
});

import { isHiddenAssistantProject } from "../../../src/features/dashboard/infra/paths";

describe("isHiddenAssistantProject", () => {
  it("hides assistant-spawned project dirs (regression: assistant sessions polluted the sidebar)", () => {
    expect(isHiddenAssistantProject("-Users-alex--claude-trace-library-assistant-skill-code-review")).toBe(true);
    expect(isHiddenAssistantProject("-Users-alex--claude-trace-library-assistant-agent-reviewer")).toBe(true);
  });

  it("does NOT hide normal project dirs", () => {
    expect(isHiddenAssistantProject("-Users-alex-Desktop-my-api")).toBe(false);
    expect(isHiddenAssistantProject("-home-user-projects-claude-trace")).toBe(false);
    expect(isHiddenAssistantProject("-Users-alex--claude-trace")).toBe(false);
  });
});
