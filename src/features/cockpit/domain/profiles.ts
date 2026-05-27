import { MODEL_OPTIONS, type ModelChoice } from "../../../shared/models";
import { PERMISSION_MODES, type PermissionMode } from "../../../shared/permissionModes";

export type ProfileId = string & { readonly __brand: "ProfileId" };
export type SpaceId = string & { readonly __brand: "SpaceId" };

export const toProfileId = (s: string): ProfileId => s as ProfileId;
export const fromProfileId = (id: ProfileId): string => id;
export const toSpaceId = (s: string): SpaceId => s as SpaceId;
export const fromSpaceId = (id: SpaceId): string => id;

export interface SessionProfile {
  readonly id: ProfileId;
  readonly name: string;
  readonly model: ModelChoice;
  readonly permissionMode: PermissionMode;
  readonly cwd: string | null;
  readonly nameTemplate: string;
  readonly initialPrompt: string | null;
  readonly defaultCount: number;
  readonly spaceId: SpaceId | null;
}

export interface Space {
  readonly id: SpaceId;
  readonly name: string;
}

export const MAX_BATCH = 8;
export const DEFAULT_NAME_TEMPLATE = "{profile} {n}";

export const clampCount = (n: number): number => {
  const floored = Math.floor(n);
  if (!Number.isFinite(floored) || floored < 1) return 1;
  return Math.min(MAX_BATCH, floored);
};

export interface NameContext {
  readonly profileName: string;
  readonly index: number;
}

export const expandNameTemplate = (template: string, ctx: NameContext): string =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (key === "profile") return ctx.profileName;
    if (key === "n") return String(ctx.index);
    return match;
  });

export const batchNames = (
  template: string,
  profileName: string,
  count: number,
  startIndex = 1,
): readonly string[] =>
  Array.from({ length: clampCount(count) }, (_unused, i) =>
    expandNameTemplate(template, { profileName, index: startIndex + i }).trim(),
  );

export interface ProfileValidationError {
  readonly field: "name" | "nameTemplate" | "defaultCount";
  readonly message: string;
}

export const validateProfile = (
  profile: SessionProfile,
): readonly ProfileValidationError[] => {
  const errors: ProfileValidationError[] = [];
  if (profile.name.trim().length === 0) {
    errors.push({ field: "name", message: "Profile name is required." });
  }
  if (profile.nameTemplate.trim().length === 0) {
    errors.push({ field: "nameTemplate", message: "Name template is required." });
  }
  if (clampCount(profile.defaultCount) !== profile.defaultCount) {
    errors.push({
      field: "defaultCount",
      message: `Count must be a whole number between 1 and ${MAX_BATCH}.`,
    });
  }
  return errors;
};

const MODEL_IDS: ReadonlySet<string> = new Set(MODEL_OPTIONS.map((o) => o.id));
const MODE_IDS: ReadonlySet<string> = new Set(PERMISSION_MODES.map((o) => o.mode));

const asRecord = (raw: unknown): Record<string, unknown> | null =>
  raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export const parseProfile = (raw: unknown): SessionProfile | null => {
  const r = asRecord(raw);
  if (!r) return null;
  const id = str(r["id"]);
  const name = str(r["name"]);
  const model = str(r["model"]);
  const permissionMode = str(r["permissionMode"]);
  const nameTemplate = str(r["nameTemplate"]);
  if (id === null || name === null || nameTemplate === null) return null;
  if (model === null || !MODEL_IDS.has(model)) return null;
  if (permissionMode === null || !MODE_IDS.has(permissionMode)) return null;
  const defaultCount = typeof r["defaultCount"] === "number" ? clampCount(r["defaultCount"]) : 1;
  const spaceIdRaw = str(r["spaceId"]);
  return {
    id: toProfileId(id),
    name,
    model: model as ModelChoice,
    permissionMode: permissionMode as PermissionMode,
    cwd: str(r["cwd"]),
    nameTemplate,
    initialPrompt: str(r["initialPrompt"]),
    defaultCount,
    spaceId: spaceIdRaw === null ? null : toSpaceId(spaceIdRaw),
  };
};

export const parseSpace = (raw: unknown): Space | null => {
  const r = asRecord(raw);
  if (!r) return null;
  const id = str(r["id"]);
  const name = str(r["name"]);
  if (id === null || name === null) return null;
  return { id: toSpaceId(id), name };
};

export const defaultProfile = (id: ProfileId, name: string): SessionProfile => ({
  id,
  name,
  model: "default",
  permissionMode: "default",
  cwd: null,
  nameTemplate: DEFAULT_NAME_TEMPLATE,
  initialPrompt: null,
  defaultCount: 1,
  spaceId: null,
});
