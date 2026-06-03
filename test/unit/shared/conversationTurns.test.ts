import { describe, expect, it } from "vitest";
import {
  INTERNAL_MESSAGE_MARKER,
  extractConversationTurns,
  wrapSessionContext,
} from "../../../src/shared/assistant/conversationTurns";

const line = (obj: unknown): string => JSON.stringify(obj) + "\n";

describe("extractConversationTurns — replay reconstructs user prompts AND assistant turns", () => {
  it("keeps the user's prompt as its own turn (the bug: prompts used to vanish on replay)", () => {
    const chunk =
      line({ type: "user", message: { role: "user", content: "extract LUTs for n12hvt" } }) +
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "On it." }] } });
    const turns = extractConversationTurns(chunk);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({ role: "user", text: "extract LUTs for n12hvt", events: [] });
    expect(turns[1]!.role).toBe("assistant");
    expect(turns[1]!.events.some((e) => e.kind === "text" && e.text === "On it.")).toBe(true);
  });

  it("folds tool_use + tool_result into the assistant turn, not a spurious user turn", () => {
    const chunk =
      line({ type: "user", message: { role: "user", content: "go" } }) +
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "x" } }] } }) +
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] } }) +
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
    const turns = extractConversationTurns(chunk);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    const events = turns[1]!.events;
    expect(events.some((e) => e.kind === "tool_use" && e.name === "Read")).toBe(true);
    expect(events.some((e) => e.kind === "tool_result" && e.toolUseId === "t1")).toBe(true);
    expect(events.some((e) => e.kind === "text" && e.text === "done")).toBe(true);
  });

  it("reconstructs multiple alternating turns in order", () => {
    const chunk =
      line({ type: "user", message: { role: "user", content: "first" } }) +
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "reply 1" }] } }) +
      line({ type: "user", message: { role: "user", content: "second" } }) +
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "reply 2" }] } });
    const turns = extractConversationTurns(chunk);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(turns[0]!.text).toBe("first");
    expect(turns[2]!.text).toBe("second");
  });

  it("handles a user prompt given as text blocks (not a bare string)", () => {
    const chunk = line({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "blocky prompt" }] },
    });
    const turns = extractConversationTurns(chunk);
    expect(turns).toEqual([{ role: "user", text: "blocky prompt", events: [] }]);
  });

  it("strips the fresh internal context wrapper from replayed user prompts", () => {
    const chunk = line({
      type: "user",
      message: { role: "user", content: `${wrapSessionContext("<current_body>\nold body\n</current_body>")}\n\nplease improve it` },
    });
    const turns = extractConversationTurns(chunk);
    expect(turns).toEqual([{ role: "user", text: "please improve it", events: [] }]);
  });

  it("hides internal correction prompts from replay", () => {
    const chunk =
      line({ type: "user", message: { role: "user", content: `${INTERNAL_MESSAGE_MARKER}retry as JSON` } }) +
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "fixed" }] } });
    const turns = extractConversationTurns(chunk);
    expect(turns.map((t) => t.role)).toEqual(["assistant"]);
    expect(turns[0]!.events).toEqual([{ kind: "text", text: "fixed" }]);
  });
});
