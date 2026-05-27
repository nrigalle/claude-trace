import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECTS_DIR, LIVE_POLL_INTERVAL_MS } from "../../../src/shared/config";
import { SessionFilePoller } from "../../../src/features/dashboard/infra/SessionFilePoller";
import type { WatcherChange } from "../../../src/features/dashboard/infra/SessionDirectoryWatcher";

interface Session {
  readonly id: string;
  readonly file: string;
}

describe("SessionFilePoller — visibility gating & change detection", () => {
  let poller: SessionFilePoller;
  const created: string[] = [];

  const makeSession = (): Session => {
    const sub = `-tmp-poller-${Math.random().toString(36).slice(2, 10)}`;
    const dir = path.join(PROJECTS_DIR, sub);
    fs.mkdirSync(dir, { recursive: true });
    const id = `poll-${Math.random().toString(36).slice(2, 10)}`;
    const file = path.join(dir, `${id}.jsonl`);
    created.push(file);
    return { id, file };
  };

  const recordFor = (id: string): WatcherChange["kind"][] => {
    const kinds: WatcherChange["kind"][] = [];
    poller.onChange((c) => {
      if (c.sessionId === id) kinds.push(c.kind);
    });
    return kinds;
  };

  const advance = (n = 1): void => {
    vi.advanceTimersByTime(LIVE_POLL_INTERVAL_MS * n);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    poller = new SessionFilePoller();
  });

  afterEach(() => {
    poller.setActive(false);
    vi.useRealTimers();
    for (const f of created) {
      try {
        fs.rmSync(path.dirname(f), { recursive: true, force: true });
      } catch {}
    }
    created.length = 0;
  });

  it("does not poll until activated, and seeding does not re-announce pre-existing files", () => {
    const s = makeSession();
    fs.writeFileSync(s.file, "a");
    const seen = recordFor(s.id);

    advance(3);
    expect(seen).toEqual([]);

    poller.setActive(true);
    advance(2);
    expect(seen).toEqual([]);
  });

  it("emits 'added' for a file that appears after activation", () => {
    poller.setActive(true);
    const s = makeSession();
    const seen = recordFor(s.id);

    fs.writeFileSync(s.file, "x");
    advance();
    expect(seen).toEqual(["added"]);
  });

  it("emits 'changed' when a tracked file's size changes", () => {
    const s = makeSession();
    fs.writeFileSync(s.file, "a");
    const seen = recordFor(s.id);
    poller.setActive(true);

    advance();
    expect(seen).toEqual([]);

    fs.appendFileSync(s.file, "bb");
    advance();
    expect(seen).toEqual(["changed"]);
  });

  it("emits 'removed' when a tracked file disappears", () => {
    const s = makeSession();
    fs.writeFileSync(s.file, "x");
    const seen = recordFor(s.id);
    poller.setActive(true);

    fs.rmSync(s.file);
    advance();
    expect(seen).toEqual(["removed"]);
  });

  it("setActive(false) stops polling entirely — no work while the dashboard is hidden", () => {
    const s = makeSession();
    fs.writeFileSync(s.file, "x");
    const seen = recordFor(s.id);
    poller.setActive(true);
    poller.setActive(false);

    fs.appendFileSync(s.file, "yy");
    advance(5);
    expect(seen).toEqual([]);
  });

  it("resuming after a pause catches up missed changes via an immediate tick, not a silent re-seed", () => {
    const s = makeSession();
    fs.writeFileSync(s.file, "x");
    const seen = recordFor(s.id);
    poller.setActive(true);
    poller.setActive(false);

    fs.appendFileSync(s.file, "zz");
    poller.setActive(true);

    expect(seen).toEqual(["changed"]);
  });

  it("activating twice does not start a second interval that survives a single deactivate", () => {
    poller.setActive(true);
    poller.setActive(true);
    poller.setActive(false);

    const s = makeSession();
    const seen = recordFor(s.id);
    fs.writeFileSync(s.file, "x");
    advance(3);
    expect(seen).toEqual([]);
  });

  it("the disposable returned by start() stops polling", () => {
    const s = makeSession();
    fs.writeFileSync(s.file, "x");
    const seen = recordFor(s.id);
    const sub = poller.start();
    poller.setActive(true);

    sub.dispose();
    fs.appendFileSync(s.file, "yy");
    advance(2);
    expect(seen).toEqual([]);
  });

  it("a throwing onChange listener does not starve the others", () => {
    const s = makeSession();
    fs.writeFileSync(s.file, "a");
    poller.onChange(() => {
      throw new Error("boom");
    });
    const seen = recordFor(s.id);
    poller.setActive(true);

    fs.appendFileSync(s.file, "bb");
    advance();
    expect(seen).toEqual(["changed"]);
  });
});
