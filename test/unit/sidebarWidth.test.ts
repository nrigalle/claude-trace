import { describe, expect, it } from "vitest";
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_PX,
  SIDEBAR_MAX_PX,
  SIDEBAR_MIN_PX,
} from "../../media/src/ui/layout/sidebarWidth";

describe("clampSidebarWidth", () => {
  it("returns the default for non-finite input", () => {
    expect(clampSidebarWidth(undefined)).toBe(SIDEBAR_DEFAULT_PX);
    expect(clampSidebarWidth(null)).toBe(SIDEBAR_DEFAULT_PX);
    expect(clampSidebarWidth("300")).toBe(SIDEBAR_DEFAULT_PX);
    expect(clampSidebarWidth(NaN)).toBe(SIDEBAR_DEFAULT_PX);
    expect(clampSidebarWidth(Infinity)).toBe(SIDEBAR_DEFAULT_PX);
  });

  it("clamps below the minimum", () => {
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_MIN_PX);
    expect(clampSidebarWidth(50)).toBe(SIDEBAR_MIN_PX);
    expect(clampSidebarWidth(SIDEBAR_MIN_PX - 1)).toBe(SIDEBAR_MIN_PX);
  });

  it("clamps above the maximum", () => {
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_PX);
    expect(clampSidebarWidth(SIDEBAR_MAX_PX + 1)).toBe(SIDEBAR_MAX_PX);
  });

  it("returns rounded value within bounds", () => {
    expect(clampSidebarWidth(300)).toBe(300);
    expect(clampSidebarWidth(347.7)).toBe(348);
  });

  it("respects published bounds (240..560 inclusive)", () => {
    expect(SIDEBAR_MIN_PX).toBe(240);
    expect(SIDEBAR_MAX_PX).toBe(560);
    expect(SIDEBAR_DEFAULT_PX).toBe(300);
  });
});
