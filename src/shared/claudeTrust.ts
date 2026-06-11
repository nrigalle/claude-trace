import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { logWarn } from "./infra/traceLog";

const CLAUDE_CONFIG_PATH = path.join(os.homedir(), ".claude.json");

export const ensureFolderTrusted = async (
  cwd: string,
  configPath: string = CLAUDE_CONFIG_PATH,
): Promise<void> => {
  try {
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(await fs.promises.readFile(configPath, "utf8")) as Record<string, unknown>;
    } catch {
      cfg = {};
    }
    const projectsRaw = cfg["projects"];
    const projects =
      projectsRaw !== null && typeof projectsRaw === "object" && !Array.isArray(projectsRaw)
        ? (projectsRaw as Record<string, unknown>)
        : {};
    cfg["projects"] = projects;
    const entryRaw = projects[cwd];
    const entry =
      entryRaw !== null && typeof entryRaw === "object" && !Array.isArray(entryRaw)
        ? (entryRaw as Record<string, unknown>)
        : {};
    projects[cwd] = entry;
    if (entry["hasTrustDialogAccepted"] === true) return;
    entry["hasTrustDialogAccepted"] = true;
    const tmp = `${configPath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(cfg, null, 2), "utf8");
    await fs.promises.rename(tmp, configPath);
  } catch (err: unknown) {
    logWarn("pipelines", `Could not pre-trust ${cwd}; a folder-trust dialog may block hidden Claude sessions there`, err);
  }
};
