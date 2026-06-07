import { describe, expect, it } from "vitest";
import {
  READ_ONLY_DENY_MATCHER,
  READ_ONLY_TOOLS,
  copyPastePromptProtocol,
  roleAnchor,
  type AssistantRole,
} from "../../../src/shared/assistant/readOnlyAssistant";

const role: AssistantRole = { label: "Test Builder", deliverable: "a JSON block" };

describe("read-only assistant policy", () => {
  it("the read tool set is exactly read/search tools — no Edit/Write/Bash", () => {
    expect([...READ_ONLY_TOOLS]).toEqual(["Read", "Grep", "Glob", "WebSearch", "WebFetch"]);
  });

  it("the deny matcher covers every built-in write/exec tool", () => {
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "PowerShell", "Monitor"]) {
      expect(READ_ONLY_DENY_MATCHER).toContain(tool);
    }
  });

  it("the per-turn role anchor states it is read-only and routes repo changes to a separate session", () => {
    const anchor = roleAnchor(role);
    expect(anchor).toMatch(/read-only/i);
    expect(anchor).toContain("Test Builder");
    expect(anchor).toContain("a JSON block");
    expect(anchor).toMatch(/separate Claude Code session/i);
  });

  it("the copy-paste protocol names the read tools and the paste-ready ```text block", () => {
    const protocol = copyPastePromptProtocol(role);
    expect(protocol).toContain("Read, Grep, Glob, WebSearch, WebFetch");
    expect(protocol).toContain("```text");
    expect(protocol).toMatch(/separate Claude Code session/i);
  });
});
