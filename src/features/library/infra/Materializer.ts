import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildDesiredForTarget,
  emptyManifest,
  managedSkillDir,
  planTarget,
  type DirectoryDelete,
  type FileDelete,
  type FileWrite,
  type TargetLocation,
  type TargetManifest,
  type TargetPlan,
} from "../domain/materialize";
import { fromProjectPath, type LibrarySnapshot, type ProjectPath } from "../domain/types";
import { preserveCorruptFile, sha256BufferHex, type LibraryStore } from "./LibraryStore";

export interface MaterializerOptions {
  readonly globalRoot?: string;
}

export interface MaterializeReport {
  readonly targets: readonly {
    readonly target: TargetLocation;
    readonly written: number;
    readonly deleted: number;
  }[];
  readonly errors: readonly { readonly target: TargetLocation; readonly message: string }[];
}

const MANIFEST_FILENAME = ".trace-manifest.json";

export class Materializer {
  private readonly globalRoot: string;

  constructor(private readonly store: LibraryStore, options: MaterializerOptions = {}) {
    this.globalRoot = options.globalRoot ?? path.join(os.homedir(), ".claude");
  }

  syncAll(snapshot: LibrarySnapshot): MaterializeReport {
    const targets: TargetLocation[] = [{ kind: "global" }];
    const seenProjects = new Set<string>();
    for (const skill of snapshot.skills) {
      if (skill.scope.kind !== "projects") continue;
      for (const p of skill.scope.paths) seenProjects.add(fromProjectPath(p));
    }
    for (const agent of snapshot.agents) {
      if (agent.scope.kind !== "projects") continue;
      for (const p of agent.scope.paths) seenProjects.add(fromProjectPath(p));
    }
    for (const known of snapshot.projects) seenProjects.add(fromProjectPath(known.path));
    for (const p of seenProjects) targets.push({ kind: "project", path: p as ProjectPath });

    const targetReports: MaterializeReport["targets"][number][] = [];
    const errors: MaterializeReport["errors"][number][] = [];
    for (const target of targets) {
      try {
        const report = this.syncTarget(target, snapshot);
        targetReports.push({ target, written: report.written, deleted: report.deleted });
      } catch (err) {
        errors.push({ target, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return { targets: targetReports, errors };
  }

  syncTarget(target: TargetLocation, snapshot: LibrarySnapshot): { written: number; deleted: number } {
    const root = this.targetRoot(target);
    const manifestPath = path.join(root, MANIFEST_FILENAME);
    const manifest = readManifest(manifestPath);
    const desired = buildDesiredForTarget(snapshot, target);
    const existing = collectExistingHashes(root, manifest);
    const plan = planTarget(desired, manifest, existing);
    applyPlan(root, this.libraryRoot(), plan);
    if (
      Object.keys(plan.nextManifest.skills).length === 0 &&
      Object.keys(plan.nextManifest.agents).length === 0 &&
      fs.existsSync(manifestPath)
    ) {
      fs.unlinkSync(manifestPath);
    } else if (
      Object.keys(plan.nextManifest.skills).length > 0 ||
      Object.keys(plan.nextManifest.agents).length > 0
    ) {
      fs.mkdirSync(root, { recursive: true });
      atomicWrite(manifestPath, `${JSON.stringify(plan.nextManifest, null, 2)}\n`);
    }
    return { written: plan.writes.length, deleted: plan.fileDeletes.length };
  }

  removeFromTarget(target: TargetLocation): void {
    const root = this.targetRoot(target);
    const manifestPath = path.join(root, MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) return;
    const manifest = readManifest(manifestPath);
    for (const files of Object.values(manifest.skills)) {
      for (const f of files) safeUnlink(path.join(root, f.relativePath));
    }
    for (const [skillName, files] of Object.entries(manifest.skills)) {
      safeRmdir(path.join(root, managedSkillDir(skillName, files)));
    }
    for (const f of Object.values(manifest.agents)) safeUnlink(path.join(root, f.relativePath));
    fs.unlinkSync(manifestPath);
  }

  private targetRoot(target: TargetLocation): string {
    if (target.kind === "global") return this.globalRoot;
    return fromProjectPath(target.path);
  }

  private libraryRoot(): string {
    return this.store.pathsInfo.root;
  }
}

const readManifest = (file: string): TargetManifest => {
  if (!fs.existsSync(file)) return emptyManifest;
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as TargetManifest;
    if (parsed?.version !== 1) return emptyManifest;
    return {
      version: 1,
      skills: parsed.skills ?? {},
      agents: parsed.agents ?? {},
    };
  } catch {
    preserveCorruptFile(file);
    return emptyManifest;
  }
};

const collectExistingHashes = (
  root: string,
  manifest: TargetManifest,
): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  const hashIfExists = (rel: string): void => {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) return;
    try {
      const raw = fs.readFileSync(full);
      out.set(rel, sha256BufferHex(raw));
    } catch {
      return;
    }
  };
  for (const files of Object.values(manifest.skills)) {
    for (const f of files) hashIfExists(f.relativePath);
  }
  for (const f of Object.values(manifest.agents)) hashIfExists(f.relativePath);
  return out;
};

const applyPlan = (root: string, libraryRoot: string, plan: TargetPlan): void => {
  for (const w of plan.writes) writeFile(root, libraryRoot, w);
  for (const d of plan.fileDeletes) deleteFile(root, d);
  for (const d of plan.dirDeletes) deleteDir(root, d);
};

let tmpCounter = 0;
const uniqueTmp = (target: string): string =>
  `${target}.${process.pid}.${Date.now().toString(36)}.${(tmpCounter++).toString(36)}.tmp`;

const atomicWrite = (target: string, contents: string): void => {
  const tmp = uniqueTmp(target);
  fs.writeFileSync(tmp, contents, "utf8");
  fs.renameSync(tmp, target);
};

const writeFile = (root: string, libraryRoot: string, w: FileWrite): void => {
  const target = path.join(root, w.relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (w.action === "writeFromSource") {
    if (!w.sourcePath) return;
    const source = path.join(libraryRoot, w.sourcePath);
    if (!fs.existsSync(source)) return;
    const tmp = uniqueTmp(target);
    fs.copyFileSync(source, tmp);
    fs.renameSync(tmp, target);
    return;
  }
  atomicWrite(target, w.contents ?? "");
};

const deleteFile = (root: string, d: FileDelete): void => {
  const target = path.join(root, d.relativePath);
  safeUnlink(target);
};

const deleteDir = (root: string, d: DirectoryDelete): void => {
  const target = path.join(root, d.relativePath);
  safeRmdir(target);
};

const safeUnlink = (file: string): void => {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    return;
  }
};

const safeRmdir = (dir: string): void => {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    return;
  }
};
