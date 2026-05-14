import * as fs from "fs";
import * as path from "path";
import { PROJECTS_DIR } from "../../config";
import type { SessionId } from "../../domain/types";
import { toSessionId } from "../../domain/types";

export interface SessionRef {
  readonly sessionId: SessionId;
  readonly projectDirName: string;
  readonly filePath: string;
}

export const decodeProjectDirName = (encoded: string): string | null => {
  if (!encoded) return null;
  if (!encoded.startsWith("-")) return null;
  return encoded.replace(/-/g, "/");
};

export const filenameToSessionId = (filename: string): SessionId | null => {
  if (!filename.endsWith(".jsonl")) return null;
  const stripped = filename.slice(0, -".jsonl".length);
  if (!stripped) return null;
  return toSessionId(stripped);
};

export const parseUriPath = (fsPath: string): { sessionId: SessionId; projectDirName: string } | null => {
  const filename = path.basename(fsPath);
  const sessionId = filenameToSessionId(filename);
  if (!sessionId) return null;
  const projectDirName = path.basename(path.dirname(fsPath));
  if (!projectDirName) return null;
  return { sessionId, projectDirName };
};

export const sessionRefForFile = (filePath: string): SessionRef | null => {
  const parsed = parseUriPath(filePath);
  if (!parsed) return null;
  return { sessionId: parsed.sessionId, projectDirName: parsed.projectDirName, filePath };
};

export const discoverSessionRefs = (): SessionRef[] => {
  const out: SessionRef[] = [];
  let projects: fs.Dirent[];
  try {
    projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = path.join(PROJECTS_DIR, project.name);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.endsWith(".jsonl")) continue;
      const sessionId = filenameToSessionId(e.name);
      if (!sessionId) continue;
      out.push({
        sessionId,
        projectDirName: project.name,
        filePath: path.join(projectPath, e.name),
      });
    }
  }
  return out;
};
