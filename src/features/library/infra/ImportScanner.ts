import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseFile } from "../domain/frontmatter";
import { toProjectPath, type ProjectEntry, type ProjectPath } from "../domain/types";
import type { ImportCandidate } from "../protocol";

export interface ImportScannerOptions {
  readonly globalRoot?: string;
}

const MANAGED_MARK = "trace-managed";

export class ImportScanner {
  private readonly globalRoot: string;

  constructor(options: ImportScannerOptions = {}) {
    this.globalRoot = options.globalRoot ?? path.join(os.homedir(), ".claude");
  }

  scan(projects: readonly ProjectEntry[]): readonly ImportCandidate[] {
    const out: ImportCandidate[] = [];
    this.scanLocation(this.globalRoot, "global", out);
    for (const p of projects) {
      this.scanLocation(p.path, { path: p.path, label: p.label }, out);
    }
    return out;
  }

  private scanLocation(
    root: string,
    origin: ImportCandidate["origin"],
    out: ImportCandidate[],
  ): void {
    const skillsDir = path.join(root, ".claude", "skills");
    if (root === this.globalRoot) {
      this.scanSkills(path.join(root, "skills"), origin, out);
      this.scanAgents(path.join(root, "agents"), origin, out);
      return;
    }
    this.scanSkills(skillsDir, origin, out);
    this.scanAgents(path.join(root, ".claude", "agents"), origin, out);
  }

  private scanSkills(
    dir: string,
    origin: ImportCandidate["origin"],
    out: ImportCandidate[],
  ): void {
    if (!fs.existsSync(dir)) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      try {
        const raw = fs.readFileSync(file, "utf8");
        const parsed = parseFile(raw);
        if (parsed.frontmatter["x-trace-managed"] === MANAGED_MARK) continue;
        const description = typeof parsed.frontmatter["description"] === "string"
          ? (parsed.frontmatter["description"] as string)
          : "";
        out.push({
          kind: "skill",
          name: entry.name,
          origin,
          description,
          sourcePath: path.join(dir, entry.name),
        });
      } catch {
        continue;
      }
    }
  }

  private scanAgents(
    dir: string,
    origin: ImportCandidate["origin"],
    out: ImportCandidate[],
  ): void {
    if (!fs.existsSync(dir)) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const file = path.join(dir, entry.name);
      try {
        const raw = fs.readFileSync(file, "utf8");
        const parsed = parseFile(raw);
        if (parsed.frontmatter["x-trace-managed"] === MANAGED_MARK) continue;
        const description = typeof parsed.frontmatter["description"] === "string"
          ? (parsed.frontmatter["description"] as string)
          : "";
        out.push({
          kind: "agent",
          name: entry.name.slice(0, -3),
          origin,
          description,
          sourcePath: file,
        });
      } catch {
        continue;
      }
    }
  }
}

export const toProjectEntry = (p: string, label: string, source: ProjectEntry["source"]): ProjectEntry => ({
  path: toProjectPath(p),
  label,
  source,
});

export const projectKey = (p: ProjectPath): string => p as string;
