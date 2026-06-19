import { describe, it, expect } from "vitest";
import { stripTerminalReports } from "../../../media/src/cockpit/cockpitUtils";

describe("stripTerminalReports", () => {
  it("removes primary and secondary device-attribute replies", () => {
    expect(stripTerminalReports("\x1b[?1;2c")).toBe("");
    expect(stripTerminalReports("\x1b[>0;276;0c")).toBe("");
    expect(stripTerminalReports("\x1b[?1;2c\x1b[>0;276;0c")).toBe("");
  });

  it("removes cursor-position and device-status reports", () => {
    expect(stripTerminalReports("\x1b[24;80R")).toBe("");
    expect(stripTerminalReports("\x1b[0n")).toBe("");
  });

  it("removes DCS device reports (DA3 / XTVERSION)", () => {
    expect(stripTerminalReports("\x1bP!|00000000\x1b\\")).toBe("");
    expect(stripTerminalReports("\x1bP>|xterm(276)\x1b\\")).toBe("");
  });

  it("keeps real keystrokes, control chars, and pasted text", () => {
    expect(stripTerminalReports("ls -la\r")).toBe("ls -la\r");
    expect(stripTerminalReports("\x15")).toBe("\x15");
    expect(stripTerminalReports("a\x1b[?1;2cb")).toBe("ab");
  });

  it("does not touch the device-attribute query forms a user could conceivably emit", () => {
    expect(stripTerminalReports("\x1b[c")).toBe("\x1b[c");
    expect(stripTerminalReports("\x1b[0c")).toBe("\x1b[0c");
  });
});
