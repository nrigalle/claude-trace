import * as fs from "fs";
import * as path from "path";
import { parseFile } from "../domain/frontmatter";
import { isValidLibraryName, toAgentName, toSkillName } from "../domain/types";
import type { ImportCandidate } from "../protocol";
import { type LibraryStore } from "./LibraryStore";

export class LibraryImporter {
  constructor(private readonly store: LibraryStore) {}

  importCandidate(candidate: ImportCandidate): boolean {
    if (!isValidLibraryName(candidate.name)) return false;
    return candidate.kind === "skill"
      ? this.importSkill(candidate)
      : this.importAgent(candidate);
  }

  private importSkill(candidate: ImportCandidate): boolean {
    if (this.store.readSkill(candidate.name)) return false;
    const sourceFile = path.join(candidate.sourcePath, "SKILL.md");
    const raw = readUtf8(sourceFile);
    if (raw === null) return false;
    const parsed = parseFile(raw);
    this.store.writeSkill(toSkillName(candidate.name), parsed.frontmatter, parsed.body);
    copySkillResources(candidate.sourcePath, this.store.pathsInfo.skillsDir, candidate.name);
    return true;
  }

  private importAgent(candidate: ImportCandidate): boolean {
    if (this.store.readAgent(candidate.name)) return false;
    const raw = readUtf8(candidate.sourcePath);
    if (raw === null) return false;
    const parsed = parseFile(raw);
    this.store.writeAgent(toAgentName(candidate.name), parsed.frontmatter, parsed.body);
    return true;
  }
}

const readUtf8 = (filePath: string): string | null => {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
};

const copySkillResources = (sourceDir: string, libSkillsDir: string, name: string): void => {
  const targetDir = path.join(libSkillsDir, name);
  const walk = (currentSource: string, currentTarget: string): void => {
    const entries = readDir(currentSource);
    if (entries === null) return;
    for (const entry of entries) {
      if (entry.name === "SKILL.md" && currentSource === sourceDir) continue;
      const src = path.join(currentSource, entry.name);
      const dst = path.join(currentTarget, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        walk(src, dst);
      } else if (entry.isFile()) {
        copyFileAtomic(src, dst);
      }
    }
  };
  walk(sourceDir, targetDir);
};

const readDir = (dirPath: string): readonly fs.Dirent[] | null => {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
};

const copyFileAtomic = (source: string, target: string): void => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.copyFileSync(source, tmp);
  fs.renameSync(tmp, target);
};
