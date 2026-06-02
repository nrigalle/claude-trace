import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LibraryStore } from "../../../src/features/library/infra/LibraryStore";
import { Materializer } from "../../../src/features/library/infra/Materializer";
import {
  toAgentName,
  toProjectPath,
  toSkillName,
  type LibrarySnapshot,
} from "../../../src/features/library/domain/types";

let tmpDir: string;
let libraryRoot: string;
let globalRoot: string;
let projectRoot: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "library-test-"));
  libraryRoot = path.join(tmpDir, "library");
  globalRoot = path.join(tmpDir, "home", ".claude");
  projectRoot = path.join(tmpDir, "projects", "banking");
  fs.mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const makeSnapshot = (store: LibraryStore): LibrarySnapshot => ({
  skills: store.listSkills(),
  agents: store.listAgents(),
  projects: [],
});

describe("Materializer end-to-end", () => {
  it("writes a global skill to ~/.claude/skills/<name>/SKILL.md and tracks it in the manifest", () => {
    const store = new LibraryStore(libraryRoot);
    store.ensureDirs();
    store.writeSkill(
      toSkillName("code-review"),
      { name: "code-review", description: "Reviews diffs" },
      "Use me when reviewing PRs.\n",
    );
    store.setSkillScope(toSkillName("code-review"), { kind: "global" });

    const materializer = new Materializer(store, { globalRoot });
    materializer.syncAll(makeSnapshot(store));

    const target = path.join(globalRoot, "skills", "code-review", "SKILL.md");
    expect(fs.existsSync(target)).toBe(true);
    const content = fs.readFileSync(target, "utf8");
    expect(content).toContain("name: code-review");
    expect(content).toContain("Reviews diffs");

    const manifest = path.join(globalRoot, ".trace-manifest.json");
    expect(fs.existsSync(manifest)).toBe(true);
    const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
    expect(m.skills["code-review"]).toBeDefined();
  });

  it("writes project-scoped skills only into that project", () => {
    const store = new LibraryStore(libraryRoot);
    store.ensureDirs();
    store.writeSkill(
      toSkillName("lint"),
      { name: "lint", description: "Lints" },
      "Use me for linting.\n",
    );
    store.setSkillScope(toSkillName("lint"), {
      kind: "projects",
      paths: [toProjectPath(projectRoot)],
    });

    const materializer = new Materializer(store, { globalRoot });
    materializer.syncAll(makeSnapshot(store));

    expect(fs.existsSync(path.join(projectRoot, ".claude", "skills", "lint", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(globalRoot, "skills", "lint", "SKILL.md"))).toBe(false);
  });

  it("removes the skill from a target when the assignment is unassigned later, but does not touch foreign files", () => {
    const store = new LibraryStore(libraryRoot);
    store.ensureDirs();
    store.writeSkill(
      toSkillName("temp"),
      { name: "temp", description: "" },
      "temp body\n",
    );
    store.setSkillScope(toSkillName("temp"), { kind: "global" });
    const materializer = new Materializer(store, { globalRoot });
    materializer.syncAll(makeSnapshot(store));

    const foreignFile = path.join(globalRoot, "skills", "user-private", "SKILL.md");
    fs.mkdirSync(path.dirname(foreignFile), { recursive: true });
    fs.writeFileSync(foreignFile, "user owns this", "utf8");

    store.setSkillScope(toSkillName("temp"), { kind: "unassigned" });
    materializer.syncAll(makeSnapshot(store));

    expect(fs.existsSync(path.join(globalRoot, "skills", "temp", "SKILL.md"))).toBe(false);
    expect(fs.existsSync(foreignFile)).toBe(true);
    expect(fs.readFileSync(foreignFile, "utf8")).toBe("user owns this");
  });

  it("preserves user edits to a foreign file even after multiple sync rounds", () => {
    const store = new LibraryStore(libraryRoot);
    store.ensureDirs();
    const materializer = new Materializer(store, { globalRoot });

    const foreignAgent = path.join(globalRoot, "agents", "user-agent.md");
    fs.mkdirSync(path.dirname(foreignAgent), { recursive: true });
    fs.writeFileSync(foreignAgent, "---\nname: user-agent\n---\nuser-body", "utf8");

    store.writeAgent(toAgentName("trace-agent"), { name: "trace-agent" }, "trace body");
    store.setAgentScope(toAgentName("trace-agent"), { kind: "global" });

    materializer.syncAll(makeSnapshot(store));
    materializer.syncAll(makeSnapshot(store));
    materializer.syncAll(makeSnapshot(store));

    expect(fs.existsSync(foreignAgent)).toBe(true);
    expect(fs.readFileSync(foreignAgent, "utf8")).toBe("---\nname: user-agent\n---\nuser-body");
  });

  it("attached skills land as native skills: list in the agent's frontmatter", () => {
    const store = new LibraryStore(libraryRoot);
    store.ensureDirs();
    store.writeSkill(toSkillName("lint"), { name: "lint" }, "lint body");
    store.setSkillScope(toSkillName("lint"), { kind: "global" });
    store.writeAgent(toAgentName("reviewer"), { name: "reviewer" }, "prompt");
    store.setAgentScope(toAgentName("reviewer"), { kind: "global" });
    store.setAgentAttachedSkills(toAgentName("reviewer"), [toSkillName("lint")]);

    const materializer = new Materializer(store, { globalRoot });
    materializer.syncAll(makeSnapshot(store));

    const written = fs.readFileSync(
      path.join(globalRoot, "agents", "reviewer.md"),
      "utf8",
    );
    expect(written).toContain("skills:");
    expect(written).toContain("lint");
  });

  it("removeFromTarget cleans only manifest-tracked files (chezmoi uninstall pattern)", () => {
    const store = new LibraryStore(libraryRoot);
    store.ensureDirs();
    store.writeSkill(toSkillName("a"), { name: "a" }, "a body");
    store.setSkillScope(toSkillName("a"), { kind: "global" });
    const materializer = new Materializer(store, { globalRoot });
    materializer.syncAll(makeSnapshot(store));

    const foreignFile = path.join(globalRoot, "skills", "user-private", "SKILL.md");
    fs.mkdirSync(path.dirname(foreignFile), { recursive: true });
    fs.writeFileSync(foreignFile, "foreign", "utf8");

    materializer.removeFromTarget({ kind: "global" });

    expect(fs.existsSync(path.join(globalRoot, "skills", "a"))).toBe(false);
    expect(fs.existsSync(foreignFile)).toBe(true);
    expect(fs.existsSync(path.join(globalRoot, ".trace-manifest.json"))).toBe(false);
  });

  it("only rewrites files whose source bytes changed (idempotent sync)", () => {
    const store = new LibraryStore(libraryRoot);
    store.ensureDirs();
    store.writeSkill(toSkillName("s"), { name: "s", description: "v1" }, "body");
    store.setSkillScope(toSkillName("s"), { kind: "global" });
    const materializer = new Materializer(store, { globalRoot });
    materializer.syncAll(makeSnapshot(store));

    const written = path.join(globalRoot, "skills", "s", "SKILL.md");
    const firstMtime = fs.statSync(written).mtimeMs;

    materializer.syncAll(makeSnapshot(store));
    const secondMtime = fs.statSync(written).mtimeMs;
    expect(secondMtime).toBe(firstMtime);

    store.writeSkill(toSkillName("s"), { name: "s", description: "v2" }, "body");
    materializer.syncAll(makeSnapshot(store));
    const thirdMtime = fs.statSync(written).mtimeMs;
    expect(thirdMtime).toBeGreaterThan(firstMtime);
  });
});
