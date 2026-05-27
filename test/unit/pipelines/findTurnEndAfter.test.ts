import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findTurnEndAfter } from "../../../src/features/pipelines/infra/RealAutomationRunner";

let tmpJsonl: string;

beforeEach(() => {
  tmpJsonl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claude-turnend-")), "session.jsonl");
});

afterEach(() => {
  try { fs.rmSync(path.dirname(tmpJsonl), { recursive: true, force: true }); } catch {}
});

const write = (events: unknown[]): void => {
  fs.writeFileSync(tmpJsonl, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
};

describe("findTurnEndAfter — must read stop_reason from message.stop_reason (real Claude event shape)", () => {
  it("returns true for an assistant event with message.stop_reason='end_turn' after sinceMs", () => {
    const sinceMs = Date.parse("2026-05-22T13:28:00.000Z");
    write([
      {
        parentUuid: "p1",
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Do less. Achieve more." }], stop_reason: "end_turn" },
        timestamp: "2026-05-22T13:28:03.305Z",
        sessionId: "s",
      },
    ]);
    expect(findTurnEndAfter(tmpJsonl, sinceMs)).toBe(true);
  });

  it("returns false when the only assistant event has stop_reason='tool_use' — claude is mid-tool, not done", () => {
    const sinceMs = Date.parse("2026-05-22T13:28:00.000Z");
    write([
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use" }], stop_reason: "tool_use" },
        timestamp: "2026-05-22T13:28:03.305Z",
      },
    ]);
    expect(findTurnEndAfter(tmpJsonl, sinceMs)).toBe(false);
  });

  it("returns true when a tool-using turn is followed by a final assistant message with end_turn", () => {
    const sinceMs = Date.parse("2026-05-22T13:28:00.000Z");
    write([
      { type: "assistant", message: { stop_reason: "tool_use" }, timestamp: "2026-05-22T13:28:03.000Z" },
      { type: "user", message: { role: "user", content: [{ type: "tool_result" }] }, timestamp: "2026-05-22T13:28:04.000Z" },
      { type: "assistant", message: { stop_reason: "end_turn" }, timestamp: "2026-05-22T13:28:05.000Z" },
    ]);
    expect(findTurnEndAfter(tmpJsonl, sinceMs)).toBe(true);
  });

  it("ignores events that pre-date sinceMs — the previous turn doesn't count", () => {
    const sinceMs = Date.parse("2026-05-22T13:30:00.000Z");
    write([
      { type: "assistant", message: { stop_reason: "end_turn" }, timestamp: "2026-05-22T13:28:00.000Z" },
    ]);
    expect(findTurnEndAfter(tmpJsonl, sinceMs)).toBe(false);
  });

  it("every documented turn-end stop_reason from https://platform.claude.com/docs/en/api/handling-stop-reasons triggers detection", () => {
    const sinceMs = Date.parse("2026-05-22T13:28:00.000Z");
    const turnEndReasons = ["end_turn", "stop_sequence", "max_tokens", "refusal", "model_context_window_exceeded"];
    for (const reason of turnEndReasons) {
      write([{ type: "assistant", message: { stop_reason: reason }, timestamp: "2026-05-22T13:28:10.000Z" }]);
      expect(findTurnEndAfter(tmpJsonl, sinceMs), `${reason} must be detected as turn end`).toBe(true);
    }
  });

  it("documented mid-turn stop_reasons (tool_use, pause_turn) are NOT treated as turn end — claude has more work to do", () => {
    const sinceMs = Date.parse("2026-05-22T13:28:00.000Z");
    const midTurnReasons = ["tool_use", "pause_turn"];
    for (const reason of midTurnReasons) {
      write([{ type: "assistant", message: { stop_reason: reason }, timestamp: "2026-05-22T13:28:10.000Z" }]);
      expect(findTurnEndAfter(tmpJsonl, sinceMs), `${reason} must NOT be detected as turn end`).toBe(false);
    }
  });

  it("tolerates top-level stop_reason (synthetic test/mock format) as well as nested message.stop_reason", () => {
    const sinceMs = Date.parse("2026-05-22T13:28:00.000Z");
    write([
      { type: "Stop", stop_reason: "end_turn", ts: Date.parse("2026-05-22T13:28:10.000Z") },
    ]);
    expect(findTurnEndAfter(tmpJsonl, sinceMs)).toBe(true);
  });

  it("returns false when the file does not exist (no crash)", () => {
    expect(findTurnEndAfter("/tmp/does-not-exist-" + Date.now() + ".jsonl", 0)).toBe(false);
  });

  it("skips lines that are not valid JSON without throwing", () => {
    fs.writeFileSync(tmpJsonl, 'not-json\n{"type":"assistant","message":{"stop_reason":"end_turn"},"timestamp":"2026-05-22T13:28:10.000Z"}\nbroken-too\n');
    expect(findTurnEndAfter(tmpJsonl, 0)).toBe(true);
  });

  it("regression: the exact event shape Claude Code v2.1.148 writes — top-level type=assistant with stop_reason nested under message — is detected", () => {
    const sinceMs = Date.parse("2026-05-22T13:28:00.000Z");
    write([
      {
        parentUuid: "9b40b93a-6448-4ff2-815c-1ca63b8e8e4e",
        isSidechain: false,
        message: {
          model: "claude-sonnet-4-6",
          id: "msg_013thsVPhus5Eh7Ar4oSxYAE",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Do less. Achieve more. Stay in focus." }],
          stop_reason: "end_turn",
        },
        requestId: "req_011CbHgiV8fBCuwFzHwo3dBE",
        type: "assistant",
        uuid: "6e25b15f-b53b-47aa-9d0d-5ec55090a73a",
        timestamp: "2026-05-22T13:28:03.305Z",
        sessionId: "f8b71c44-1194-4e3b-b3e2-2b0e9ae6786e",
      },
    ]);
    expect(findTurnEndAfter(tmpJsonl, sinceMs)).toBe(true);
  });
});
