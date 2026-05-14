import { describe, expect, it } from "vitest";
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

describe("DetailHeaderView — in-place updates preserve DOM identity", () => {
  it("h2 and path elements survive across update calls", () => {
    const view = new DetailHeaderView();
    document.body.appendChild(view.element());
    view.update(baseDetail({ title: "First", cwd: "/p1" }));
    const h2 = view.element().querySelector("h2");
    const path = view.element().querySelector(".detail-path");
    view.update(baseDetail({ title: "Second", cwd: "/p2", model: { display_name: "Opus" } }));
    expect(view.element().querySelector("h2")).toBe(h2);
    expect(view.element().querySelector(".detail-path")).toBe(path);
  });

  it("shows aiTitle when present", () => {
    const view = new DetailHeaderView();
    view.update(baseDetail({ title: "Plan the migration" }));
    expect(view.element().querySelector("h2")!.textContent).toBe("Plan the migration");
  });

  it("falls back to short session id when no title", () => {
    const view = new DetailHeaderView();
    view.update(baseDetail({ title: null }));
    expect(view.element().querySelector("h2")!.textContent).toContain("Session");
  });

  it("hides model badge when no model present", () => {
    const view = new DetailHeaderView();
    view.update(baseDetail({ model: null }));
    const badge = view.element().querySelector(".model-badge") as HTMLElement;
    expect(badge.hidden).toBe(true);
  });

  it("shows model badge when display_name present", () => {
    const view = new DetailHeaderView();
    view.update(baseDetail({ model: { display_name: "Claude Opus 4.7" } }));
    const badge = view.element().querySelector(".model-badge") as HTMLElement;
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe("Claude Opus 4.7");
  });

  it("hides subtitle when no cwd", () => {
    const view = new DetailHeaderView();
    view.update(baseDetail({ cwd: null }));
    const subtitle = view.element().querySelector(".detail-subtitle") as HTMLElement;
    expect(subtitle.hidden).toBe(true);
  });
});
