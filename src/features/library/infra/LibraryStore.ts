import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { parseFile, serializeFile } from "../domain/frontmatter";
import {
  fromAgentName,
  fromSkillName,
  isValidLibraryName,
  toAgentName,
  toSkillName,
  type AgentItem,
  type AgentName,
  type Frontmatter,
  type LibraryResource,
  type ProjectEntry,
  type ProjectPath,
  type Scope,
  type SkillItem,
  type SkillName,
} from "../domain/types";

export const isValidName = isValidLibraryName;

export interface LibraryPaths {
  readonly root: string;
  readonly skillsDir: string;
  readonly agentsDir: string;
  readonly assignmentsFile: string;
  readonly projectsFile: string;
}

export const libraryPathsAt = (root: string): LibraryPaths => ({
  root,
  skillsDir: path.join(root, "skills"),
  agentsDir: path.join(root, "agents"),
  assignmentsFile: path.join(root, "assignments.json"),
  projectsFile: path.join(root, "projects.json"),
});

interface AssignmentsFile {
  readonly version: 1;
  readonly skills: Readonly<Record<string, ScopeRecord>>;
  readonly agents: Readonly<Record<string, AgentAssignment>>;
}

interface ScopeRecord {
  readonly kind: "unassigned" | "global" | "projects";
  readonly paths?: readonly string[];
}

interface AgentAssignment extends ScopeRecord {
  readonly attachedSkills?: readonly string[];
}

interface ProjectsFile {
  readonly version: 1;
  readonly projects: readonly ProjectEntry[];
}

const EMPTY_ASSIGNMENTS: AssignmentsFile = { version: 1, skills: {}, agents: {} };

export class LibraryStore {
  private readonly paths: LibraryPaths;

  constructor(root: string) {
    this.paths = libraryPathsAt(root);
  }

  get pathsInfo(): LibraryPaths {
    return this.paths;
  }

  ensureDirs(): void {
    fs.mkdirSync(this.paths.skillsDir, { recursive: true });
    fs.mkdirSync(this.paths.agentsDir, { recursive: true });
  }

  listSkills(): readonly SkillItem[] {
    this.ensureDirs();
    const assignments = this.readAssignments();
    const out: SkillItem[] = [];
    const entries = fs.readdirSync(this.paths.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const item = this.readSkill(entry.name, assignments);
      if (item) out.push(item);
    }
    out.sort((a, b) => fromSkillName(a.name).localeCompare(fromSkillName(b.name)));
    return out;
  }

  listAgents(): readonly AgentItem[] {
    this.ensureDirs();
    const assignments = this.readAssignments();
    const out: AgentItem[] = [];
    const entries = fs.readdirSync(this.paths.agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const name = entry.name.slice(0, -3);
      const item = this.readAgent(name, assignments);
      if (item) out.push(item);
    }
    out.sort((a, b) => fromAgentName(a.name).localeCompare(fromAgentName(b.name)));
    return out;
  }

  readSkill(name: string, assignments?: AssignmentsFile): SkillItem | null {
    if (!isValidName(name)) return null;
    const dir = path.join(this.paths.skillsDir, name);
    const skillMd = path.join(dir, "SKILL.md");
    if (!fs.existsSync(skillMd)) return null;
    const raw = fs.readFileSync(skillMd, "utf8");
    const parsed = parseFile(raw);
    const stat = fs.statSync(skillMd);
    const resources = collectResources(dir);
    const a = assignments ?? this.readAssignments();
    const scope = toScope(a.skills[name]);
    return {
      name: toSkillName(name),
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      resources,
      scope,
      updatedAtMs: stat.mtimeMs,
    };
  }

  readAgent(name: string, assignments?: AssignmentsFile): AgentItem | null {
    if (!isValidName(name)) return null;
    const file = path.join(this.paths.agentsDir, `${name}.md`);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    const parsed = parseFile(raw);
    const stat = fs.statSync(file);
    const a = assignments ?? this.readAssignments();
    const entry = a.agents[name];
    const scope = toScope(entry);
    const attached = entry?.attachedSkills ?? extractSkillsFrontmatter(parsed.frontmatter);
    return {
      name: toAgentName(name),
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      scope,
      attachedSkills: attached.map(toSkillName),
      updatedAtMs: stat.mtimeMs,
    };
  }

