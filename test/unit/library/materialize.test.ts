import { describe, expect, it } from "vitest";
import {
  agentPath,
  buildDesiredForTarget,
  byteLength,
  emptyManifest,
  planTarget,
  sha256Hex,
  skillDir,
  skillFile,
  type TargetManifest,
} from "../../../src/features/library/domain/materialize";
import {
  toAgentName,
  toProjectPath,
  toSkillName,
  type LibrarySnapshot,
} from "../../../src/features/library/domain/types";

describe("sha256Hex", () => {
  it("matches the canonical empty-string digest", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches the canonical 'abc' digest", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("handles non-ASCII deterministically", () => {
    const a = sha256Hex("café");
    const b = sha256Hex("café");
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });
});

describe("byteLength", () => {
  it("counts ASCII as one byte each", () => {
    expect(byteLength("hello")).toBe(5);
  });
  it("counts a 2-byte UTF-8 character correctly", () => {
    expect(byteLength("é")).toBe(2);
  });
  it("counts a 4-byte surrogate-pair emoji correctly", () => {
    expect(byteLength("🚀")).toBe(4);
  });
});

describe("planTarget", () => {
  const desiredSkill = {
    name: "code-review",
    files: [
      {
        relativePath: skillFile("code-review", "SKILL.md"),
        sourcePath: "skills/code-review/SKILL.md",
        sha256: "aaa",
        bytes: 100,
      },
    ],
  };
  const desiredAgent = { name: "reviewer", relativePath: agentPath("reviewer"), contents: "agent body" };

  it("writes new skill and new agent on empty manifest", () => {
    const plan = planTarget(
      { skills: [desiredSkill], agents: [desiredAgent] },
      emptyManifest,
      new Map(),
    );
    expect(plan.writes).toHaveLength(2);
    expect(plan.writes.some((w) => w.relativePath === agentPath("reviewer"))).toBe(true);
    expect(plan.fileDeletes).toHaveLength(0);
    expect(plan.dirDeletes).toHaveLength(0);
    expect(plan.nextManifest.skills["code-review"]).toBeDefined();
  });

  it("does not rewrite a skill whose hash matches existing", () => {
    const manifest: TargetManifest = {
      version: 1,
      skills: { "code-review": [{ relativePath: skillFile("code-review", "SKILL.md"), sha256: "aaa", bytes: 100 }] },
      agents: {},
    };
    const existing = new Map([[skillFile("code-review", "SKILL.md"), "aaa"]]);
    const plan = planTarget({ skills: [desiredSkill], agents: [] }, manifest, existing);
    expect(plan.writes).toHaveLength(0);
    expect(plan.fileDeletes).toHaveLength(0);
  });

  it("rewrites a file whose existing hash drifted from the manifest", () => {
    const manifest: TargetManifest = {
      version: 1,
      skills: { "code-review": [{ relativePath: skillFile("code-review", "SKILL.md"), sha256: "aaa", bytes: 100 }] },
      agents: {},
    };
    const existing = new Map([[skillFile("code-review", "SKILL.md"), "user-edited-this"]]);
    const plan = planTarget({ skills: [desiredSkill], agents: [] }, manifest, existing);
    expect(plan.writes).toHaveLength(1);
  });

  it("deletes a skill that's in the manifest but no longer desired", () => {
    const manifest: TargetManifest = {
      version: 1,
      skills: {
        "code-review": [{ relativePath: skillFile("code-review", "SKILL.md"), sha256: "aaa", bytes: 100 }],
        "lint": [{ relativePath: skillFile("lint", "SKILL.md"), sha256: "bbb", bytes: 50 }],
      },
      agents: {},
    };
    const plan = planTarget({ skills: [desiredSkill], agents: [] }, manifest, new Map());
    expect(plan.fileDeletes.some((f) => f.relativePath === skillFile("lint", "SKILL.md"))).toBe(true);
    expect(plan.dirDeletes.some((d) => d.relativePath === skillDir("lint"))).toBe(true);
  });

  it("deletes a stale resource within a still-desired skill", () => {
    const manifest: TargetManifest = {
      version: 1,
      skills: {
        "code-review": [
          { relativePath: skillFile("code-review", "SKILL.md"), sha256: "aaa", bytes: 100 },
          { relativePath: skillFile("code-review", "scripts/old.sh"), sha256: "old", bytes: 10 },
        ],
      },
      agents: {},
    };
    const plan = planTarget({ skills: [desiredSkill], agents: [] }, manifest, new Map());
    expect(
      plan.fileDeletes.some((f) => f.relativePath === skillFile("code-review", "scripts/old.sh")),
    ).toBe(true);
  });

  it("never touches files outside its manifest", () => {
    const manifest: TargetManifest = { version: 1, skills: {}, agents: {} };
    const existing = new Map([[".claude/skills/user-private/SKILL.md", "user-content"]]);
    const plan = planTarget({ skills: [], agents: [] }, manifest, existing);
    expect(plan.fileDeletes).toHaveLength(0);
    expect(plan.dirDeletes).toHaveLength(0);
  });
});

