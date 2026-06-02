import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ImportScanner } from "../../../src/features/library/infra/ImportScanner";
import { LibraryStore } from "../../../src/features/library/infra/LibraryStore";
import { Materializer } from "../../../src/features/library/infra/Materializer";
import { LibraryImporter } from "../../../src/features/library/infra/LibraryImporter";
import { LibraryController } from "../../../src/features/library/app/LibraryController";
import type {
  LibraryHostToWebview,
  LibraryWebviewToHost,
} from "../../../src/features/library/protocol";
import { toProjectPath, toSkillName, toAgentName, type ProjectEntry } from "../../../src/features/library/domain/types";

let tmpDir: string;
let libraryRoot: string;
let globalRoot: string;
let projectRoot: string;
let sent: LibraryHostToWebview[];
let controller: LibraryController;
let onMessage: ((m: LibraryWebviewToHost) => void) | null;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "library-import-test-"));
  libraryRoot = path.join(tmpDir, "library");
  globalRoot = path.join(tmpDir, "home", ".claude");
  projectRoot = path.join(tmpDir, "projects", "webapp");
  fs.mkdirSync(projectRoot, { recursive: true });

  sent = [];
  onMessage = null;

  const store = new LibraryStore(libraryRoot);
  store.ensureDirs();
  const materializer = new Materializer(store, { globalRoot });
  const scanner = new ImportScanner({ globalRoot });
  const importer = new LibraryImporter(store);
  controller = new LibraryController({
    host: {
      postMessage: (m) => sent.push(m),
      onMessage: (listener) => {
        onMessage = listener;
        return { dispose: () => {} };
      },
    },
    store,
    materializer,
    scanner,
    importer,
    actions: {
      pickProjectFolder: async () => null,
      showInfo: () => {},
      showWarning: () => {},
      showError: () => {},
      workspaceProjects: (): readonly ProjectEntry[] => [
        { path: toProjectPath(projectRoot), label: "webapp", source: "workspace" },
      ],
      trackedProjects: (): readonly ProjectEntry[] => [],
      openLibraryDir: () => {},
    },
  });
});

