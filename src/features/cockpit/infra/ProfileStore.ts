import * as fs from "fs";
import * as path from "path";
import { COCKPIT_FILE } from "../../../shared/config";
import {
  parseProfile,
  parseSpace,
  type ProfileId,
  type SessionProfile,
  type Space,
  type SpaceId,
} from "../domain/profiles";

export interface CockpitConfig {
  readonly profiles: readonly SessionProfile[];
  readonly spaces: readonly Space[];
}

const EMPTY: CockpitConfig = { profiles: [], spaces: [] };

export class ProfileStore {
  constructor(private readonly file: string = COCKPIT_FILE) {}

  load(): CockpitConfig {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return EMPTY;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return EMPTY;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY;
    const doc = parsed as Record<string, unknown>;
    const profiles = Array.isArray(doc["profiles"])
      ? doc["profiles"].map(parseProfile).filter((p): p is SessionProfile => p !== null)
      : [];
    const spaces = Array.isArray(doc["spaces"])
      ? doc["spaces"].map(parseSpace).filter((s): s is Space => s !== null)
      : [];
    return { profiles, spaces };
  }

  saveProfile(profile: SessionProfile): void {
    const cfg = this.load();
    const profiles = upsert(cfg.profiles, profile, (p) => p.id === profile.id);
    this.write({ profiles, spaces: cfg.spaces });
  }

  deleteProfile(id: ProfileId): void {
    const cfg = this.load();
    this.write({
      profiles: cfg.profiles.filter((p) => p.id !== id),
      spaces: cfg.spaces,
    });
  }

  saveSpace(space: Space): void {
    const cfg = this.load();
    const spaces = upsert(cfg.spaces, space, (s) => s.id === space.id);
    this.write({ profiles: cfg.profiles, spaces });
  }

  deleteSpace(id: SpaceId): void {
    const cfg = this.load();
    this.write({
      profiles: cfg.profiles.map((p) =>
        p.spaceId === id ? { ...p, spaceId: null } : p,
      ),
      spaces: cfg.spaces.filter((s) => s.id !== id),
    });
  }

  private write(cfg: CockpitConfig): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ profiles: cfg.profiles, spaces: cfg.spaces }, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }
}

const upsert = <T>(items: readonly T[], next: T, matches: (item: T) => boolean): readonly T[] => {
  const idx = items.findIndex(matches);
  if (idx === -1) return [...items, next];
  const copy = [...items];
  copy[idx] = next;
  return copy;
};