  writeSkill(
    name: SkillName,
    frontmatter: Frontmatter,
    body: string,
  ): void {
    const dir = path.join(this.paths.skillsDir, fromSkillName(name));
    fs.mkdirSync(dir, { recursive: true });
    atomicWrite(path.join(dir, "SKILL.md"), serializeFile(frontmatter, body));
  }

  writeAgent(name: AgentName, frontmatter: Frontmatter, body: string): void {
    fs.mkdirSync(this.paths.agentsDir, { recursive: true });
    atomicWrite(path.join(this.paths.agentsDir, `${fromAgentName(name)}.md`), serializeFile(frontmatter, body));
  }

  deleteSkill(name: SkillName): void {
    const dir = path.join(this.paths.skillsDir, fromSkillName(name));
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    this.mutateAssignments((a) => {
      const { [fromSkillName(name)]: _omit, ...rest } = a.skills;
      const nextAgents = stripSkillFromAgents(a.agents, fromSkillName(name));
      return { ...a, skills: rest, agents: nextAgents };
    });
  }

  deleteAgent(name: AgentName): void {
    const file = path.join(this.paths.agentsDir, `${fromAgentName(name)}.md`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    this.mutateAssignments((a) => {
      const { [fromAgentName(name)]: _omit, ...rest } = a.agents;
      return { ...a, agents: rest };
    });
  }

  renameSkill(from: SkillName, to: string): void {
    if (!isValidName(to)) throw new Error(`invalid skill name: ${to}`);
    const fromDir = path.join(this.paths.skillsDir, fromSkillName(from));
    const toDir = path.join(this.paths.skillsDir, to);
    if (!fs.existsSync(fromDir)) return;
    if (fs.existsSync(toDir)) throw new Error(`skill already exists: ${to}`);
    fs.renameSync(fromDir, toDir);
    this.mutateAssignments((a) => {
      const fromKey = fromSkillName(from);
      const moved = a.skills[fromKey];
      if (!moved) return a;
      const { [fromKey]: _omit, ...rest } = a.skills;
      return { ...a, skills: { ...rest, [to]: moved } };
    });
  }

  renameAgent(from: AgentName, to: string): void {
    if (!isValidName(to)) throw new Error(`invalid agent name: ${to}`);
    const fromFile = path.join(this.paths.agentsDir, `${fromAgentName(from)}.md`);
    const toFile = path.join(this.paths.agentsDir, `${to}.md`);
    if (!fs.existsSync(fromFile)) return;
    if (fs.existsSync(toFile)) throw new Error(`agent already exists: ${to}`);
    fs.renameSync(fromFile, toFile);
    this.mutateAssignments((a) => {
      const fromKey = fromAgentName(from);
      const moved = a.agents[fromKey];
      if (!moved) return a;
      const { [fromKey]: _omit, ...rest } = a.agents;
      return { ...a, agents: { ...rest, [to]: moved } };
    });
  }

  setSkillScope(name: SkillName, scope: Scope): void {
    this.mutateAssignments((a) => ({
      ...a,
      skills: { ...a.skills, [fromSkillName(name)]: scopeToRecord(scope) },
    }));
  }

  setAgentScope(name: AgentName, scope: Scope): void {
    this.mutateAssignments((a) => {
      const key = fromAgentName(name);
      const prior = a.agents[key];
      const next: AgentAssignment = {
        ...scopeToRecord(scope),
        attachedSkills: prior?.attachedSkills,
      };
      return { ...a, agents: { ...a.agents, [key]: next } };
    });
  }

  setAgentAttachedSkills(name: AgentName, skills: readonly SkillName[]): void {
    this.mutateAssignments((a) => {
      const key = fromAgentName(name);
      const prior = a.agents[key] ?? { kind: "unassigned" };
      const next: AgentAssignment = {
        ...prior,
        attachedSkills: skills.map(fromSkillName),
      };
      return { ...a, agents: { ...a.agents, [key]: next } };
    });
  }

  listProjects(): readonly ProjectEntry[] {
    if (!fs.existsSync(this.paths.projectsFile)) return [];
    try {
      const raw = fs.readFileSync(this.paths.projectsFile, "utf8");
      const parsed = JSON.parse(raw) as ProjectsFile;
      if (parsed?.version !== 1 || !Array.isArray(parsed.projects)) return [];
      return parsed.projects;
    } catch {
      preserveCorruptFile(this.paths.projectsFile);
      return [];
    }
  }

  writeProjects(projects: readonly ProjectEntry[]): void {
    fs.mkdirSync(this.paths.root, { recursive: true });
    const payload: ProjectsFile = { version: 1, projects };
    atomicWrite(this.paths.projectsFile, `${JSON.stringify(payload, null, 2)}\n`);
  }

  readAssignments(): AssignmentsFile {
    if (!fs.existsSync(this.paths.assignmentsFile)) return EMPTY_ASSIGNMENTS;
    try {
      const raw = fs.readFileSync(this.paths.assignmentsFile, "utf8");
      const parsed = JSON.parse(raw) as AssignmentsFile;
      if (parsed?.version !== 1) return EMPTY_ASSIGNMENTS;
      return {
        version: 1,
        skills: parsed.skills ?? {},
        agents: parsed.agents ?? {},
      };
    } catch {
      preserveCorruptFile(this.paths.assignmentsFile);
      return EMPTY_ASSIGNMENTS;
    }
  }

  private mutateAssignments(mutator: (a: AssignmentsFile) => AssignmentsFile): void {
    fs.mkdirSync(this.paths.root, { recursive: true });
    const next = mutator(this.readAssignments());
    atomicWrite(this.paths.assignmentsFile, `${JSON.stringify(next, null, 2)}\n`);
  }
}

const stripSkillFromAgents = (
  agents: Readonly<Record<string, AgentAssignment>>,
  removed: string,
): Readonly<Record<string, AgentAssignment>> => {
  const next: Record<string, AgentAssignment> = {};
  for (const [k, v] of Object.entries(agents)) {
    if (!v.attachedSkills || !v.attachedSkills.includes(removed)) {
      next[k] = v;
      continue;
    }
    next[k] = { ...v, attachedSkills: v.attachedSkills.filter((s) => s !== removed) };
  }
  return next;
};

const toScope = (entry: ScopeRecord | undefined): Scope => {
  if (!entry) return { kind: "unassigned" };
  if (entry.kind === "global") return { kind: "global" };
  if (entry.kind === "projects") {
    const paths = (entry.paths ?? []).map((p) => p as ProjectPath);
    return { kind: "projects", paths };
  }
  return { kind: "unassigned" };
};

const scopeToRecord = (scope: Scope): ScopeRecord => {
  if (scope.kind === "global") return { kind: "global" };
  if (scope.kind === "projects") return { kind: "projects", paths: scope.paths.map((p) => p) };
  return { kind: "unassigned" };
};

const extractSkillsFrontmatter = (fm: Frontmatter): readonly string[] => {
  const value = fm["skills"];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
};

const collectResources = (dir: string): readonly LibraryResource[] => {
  const out: LibraryResource[] = [];
  const walk = (current: string, relative: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const next = path.join(current, entry.name);
      const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(next, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (rel === "SKILL.md") continue;
      const buf = fs.readFileSync(next);
      out.push({
        relativePath: rel,
        sha256: sha256BufferHex(buf),
        bytes: buf.byteLength,
      });
    }
  };
  walk(dir, "");
  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return out;
};

export const atomicWrite = (target: string, contents: string): void => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents, "utf8");
  fs.renameSync(tmp, target);
};

export const preserveCorruptFile = (file: string): void => {
  if (!fs.existsSync(file)) return;
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    return;
  }
};

export const sha256BufferHex = (buf: Buffer): string =>
  crypto.createHash("sha256").update(buf).digest("hex");