afterEach(() => {
  controller.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const writeSkillAt = (root: string, name: string, frontmatter: string, body: string): void => {
  const dir = path.join(root, ".claude", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`, "utf8");
};

const writeGlobalSkill = (name: string, frontmatter: string, body: string): void => {
  const dir = path.join(globalRoot, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`, "utf8");
};

const writeGlobalAgent = (name: string, frontmatter: string, body: string): void => {
  const dir = path.join(globalRoot, "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\n${frontmatter}\n---\n${body}`, "utf8");
};

const lastSnapshot = (): LibraryHostToWebview & { type: "librarySnapshot" } => {
  const snapshots = sent.filter((m): m is LibraryHostToWebview & { type: "librarySnapshot" } => m.type === "librarySnapshot");
  return snapshots[snapshots.length - 1]!;
};

const lastCandidates = (): readonly Awaited<ReturnType<ImportScanner["scan"]>>[number][] => {
  const lists = sent.filter((m): m is LibraryHostToWebview & { type: "libraryImportCandidates" } => m.type === "libraryImportCandidates");
  return lists[lists.length - 1]!.candidates;
};

describe("Bulk delete (host path: controller to store to snapshot)", () => {
  it("deleteSkillsBulk removes every named skill, leaving the rest in the next snapshot", () => {
    onMessage!({ type: "ready" });
    onMessage!({ type: "createSkill", name: "code-review" });
    onMessage!({ type: "createSkill", name: "lint" });
    onMessage!({ type: "createSkill", name: "keep" });
    expect(lastSnapshot().snapshot.skills.map((s) => s.name as string).sort()).toEqual(["code-review", "keep", "lint"]);

    onMessage!({ type: "deleteSkillsBulk", names: [toSkillName("code-review"), toSkillName("lint")] });

    expect(lastSnapshot().snapshot.skills.map((s) => s.name as string)).toEqual(["keep"]);
  });

  it("deleteAgentsBulk removes every named agent", () => {
    onMessage!({ type: "ready" });
    onMessage!({ type: "createAgent", name: "reviewer" });
    onMessage!({ type: "createAgent", name: "planner" });
    expect(lastSnapshot().snapshot.agents.map((a) => a.name as string).sort()).toEqual(["planner", "reviewer"]);

    onMessage!({ type: "deleteAgentsBulk", names: [toAgentName("reviewer"), toAgentName("planner")] });

    expect(lastSnapshot().snapshot.agents).toEqual([]);
  });
});

describe("Import preserves the original file content (regression: 'Imported from webapp' bug)", () => {
  it("imported skill keeps its real frontmatter body, NOT a placeholder", async () => {
    const realBody = "Use this skill when reviewing pull requests.\nLook for: secret leaks, missing validation, error-handling holes.\n";
    writeGlobalSkill("code-review", "name: code-review\ndescription: Reviews diffs carefully", realBody);

    onMessage!({ type: "ready" });
    onMessage!({ type: "scanForImports" });
    const cands = lastCandidates();
    expect(cands).toHaveLength(1);
    onMessage!({ type: "importCandidates", items: cands });

    const snap = lastSnapshot();
    const skill = snap.snapshot.skills.find((s) => (s.name as string) === "code-review");
    expect(skill).toBeDefined();
    expect(skill!.body).toBe(realBody);
    expect(skill!.body).not.toContain("Imported from");
    expect(skill!.frontmatter["description"]).toBe("Reviews diffs carefully");
  });

  it("imported agent keeps its real system prompt body, NOT a placeholder", async () => {
    const realPrompt = "You are a senior reviewer. Speak plainly. Cite file:line. Suggest the smallest fix that works.\n";
    writeGlobalAgent("reviewer", "name: reviewer\ndescription: Senior reviewer persona", realPrompt);

    onMessage!({ type: "ready" });
    onMessage!({ type: "scanForImports" });
    const cands = lastCandidates();
    onMessage!({ type: "importCandidates", items: cands });

    const snap = lastSnapshot();
    const agent = snap.snapshot.agents.find((a) => (a.name as string) === "reviewer");
    expect(agent).toBeDefined();
    expect(agent!.body).toBe(realPrompt);
    expect(agent!.body).not.toContain("Imported from");
  });

  it("project-origin skill preserves its body just like a global one (the 'Imported from <project>' bug)", async () => {
    const realBody = "Project-specific instructions: tag releases as YYYY.MM.DD and update CHANGELOG.\n";
    writeSkillAt(projectRoot, "release-notes", "name: release-notes\ndescription: Drafts release notes", realBody);

    onMessage!({ type: "ready" });
    onMessage!({ type: "scanForImports" });
    onMessage!({ type: "importCandidates", items: lastCandidates() });

    const snap = lastSnapshot();
    const skill = snap.snapshot.skills.find((s) => (s.name as string) === "release-notes");
    expect(skill).toBeDefined();
    expect(skill!.body).toBe(realBody);
    expect(skill!.body).not.toContain("Imported from");
    expect(skill!.body).not.toMatch(/^Imported from\s+webapp/);
  });

  it("copies skill bundled resources (scripts, references) into the library", async () => {
    writeGlobalSkill("test-doctor", "name: test-doctor\ndescription: Triages failing tests", "Walk the failure.\n");
    const scriptsDir = path.join(globalRoot, "skills", "test-doctor", "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, "run-isolated.sh"), "#!/bin/sh\necho hi\n", "utf8");
    const refDir = path.join(globalRoot, "skills", "test-doctor", "references");
    fs.mkdirSync(refDir, { recursive: true });
    fs.writeFileSync(path.join(refDir, "guide.md"), "# guide\n", "utf8");
    const assetDir = path.join(globalRoot, "skills", "test-doctor", "assets");
    fs.mkdirSync(assetDir, { recursive: true });
    const asset = Buffer.from([0, 255, 10, 20, 30]);
    fs.writeFileSync(path.join(assetDir, "icon.bin"), asset);

    onMessage!({ type: "ready" });
    onMessage!({ type: "scanForImports" });
    onMessage!({ type: "importCandidates", items: lastCandidates() });

    const copied = path.join(libraryRoot, "skills", "test-doctor");
    expect(fs.existsSync(path.join(copied, "SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(copied, "scripts", "run-isolated.sh"), "utf8")).toContain("echo hi");
    expect(fs.readFileSync(path.join(copied, "references", "guide.md"), "utf8")).toContain("# guide");
    expect(fs.readFileSync(path.join(copied, "assets", "icon.bin"))).toEqual(asset);
  });

  it("skips an import when a library item with the same name already exists, and reports it", async () => {
    writeGlobalSkill("dup", "name: dup\ndescription: original", "first version body\n");
    onMessage!({ type: "ready" });
    onMessage!({ type: "scanForImports" });
    onMessage!({ type: "importCandidates", items: lastCandidates() });
    const firstSnap = lastSnapshot();
    expect(firstSnap.snapshot.skills.find((s) => (s.name as string) === "dup")?.body).toContain("first version body");

    fs.writeFileSync(
      path.join(globalRoot, "skills", "dup", "SKILL.md"),
      "---\nname: dup\ndescription: changed on disk\n---\nbrand new body\n",
      "utf8",
    );
    sent.length = 0;
    onMessage!({ type: "scanForImports" });
    onMessage!({ type: "importCandidates", items: lastCandidates() });
    const secondSnap = lastSnapshot();
    expect(secondSnap.snapshot.skills.find((s) => (s.name as string) === "dup")?.body).toContain("first version body");
    const warning = sent.find((m): m is LibraryHostToWebview & { type: "libraryNotice" } => m.type === "libraryNotice");
    expect(warning?.notice.level).toBe("warning");
    expect(warning?.notice.message).toContain("Skipped");
  });
});
