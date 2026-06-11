import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_CHOICE, MODEL_CHOICES, modelChoiceFromId } from "../../../src/shared/models";

describe("modelChoiceFromId — resume restores the model a session was created with", () => {
  it("maps a bare transcript model id straight to its ModelChoice", () => {
    expect(modelChoiceFromId("claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(modelChoiceFromId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("matches a dated/suffixed transcript id by its base prefix without bleeding into a sibling version", () => {
    expect(modelChoiceFromId("claude-opus-4-7-20260114")).toBe("claude-opus-4-7");
    expect(modelChoiceFromId("claude-opus-4-8-20260101")).toBe("claude-opus-4-8");
  });

  it("preserves the 1M context variant when the id signals it", () => {
    expect(modelChoiceFromId("claude-opus-4-8[1m]")).toBe("claude-opus-4-8[1m]");
    expect(modelChoiceFromId("claude-sonnet-4-6-1m")).toBe("claude-sonnet-4-6[1m]");
  });

  it("falls back to the default only for unknown or missing ids", () => {
    expect(modelChoiceFromId(null)).toBe(DEFAULT_MODEL_CHOICE);
    expect(modelChoiceFromId(undefined)).toBe(DEFAULT_MODEL_CHOICE);
    expect(modelChoiceFromId("")).toBe(DEFAULT_MODEL_CHOICE);
    expect(modelChoiceFromId("gpt-4o")).toBe(DEFAULT_MODEL_CHOICE);
  });

  it("never returns a value outside the known ModelChoice set", () => {
    for (const raw of ["claude-opus-4-7", "claude-fable-5", "claude-haiku-4-5", "weird", "claude-opus-4-8[1m]"]) {
      expect(MODEL_CHOICES).toContain(modelChoiceFromId(raw));
    }
  });
});
