import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const MAX_LINES = 800;
const ROOTS = [
  path.join(__dirname, "..", "..", "..", "src"),
  path.join(__dirname, "..", "..", "..", "media", "src"),
];

const listSourceFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
};

describe("architecture — source file size", () => {
  it(`no source file exceeds ${MAX_LINES} lines — split cohesive modules out instead of growing files`, () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of listSourceFiles(root)) {
        const lines = fs.readFileSync(file, "utf8").split("\n").length;
        if (lines > MAX_LINES) {
          offenders.push(`${path.relative(path.join(root, "..", ".."), file)} (${lines})`);
        }
      }
    }
    expect(
      offenders,
      `These files exceed the ${MAX_LINES}-line cap. Extract cohesive collaborators into sibling modules (behavior-preserving, DOM/CSS identical) — do not raise the cap.`,
    ).toEqual([]);
  });
});
