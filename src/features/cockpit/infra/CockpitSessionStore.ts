import * as fs from "fs";
import * as path from "path";
import { COCKPIT_SESSIONS_FILE } from "../../../shared/config";
import { MODEL_OPTIONS, type ModelChoice } from "../../../shared/models";
import { PERMISSION_MODES, type PermissionMode } from "../../../shared/permissionModes";

export interface PersistedCockpitSession {
  readonly id: string;
  readonly windowId: string;
  readonly name: string;
  readonly spaceId: string | null;
  readonly cwd: string | null;
  readonly model: ModelChoice;
  readonly permissionMode: PermissionMode;
  readonly startedAtMs: number;
}

const MODEL_IDS: ReadonlySet<string> = new Set(MODEL_OPTIONS.map((o) => o.id));
const MODE_IDS: ReadonlySet<string> = new Set(PERMISSION_MODES.map((o) => o.mode));

const parse = (raw: unknown): PersistedCockpitSession | null => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r["id"] === "string" ? r["id"] : null;
  const name = typeof r["name"] === "string" ? r["name"] : null;
  const model = typeof r["model"] === "string" ? r["model"] : null;
  const permissionMode = typeof r["permissionMode"] === "string" ? r["permissionMode"] : null;
  if (id === null || name === null) return null;
  if (model === null || !MODEL_IDS.has(model)) return null;
  if (permissionMode === null || !MODE_IDS.has(permissionMode)) return null;
  return {
    id,
    windowId: typeof r["windowId"] === "string" ? r["windowId"] : id,
    name,
    spaceId: typeof r["spaceId"] === "string" ? r["spaceId"] : null,
    cwd: typeof r["cwd"] === "string" ? r["cwd"] : null,
    model: model as ModelChoice,
    permissionMode: permissionMode as PermissionMode,
    startedAtMs: typeof r["startedAtMs"] === "number" ? r["startedAtMs"] : 0,
  };
};

export class CockpitSessionStore {
  constructor(private readonly file: string = COCKPIT_SESSIONS_FILE) {}

  load(): readonly PersistedCockpitSession[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parse).filter((s): s is PersistedCockpitSession => s !== null);
  }

  upsert(session: PersistedCockpitSession): void {
    const all = this.load().filter((s) => s.id !== session.id);
    this.write([...all, session]);
  }

  remove(id: string): void {
    this.write(this.load().filter((s) => s.id !== id));
  }

  private write(sessions: readonly PersistedCockpitSession[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }
}
