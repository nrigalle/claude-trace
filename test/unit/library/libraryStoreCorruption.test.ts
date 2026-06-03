import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LibraryStore } from "../../../src/features/library/infra/LibraryStore";

let tmpDir: string;
let store: LibraryStore;

const corruptBackups = (dir: string, base: string): string[] =>
  fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.corrupt-`));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "library-corrupt-test-"));
  store = new LibraryStore(path.join(tmpDir, "library"));
  store.ensureDirs();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("LibraryStore corruption guard", () => {
  it("preserves a corrupt projects file as a backup instead of letting the next write clobber it", () => {
    const file = store.pathsInfo.projectsFile;
    fs.writeFileSync(file, "{ not valid json", "utf8");

    expect(store.listProjects()).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    expect(corruptBackups(path.dirname(file), "projects.json")).toHaveLength(1);
  });

  it("preserves a corrupt assignments file as a backup and returns empty assignments", () => {
    const file = store.pathsInfo.assignmentsFile;
    fs.writeFileSync(file, "}}garbage{{", "utf8");

    const assignments = store.readAssignments();
    expect(assignments.skills).toEqual({});
    expect(assignments.agents).toEqual({});
    expect(fs.existsSync(file)).toBe(false);
    expect(corruptBackups(path.dirname(file), "assignments.json")).toHaveLength(1);
  });

  it("does not create a backup when the file is simply absent", () => {
    const file = store.pathsInfo.projectsFile;
    expect(store.listProjects()).toEqual([]);
    expect(corruptBackups(path.dirname(file), "projects.json")).toHaveLength(0);
  });
});
