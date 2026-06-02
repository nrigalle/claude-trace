import { describe, expect, it } from "vitest";
import { EFFORT_OPTIONS } from "../../../src/features/pipelines/domain/thinkingLevels";

describe("EFFORT_OPTIONS catalog", () => {
  it("lists exactly the four levels in escalating order", () => {
    expect(EFFORT_OPTIONS.map((o) => o.id)).toEqual(["low", "medium", "high", "max"]);
  });
});
