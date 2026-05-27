import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProfileStore } from "../../../src/features/cockpit/infra/ProfileStore";
import {
  defaultProfile,
  parseProfile,
  toProfileId,
  toSpaceId,
  type SessionProfile,
} from "../../../src/features/cockpit/domain/profiles";

let dir: string;
let file: string;
let store: ProfileStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-cockpit-"));
  file = path.join(dir, "cockpit.json");
  store = new ProfileStore(file);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ProfileStore round-trip", () => {
  it("returns empty config when the file does not exist", () => {
    expect(store.load()).toEqual({ profiles: [], spaces: [] });
  });

  it("persists a profile and reads it back intact", () => {
    const p = defaultProfile(toProfileId("p1"), "Reviewer");
    store.saveProfile(p);
    expect(store.load().profiles).toEqual([p]);
  });

  it("upserts by id rather than appending duplicates", () => {
    const p = defaultProfile(toProfileId("p1"), "Reviewer");
    store.saveProfile(p);
    store.saveProfile({ ...p, name: "Reviewer v2" });
    const profiles = store.load().profiles;
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.name).toBe("Reviewer v2");
  });

  it("deletes a profile by id", () => {
    store.saveProfile(defaultProfile(toProfileId("p1"), "A"));
    store.saveProfile(defaultProfile(toProfileId("p2"), "B"));
    store.deleteProfile(toProfileId("p1"));
    expect(store.load().profiles.map((p) => p.name)).toEqual(["B"]);
  });

  it("deleting a space clears that spaceId from every profile referencing it", () => {
    const space = { id: toSpaceId("s1"), name: "Work" };
    store.saveSpace(space);
    store.saveProfile({ ...defaultProfile(toProfileId("p1"), "A"), spaceId: toSpaceId("s1") });
    store.saveProfile({ ...defaultProfile(toProfileId("p2"), "B"), spaceId: toSpaceId("s1") });
    store.deleteSpace(toSpaceId("s1"));
    const cfg = store.load();
    expect(cfg.spaces).toEqual([]);
    expect(cfg.profiles.every((p) => p.spaceId === null)).toBe(true);
  });

  it("ignores malformed JSON on disk and returns empty", () => {
    fs.writeFileSync(file, "{not json", "utf8");
    expect(store.load()).toEqual({ profiles: [], spaces: [] });
  });

  it("drops individual malformed profile entries but keeps valid ones", () => {
    const valid: SessionProfile = defaultProfile(toProfileId("ok"), "Good");
    fs.writeFileSync(
      file,
      JSON.stringify({ profiles: [valid, { id: "bad", model: "not-a-model" }], spaces: [] }),
      "utf8",
    );
    expect(store.load().profiles).toEqual([valid]);
  });
});

describe("parseProfile boundary validation", () => {
  it("rejects an unknown model", () => {
    const p = { ...defaultProfile(toProfileId("p"), "x"), model: "gpt-9" };
    expect(parseProfile(p)).toBeNull();
  });

  it("rejects an unknown permission mode", () => {
    const p = { ...defaultProfile(toProfileId("p"), "x"), permissionMode: "yolo" };
    expect(parseProfile(p)).toBeNull();
  });

  it("rejects a missing required field", () => {
    expect(parseProfile({ id: "p", model: "default", permissionMode: "default" })).toBeNull();
  });

  it("clamps an out-of-range persisted count instead of rejecting", () => {
    const p = { ...defaultProfile(toProfileId("p"), "x"), defaultCount: 999 };
    expect(parseProfile(p)?.defaultCount).toBe(8);
  });
});
