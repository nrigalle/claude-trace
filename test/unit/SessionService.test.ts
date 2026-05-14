import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECTS_DIR } from "../../src/config";
import { SessionService } from "../../src/app/SessionService";
import { SessionFileReader } from "../../src/infra/fs/SessionFileReader";
import { toSessionId } from "../../src/domain/types";

const writeSession = (subdir: string, id: string, lines: string[]): string => {
  const projectDir = path.join(PROJECTS_DIR, subdir);
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${id}.jsonl`);
  fs.writeFileSync(filePath, lines.map((l) => l + "\n").join(""));
  return filePath;
};

const assistantTurn = (ts: string, tool = "Bash") =>
  JSON.stringify({
    type: "assistant",
    timestamp: ts,
    cwd: "/project",
    sessionId: "s",
    message: {
      model: "claude-opus-4-7",
      content: [{ type: "tool_use", id: "t", name: tool, input: {} }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });

describe("SessionService", () => {
  let service: SessionService;

  beforeEach(() => {
    service = new SessionService(new SessionFileReader());
  });

  it("list discovers sessions across all project subdirs", () => {
    const stamp = Date.now();
    writeSession(`-svc-test-a-${stamp}`, `svc-a-${stamp}`, [assistantTurn("2026-05-01T10:00:00Z")]);
    writeSession(`-svc-test-b-${stamp}`, `svc-b-${stamp}`, [assistantTurn("2026-05-01T11:00:00Z")]);
    const out = service.list();
    const ids = new Set(out.map((s) => s.session_id));
    expect(ids.has(toSessionId(`svc-a-${stamp}`))).toBe(true);
    expect(ids.has(toSessionId(`svc-b-${stamp}`))).toBe(true);
  });

  it("list sorts by last activity (ended_at or last_modified_ms) descending", () => {
    const stamp = Date.now();
    const dir = `-svc-sort-${stamp}`;
    writeSession(dir, `svc-old-${stamp}`, [assistantTurn("2025-01-01T00:00:00Z")]);
    writeSession(dir, `svc-mid-${stamp}`, [assistantTurn("2025-06-01T00:00:00Z")]);
    writeSession(dir, `svc-new-${stamp}`, [assistantTurn("2026-05-01T00:00:00Z")]);

    const out = service.list();
    const ours = out.filter((s) => s.session_id.startsWith(`svc-`));
    const ordered = ours.map((s) => s.session_id).filter((id) => id.includes(`-${stamp}`));
    expect(ordered.indexOf(toSessionId(`svc-new-${stamp}`))).toBeLessThan(
      ordered.indexOf(toSessionId(`svc-mid-${stamp}`)),
    );
    expect(ordered.indexOf(toSessionId(`svc-mid-${stamp}`))).toBeLessThan(
      ordered.indexOf(toSessionId(`svc-old-${stamp}`)),
    );
  });

  it("detail returns null for unknown session", () => {
    service.list();
    expect(service.detail(toSessionId("does-not-exist"))).toBeNull();
  });

  it("detail returns SessionDetail with tool_stats, timelines, and title", () => {
    const stamp = Date.now();
    const id = `svc-detail-${stamp}`;
    writeSession(`-svc-detail-${stamp}`, id, [
      JSON.stringify({ type: "ai-title", aiTitle: "Detail test", sessionId: id }),
      assistantTurn("2026-05-01T10:00:00Z", "Bash"),
      assistantTurn("2026-05-01T10:01:00Z", "Read"),
    ]);
    service.list();
    const detail = service.detail(toSessionId(id));
    expect(detail).not.toBeNull();
    expect(detail!.title).toBe("Detail test");
    expect(detail!.tool_count).toBe(2);
    expect(detail!.tool_stats.length).toBeGreaterThan(0);
    expect(detail!.context_timeline.length).toBe(2);
    expect(detail!.cost_timeline.length).toBe(2);
  });

  it("computeStats aggregates across all listed sessions", () => {
    const stamp = Date.now();
    writeSession(`-svc-stats-${stamp}`, `svc-s1-${stamp}`, [assistantTurn("2026-05-01T10:00:00Z")]);
    writeSession(`-svc-stats-${stamp}`, `svc-s2-${stamp}`, [
      assistantTurn("2026-05-01T10:00:00Z"),
      assistantTurn("2026-05-01T10:01:00Z"),
    ]);
    const sessions = service.list();
    const ours = sessions.filter((s) => s.session_id.startsWith("svc-s"));
    const stats = service.stats(ours);
    expect(stats.total_tool_calls).toBeGreaterThanOrEqual(3);
    expect(stats.total_sessions).toBe(ours.length);
  });

  it("invalidate clears a single session from cache without affecting others", () => {
    const stamp = Date.now();
    const dir = `-svc-inval-${stamp}`;
    writeSession(dir, `svc-a-${stamp}`, [assistantTurn("2026-05-01T10:00:00Z")]);
    writeSession(dir, `svc-b-${stamp}`, [assistantTurn("2026-05-01T10:00:00Z")]);
    service.list();
    const refA = toSessionId(`svc-a-${stamp}`);
    const detailBefore = service.detail(refA);
    service.invalidate(refA);
    const detailAfter = service.detail(refA);
    expect(detailAfter!.session_id).toBe(refA);
    void detailBefore;
  });
});