describe("buildDesiredForTarget", () => {
  const snapshot: LibrarySnapshot = {
    skills: [
      {
        name: toSkillName("code-review"),
        frontmatter: { name: "code-review", description: "Reviews diffs" },
        body: "use me when reviewing",
        resources: [],
        scope: { kind: "global" },
        updatedAtMs: 0,
      },
      {
        name: toSkillName("lint"),
        frontmatter: { name: "lint", description: "Lints" },
        body: "use me when linting",
        resources: [],
        scope: { kind: "projects", paths: [toProjectPath("/p/banking")] },
        updatedAtMs: 0,
      },
      {
        name: toSkillName("unused"),
        frontmatter: { name: "unused", description: "" },
        body: "",
        resources: [],
        scope: { kind: "unassigned" },
        updatedAtMs: 0,
      },
    ],
    agents: [
      {
        name: toAgentName("reviewer"),
        frontmatter: { name: "reviewer", description: "code reviewer" },
        body: "prompt body",
        scope: { kind: "global" },
        attachedSkills: [toSkillName("code-review")],
        updatedAtMs: 0,
      },
    ],
    projects: [],
  };

  it("includes global-scoped items in the global target", () => {
    const desired = buildDesiredForTarget(snapshot, { kind: "global" });
    expect(desired.skills.map((s) => s.name)).toContain("code-review");
    expect(desired.skills.map((s) => s.name)).not.toContain("lint");
    expect(desired.agents.map((a) => a.name)).toContain("reviewer");
    expect(desired.skills[0]!.files[0]!.relativePath).toBe("skills/code-review/SKILL.md");
    expect(desired.agents[0]!.relativePath).toBe("agents/reviewer.md");
  });

  it("excludes unassigned items from every target", () => {
    const global = buildDesiredForTarget(snapshot, { kind: "global" });
    const project = buildDesiredForTarget(snapshot, { kind: "project", path: toProjectPath("/p/banking") });
    expect([...global.skills, ...project.skills].map((s) => s.name)).not.toContain("unused");
  });

  it("includes a project-scoped skill only in that project", () => {
    const banking = buildDesiredForTarget(snapshot, { kind: "project", path: toProjectPath("/p/banking") });
    const other = buildDesiredForTarget(snapshot, { kind: "project", path: toProjectPath("/p/other") });
    expect(banking.skills.map((s) => s.name)).toContain("lint");
    expect(banking.skills[0]!.files[0]!.relativePath).toBe(".claude/skills/lint/SKILL.md");
    expect(other.skills.map((s) => s.name)).not.toContain("lint");
  });

  it("agent contents include the attached skills frontmatter (native composition)", () => {
    const desired = buildDesiredForTarget(snapshot, { kind: "global" });
    const reviewer = desired.agents.find((a) => a.name === "reviewer");
    expect(reviewer).toBeDefined();
    expect(reviewer!.contents).toContain("skills:");
    expect(reviewer!.contents).toContain("code-review");
  });
});
