export type SkillName = string & { readonly __brand: "SkillName" };
export type AgentName = string & { readonly __brand: "AgentName" };
export type ProjectPath = string & { readonly __brand: "ProjectPath" };

const LIBRARY_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

export const isValidLibraryName = (name: string): boolean => LIBRARY_NAME_REGEX.test(name);
export const toSkillName = (s: string): SkillName => s as SkillName;
export const fromSkillName = (n: SkillName): string => n;
export const toAgentName = (s: string): AgentName => s as AgentName;
export const fromAgentName = (n: AgentName): string => n;
export const toProjectPath = (s: string): ProjectPath => s as ProjectPath;
export const fromProjectPath = (p: ProjectPath): string => p;

export type FrontmatterValue =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  | Readonly<Record<string, string>>;

export type Frontmatter = Readonly<Record<string, FrontmatterValue>>;

export type Scope =
  | { readonly kind: "unassigned" }
  | { readonly kind: "global" }
  | { readonly kind: "projects"; readonly paths: readonly ProjectPath[] };

export interface SkillItem {
  readonly name: SkillName;
  readonly frontmatter: Frontmatter;
  readonly body: string;
  readonly resources: readonly LibraryResource[];
  readonly scope: Scope;
  readonly updatedAtMs: number;
}

export interface AgentItem {
  readonly name: AgentName;
  readonly frontmatter: Frontmatter;
  readonly body: string;
  readonly scope: Scope;
  readonly attachedSkills: readonly SkillName[];
  readonly updatedAtMs: number;
}

export interface LibraryResource {
  readonly relativePath: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ProjectEntry {
  readonly path: ProjectPath;
  readonly label: string;
  readonly source: "workspace" | "tracked" | "manual";
}

export interface LibrarySnapshot {
  readonly skills: readonly SkillItem[];
  readonly agents: readonly AgentItem[];
  readonly projects: readonly ProjectEntry[];
}

export type LibraryItemKind = "skill" | "agent";

export const scopeIsGlobal = (s: Scope): boolean => s.kind === "global";
export const scopeProjects = (s: Scope): readonly ProjectPath[] =>
  s.kind === "projects" ? s.paths : [];
export const scopeIsAssigned = (s: Scope): boolean =>
  s.kind === "global" || (s.kind === "projects" && s.paths.length > 0);
