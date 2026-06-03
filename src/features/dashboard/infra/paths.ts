import * as fs from "fs";
import * as path from "path";
import { PROJECTS_DIR } from "../../../shared/config";
import type { SessionId } from "../domain/types";
import { toSessionId } from "../domain/types";

export interface SessionRef {
  readonly sessionId: SessionId;
  readonly projectDirName: string;
  readonly filePath: string;
}

const firstCwdInTranscript = (filePath: string): string | null => {
  let fd = -1;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(65536);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString("utf8", 0, read).split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as { cwd?: unknown };
        if (typeof obj.cwd === "string" && obj.cwd.length > 0) return obj.cwd;
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== -1) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
};

export const cwdForProjectDir = (projectDirPath: string): string | null => {
  let files: string[];
  try {
    files = fs.readdirSync(projectDirPath).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  for (const file of files) {
    const cwd = firstCwdInTranscript(path.join(projectDirPath, file));
    if (cwd) return cwd;
  }
  return null;
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

export const isHiddenAssistantProject = (projectDirName: string): boolean =>
  projectDirName.includes("-claude-trace-library-assistant-");

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
    if (isHiddenAssistantProject(project.name)) continue;
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
