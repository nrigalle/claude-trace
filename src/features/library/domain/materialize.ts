import { serializeFile } from "./frontmatter";
import {
  fromAgentName,
  fromProjectPath,
  fromSkillName,
  type AgentItem,
  type Frontmatter,
  type LibrarySnapshot,
  type ProjectPath,
  type SkillItem,
} from "./types";

export interface ManagedFile {
  readonly relativePath: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface TargetManifest {
  readonly version: 1;
  readonly skills: Readonly<Record<string, readonly ManagedFile[]>>;
  readonly agents: Readonly<Record<string, ManagedFile>>;
}

export const emptyManifest: TargetManifest = {
  version: 1,
  skills: {},
  agents: {},
};

export interface DesiredSkillFile {
  readonly relativePath: string;
  readonly sourcePath: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface DesiredSkill {
  readonly name: string;
  readonly files: readonly DesiredSkillFile[];
}

export interface DesiredAgent {
  readonly name: string;
  readonly relativePath: string;
  readonly contents: string;
}

export interface TargetDesiredState {
  readonly skills: readonly DesiredSkill[];
  readonly agents: readonly DesiredAgent[];
}

export interface FileWrite {
  readonly action: "writeFromSource" | "writeContent";
  readonly relativePath: string;
  readonly sourcePath?: string;
  readonly contents?: string;
}

export interface FileDelete {
  readonly relativePath: string;
}

export interface DirectoryDelete {
  readonly relativePath: string;
}

export interface TargetPlan {
  readonly writes: readonly FileWrite[];
  readonly fileDeletes: readonly FileDelete[];
  readonly dirDeletes: readonly DirectoryDelete[];
  readonly nextManifest: TargetManifest;
}

export const planTarget = (
  desired: TargetDesiredState,
  manifest: TargetManifest,
  existing: ReadonlyMap<string, string>,
): TargetPlan => {
  const writes: FileWrite[] = [];
  const fileDeletes: FileDelete[] = [];
  const dirDeletes: DirectoryDelete[] = [];

  const nextSkills: Record<string, readonly ManagedFile[]> = {};
  const desiredSkillNames = new Set<string>();

  for (const skill of desired.skills) {
    desiredSkillNames.add(skill.name);
    const previous = manifest.skills[skill.name] ?? [];
    const previousByRel = new Map(previous.map((f) => [f.relativePath, f]));
    const nextFiles: ManagedFile[] = [];
    for (const file of skill.files) {
      const prev = previousByRel.get(file.relativePath);
      const existingHash = existing.get(file.relativePath);
      if (!prev || existingHash !== file.sha256) {
        writes.push({
          action: "writeFromSource",
          relativePath: file.relativePath,
          sourcePath: file.sourcePath,
        });
      }
      nextFiles.push({
        relativePath: file.relativePath,
        sha256: file.sha256,
        bytes: file.bytes,
      });
      previousByRel.delete(file.relativePath);
    }
    for (const stale of previousByRel.values()) {
      fileDeletes.push({ relativePath: stale.relativePath });
    }
    nextSkills[skill.name] = nextFiles;
  }

  for (const [skillName, files] of Object.entries(manifest.skills)) {
    if (desiredSkillNames.has(skillName)) continue;
    for (const file of files) fileDeletes.push({ relativePath: file.relativePath });
    dirDeletes.push({ relativePath: managedSkillDir(skillName, files) });
  }

  const nextAgents: Record<string, ManagedFile> = {};
  const desiredAgentNames = new Set<string>();
  for (const agent of desired.agents) {
    desiredAgentNames.add(agent.name);
    const relativePath = agent.relativePath;
    const sha = sha256Hex(agent.contents);
    const prev = manifest.agents[agent.name];
    const existingHash = existing.get(relativePath);
    if (!prev || existingHash !== sha) {
      writes.push({
        action: "writeContent",
        relativePath,
        contents: agent.contents,
      });
    }
    nextAgents[agent.name] = {
      relativePath,
      sha256: sha,
      bytes: byteLength(agent.contents),
    };
  }
  for (const [agentName, file] of Object.entries(manifest.agents)) {
    if (desiredAgentNames.has(agentName)) continue;
    fileDeletes.push({ relativePath: file.relativePath });
  }

  return {
    writes,
    fileDeletes,
    dirDeletes,
    nextManifest: { version: 1, skills: nextSkills, agents: nextAgents },
  };
};

export const skillDir = (name: string): string => `.claude/skills/${name}`;
export const skillFile = (name: string, relative: string): string =>
  `.claude/skills/${name}/${relative}`;
export const agentPath = (name: string): string => `.claude/agents/${name}.md`;

export const buildDesiredForTarget = (
  snapshot: LibrarySnapshot,
  target: TargetLocation,
): TargetDesiredState => {
  const skills: DesiredSkill[] = [];
  for (const skill of snapshot.skills) {
    if (!appliesToTarget(skill.scope.kind, skillProjectPaths(skill), target)) continue;
    skills.push(toDesiredSkill(skill, target));
  }
  const agents: DesiredAgent[] = [];
  for (const agent of snapshot.agents) {
    if (!appliesToTarget(agent.scope.kind, agentProjectPaths(agent), target)) continue;
    agents.push(toDesiredAgent(agent, target));
  }
  return { skills, agents };
};

export type TargetLocation =
  | { readonly kind: "global" }
  | { readonly kind: "project"; readonly path: ProjectPath };

const appliesToTarget = (
  scopeKind: "global" | "projects" | "unassigned",
  projects: readonly ProjectPath[],
  target: TargetLocation,
): boolean => {
  if (scopeKind === "unassigned") return false;
  if (target.kind === "global") return scopeKind === "global";
  return scopeKind === "projects" && projects.some((p) => fromProjectPath(p) === fromProjectPath(target.path));
};

const skillProjectPaths = (skill: SkillItem): readonly ProjectPath[] =>
  skill.scope.kind === "projects" ? skill.scope.paths : [];

const agentProjectPaths = (agent: AgentItem): readonly ProjectPath[] =>
  agent.scope.kind === "projects" ? agent.scope.paths : [];

const toDesiredSkill = (skill: SkillItem, target: TargetLocation): DesiredSkill => {
  const name = fromSkillName(skill.name);
  const skillMd = serializeFile(withName(skill.frontmatter, name), skill.body);
  const files: DesiredSkillFile[] = [
    {
      relativePath: targetSkillFile(target, name, "SKILL.md"),
      sourcePath: `skills/${name}/SKILL.md`,
      sha256: sha256Hex(skillMd),
      bytes: byteLength(skillMd),
    },
    ...skill.resources.map<DesiredSkillFile>((res) => ({
      relativePath: targetSkillFile(target, name, res.relativePath),
      sourcePath: `skills/${name}/${res.relativePath}`,
      sha256: res.sha256,
      bytes: res.bytes,
    })),
  ];
  return { name, files };
};

const toDesiredAgent = (agent: AgentItem, target: TargetLocation): DesiredAgent => {
  const name = fromAgentName(agent.name);
  const fm = withSkills(agent.frontmatter, agent.attachedSkills.map(fromSkillName));
  return { name, relativePath: targetAgentPath(target, name), contents: serializeFile(fm, agent.body) };
};

const targetSkillDir = (target: TargetLocation, name: string): string =>
  target.kind === "global" ? `skills/${name}` : skillDir(name);

const targetSkillFile = (target: TargetLocation, name: string, relative: string): string =>
  `${targetSkillDir(target, name)}/${relative}`;

const targetAgentPath = (target: TargetLocation, name: string): string =>
  target.kind === "global" ? `agents/${name}.md` : agentPath(name);

export const managedSkillDir = (name: string, files: readonly ManagedFile[]): string => {
  const skillMd = files.find((f) => f.relativePath.endsWith(`/${name}/SKILL.md`));
  if (!skillMd) return skillDir(name);
  const slash = skillMd.relativePath.lastIndexOf("/");
  return slash <= 0 ? skillDir(name) : skillMd.relativePath.slice(0, slash);
};

const withName = (fm: Frontmatter, name: string): Frontmatter => {
  if (fm["name"] === name) return fm;
  return { ...fm, name };
};

const withSkills = (fm: Frontmatter, skills: readonly string[]): Frontmatter => {
  if (skills.length === 0) {
    const { skills: _omit, ...rest } = fm;
    return rest;
  }
  return { ...fm, skills };
};

export const byteLength = (s: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x80) n += 1;
    else if (code < 0x800) n += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
};

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export const sha256Hex = (input: string): string => {
  const bytes = utf8Bytes(input);
  const bitLen = bytes.length * 8;
  const padLen = (((bytes.length + 9 + 63) >>> 6) << 6);
  const padded = new Uint8Array(padLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  padded[padLen - 8] = (hi >>> 24) & 0xff;
  padded[padLen - 7] = (hi >>> 16) & 0xff;
  padded[padLen - 6] = (hi >>> 8) & 0xff;
  padded[padLen - 5] = hi & 0xff;
  padded[padLen - 4] = (lo >>> 24) & 0xff;
  padded[padLen - 3] = (lo >>> 16) & 0xff;
  padded[padLen - 2] = (lo >>> 8) & 0xff;
  padded[padLen - 1] = lo & 0xff;

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const W = new Uint32Array(64);

  for (let chunk = 0; chunk < padLen; chunk += 64) {
    for (let i = 0; i < 16; i += 1) {
      const off = chunk + i * 4;
      W[i] =
        ((padded[off] ?? 0) << 24) |
        ((padded[off + 1] ?? 0) << 16) |
        ((padded[off + 2] ?? 0) << 8) |
        (padded[off + 3] ?? 0);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = W[i - 15] ?? 0;
      const w2 = W[i - 2] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      W[i] = (W[i - 16] ?? 0) + s0 + (W[i - 7] ?? 0) + s1;
    }
    let a = H[0] ?? 0;
    let b = H[1] ?? 0;
    let c = H[2] ?? 0;
    let d = H[3] ?? 0;
    let e = H[4] ?? 0;
    let f = H[5] ?? 0;
    let g = H[6] ?? 0;
    let h = H[7] ?? 0;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + (K[i] ?? 0) + (W[i] ?? 0)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = ((H[0] ?? 0) + a) >>> 0;
    H[1] = ((H[1] ?? 0) + b) >>> 0;
    H[2] = ((H[2] ?? 0) + c) >>> 0;
    H[3] = ((H[3] ?? 0) + d) >>> 0;
    H[4] = ((H[4] ?? 0) + e) >>> 0;
    H[5] = ((H[5] ?? 0) + f) >>> 0;
    H[6] = ((H[6] ?? 0) + g) >>> 0;
    H[7] = ((H[7] ?? 0) + h) >>> 0;
  }

  let out = "";
  for (let i = 0; i < 8; i += 1) out += toHex8(H[i] ?? 0);
  return out;
};

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

const toHex8 = (n: number): string => {
  const s = (n >>> 0).toString(16);
  return s.padStart(8, "0");
};

const utf8Bytes = (s: string): Uint8Array => {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    let code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      code = 0x10000 + (((code - 0xd800) << 10) | (next - 0xdc00));
      i += 1;
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
};
