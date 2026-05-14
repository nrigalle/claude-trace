import { beforeEach, describe, expect, it, vi } from "vitest";
import { DetailHeaderView } from "../../../media/src/ui/panels/DetailHeader";
import { toSessionId, type SessionDetail } from "../../../src/domain/types";

const baseDetail = (overrides: Partial<SessionDetail>): SessionDetail => ({
  session_id: toSessionId("abc123def"),
  title: null,
  event_count: 0,
  tool_count: 0,
  tools: [],
  duration_ms: 0,
  started_at: null,
  ended_at: null,
  cwd: null,
  cost: null,
  context_window: null,
  model: null,
  last_modified_ms: 0,
  events: [],
  tool_stats: [],
  context_timeline: [],
  cost_timeline: [],
  ...overrides,
});

const noopActions = { onRename: () => {}, onResume: () => {} };

describe("DetailHeaderView — display", () => {
  it("h2 and path elements survive across update calls", () => {
    const view = new DetailHeaderView(noopActions);
    document.body.appendChild(view.element());
    view.update(baseDetail({ title: "First", cwd: "/p1" }));
    const h2 = view.element().querySelector("h2");
    const path = view.element().querySelector(".detail-path");
    view.update(baseDetail({ title: "Second", cwd: "/p2", model: { display_name: "Opus" } }));
    expect(view.element().querySelector("h2")).toBe(h2);
    expect(view.element().querySelector(".detail-path")).toBe(path);
  });

  it("shows the AI title when present", () => {
    const view = new DetailHeaderView(noopActions);
    view.update(baseDetail({ title: "Plan the migration" }));
    expect(view.element().querySelector("h2")!.textContent).toBe("Plan the migration");
  });

  it("falls back to short session id when no title", () => {
    const view = new DetailHeaderView(noopActions);
    view.update(baseDetail({ title: null }));
    expect(view.element().querySelector("h2")!.textContent).toContain("Session");
  });

  it("hides model chip when no model present", () => {
    const view = new DetailHeaderView(noopActions);
    view.update(baseDetail({ model: null }));
    const chip = view.element().querySelector(".meta-chip.model") as HTMLElement;
    expect(chip.hidden).toBe(true);
  });

  it("shows model chip with display name", () => {
    const view = new DetailHeaderView(noopActions);
    view.update(baseDetail({ model: { display_name: "Claude Opus 4.7" } }));
    const chip = view.element().querySelector(".meta-chip.model") as HTMLElement;
    expect(chip.hidden).toBe(false);
    expect(chip.querySelector(".meta-chip-label")!.textContent).toBe("Claude Opus 4.7");
  });

  it("hides full path when cwd is null", () => {
    const view = new DetailHeaderView(noopActions);
    view.update(baseDetail({ cwd: null }));
    const path = view.element().querySelector(".detail-path") as HTMLElement;
    expect(path.hidden).toBe(true);
  });

  it("renders full path when cwd is set", () => {
    const view = new DetailHeaderView(noopActions);
    view.update(baseDetail({ cwd: "/home/x/p" }));
    const path = view.element().querySelector(".detail-path") as HTMLElement;
    expect(path.hidden).toBe(false);
    expect(path.textContent).toBe("/home/x/p");
  });
});

describe("DetailHeaderView — time-ago chip", () => {
  it("shows the relative time since ended_at", () => {
    const view = new DetailHeaderView(noopActions);
    const fiveMinutesAgo = Date.now() - 5 * 60_000;
    view.update(baseDetail({ ended_at: fiveMinutesAgo }));
    const chips = view.element().querySelectorAll(".meta-chip");
    const timeChip = chips[chips.length - 1] as HTMLElement;
    expect(timeChip.hidden).toBe(false);
    expect(timeChip.textContent).toContain("ago");
  });

  it("hides time chip when ended_at is null", () => {
    const view = new DetailHeaderView(noopActions);
    view.update(baseDetail({ ended_at: null }));
    const chips = view.element().querySelectorAll(".meta-chip");
    const timeChip = chips[chips.length - 1] as HTMLElement;
    expect(timeChip.hidden).toBe(true);
  });
});

describe("DetailHeaderView — action buttons", () => {
  let onRename: ReturnType<typeof vi.fn>;
  let onResume: ReturnType<typeof vi.fn>;
  let view: DetailHeaderView;

  beforeEach(() => {
    onRename = vi.fn();
    onResume = vi.fn();
    view = new DetailHeaderView({ onRename, onResume });
    document.body.appendChild(view.element());
  });

  const buttons = (): { rename: HTMLButtonElement; resume: HTMLButtonElement } => {
    const all = view.element().querySelectorAll<HTMLButtonElement>(".detail-action-btn");
    return { rename: all[0]!, resume: all[1]! };
  };

  it("renders Rename and Resume buttons", () => {
    const { rename, resume } = buttons();
    expect(rename.textContent).toContain("Rename");
    expect(resume.textContent).toContain("Resume");
  });

  it("buttons start disabled until a detail is shown", () => {
    const { rename, resume } = buttons();
    expect(rename.disabled).toBe(true);
    expect(resume.disabled).toBe(true);
  });

  it("buttons become enabled after first update", () => {
    view.update(baseDetail({ title: "anything" }));
    const { rename, resume } = buttons();
    expect(rename.disabled).toBe(false);
    expect(resume.disabled).toBe(false);
  });

  it("Rename click invokes onRename callback", () => {
    view.update(baseDetail({}));
    buttons().rename.click();
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("Resume click invokes onResume callback", () => {
    view.update(baseDetail({}));
    buttons().resume.click();
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("button DOM identity survives across updates", () => {
    view.update(baseDetail({ title: "a" }));
    const before = buttons();
    view.update(baseDetail({ title: "b" }));
    const after = buttons();
    expect(after.rename).toBe(before.rename);
    expect(after.resume).toBe(before.resume);
  });
});
