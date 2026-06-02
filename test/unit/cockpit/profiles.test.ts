import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MAX_BATCH,
  batchNames,
  clampCount,
  defaultProfile,
  expandNameTemplate,
  nextTabName,
  stripTabSuffix,
  toProfileId,
  validateProfile,
} from "../../../src/features/cockpit/domain/profiles";

describe("clampCount", () => {
  it("keeps counts inside [1, MAX_BATCH]", () => {
    fc.assert(
      fc.property(fc.integer({ min: -50, max: 50 }), (n) => {
        const c = clampCount(n);
        return c >= 1 && c <= MAX_BATCH;
      }),
    );
  });

  it("floors fractional counts and rejects NaN", () => {
    expect(clampCount(3.9)).toBe(3);
    expect(clampCount(0)).toBe(1);
    expect(clampCount(Number.NaN)).toBe(1);
    expect(clampCount(999)).toBe(MAX_BATCH);
  });
});

describe("expandNameTemplate", () => {
  it("substitutes {profile} and {n}", () => {
    expect(expandNameTemplate("{profile} {n}", { profileName: "Review", index: 3 })).toBe("Review 3");
  });

  it("leaves unknown tokens untouched", () => {
    expect(expandNameTemplate("{profile}-{branch}", { profileName: "x", index: 1 })).toBe("x-{branch}");
  });

  it("supports templates without {n}", () => {
    expect(expandNameTemplate("{profile}", { profileName: "Solo", index: 7 })).toBe("Solo");
  });
});

describe("batchNames", () => {
  it("produces count names with consecutive indices from startIndex", () => {
    expect(batchNames("{profile} {n}", "Crit", 3)).toEqual(["Crit 1", "Crit 2", "Crit 3"]);
    expect(batchNames("{profile} {n}", "Crit", 2, 5)).toEqual(["Crit 5", "Crit 6"]);
  });

  it("clamps the batch size to MAX_BATCH", () => {
    expect(batchNames("{profile} {n}", "P", 100)).toHaveLength(MAX_BATCH);
  });

  it("never emits duplicate names when the template includes {n}", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: MAX_BATCH }),
        (profileName, count) => {
          const names = batchNames("{profile} {n}", profileName, count);
          return new Set(names).size === names.length;
        },
      ),
    );
  });
});

describe("nextTabName", () => {
  it("starts at · 2 for the first added tab", () => {
    expect(nextTabName(["Rev 1"], "Rev 1")).toBe("Rev 1 · 2");
  });

  it("increments to · 3, · 4 as more tabs exist (not stuck at · 2)", () => {
    expect(nextTabName(["Rev 1", "Rev 1 · 2"], "Rev 1")).toBe("Rev 1 · 3");
    expect(nextTabName(["Rev 1", "Rev 1 · 2", "Rev 1 · 3"], "Rev 1")).toBe("Rev 1 · 4");
  });

  it("uses the highest existing index so it never collides after a middle tab is closed", () => {
    expect(nextTabName(["Rev 1", "Rev 1 · 4"], "Rev 1")).toBe("Rev 1 · 5");
  });

  it("strips an existing suffix from the template so a closed base never yields a double suffix", () => {
    expect(nextTabName(["Rev 1 · 2", "Rev 1 · 3"], "Rev 1 · 2")).toBe("Rev 1 · 4");
  });

  it("treats a name that ends in non-numeric text after the separator as the base", () => {
    expect(stripTabSuffix("Build · prod")).toBe("Build · prod");
    expect(nextTabName(["Build · prod"], "Build · prod")).toBe("Build · prod · 2");
  });
});

describe("validateProfile", () => {
  const ok = defaultProfile(toProfileId("p1"), "My profile");

  it("accepts a well-formed profile", () => {
    expect(validateProfile(ok)).toEqual([]);
  });

  it("flags an empty name", () => {
    expect(validateProfile({ ...ok, name: "   " }).map((e) => e.field)).toContain("name");
  });

  it("flags an empty name template", () => {
    expect(validateProfile({ ...ok, nameTemplate: "" }).map((e) => e.field)).toContain("nameTemplate");
  });

  it("flags an out-of-range count", () => {
    expect(validateProfile({ ...ok, defaultCount: 0 }).map((e) => e.field)).toContain("defaultCount");
    expect(validateProfile({ ...ok, defaultCount: MAX_BATCH + 1 }).map((e) => e.field)).toContain("defaultCount");
  });
});
