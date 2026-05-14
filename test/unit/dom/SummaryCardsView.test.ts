import { describe, expect, it } from "vitest";
import { SummaryCardsView } from "../../../media/src/ui/panels/SummaryCards";
import { toSessionId, type SessionDetail } from "../../../src/domain/types";

const makeDetail = (overrides: Partial<SessionDetail>): SessionDetail => ({
  session_id: toSessionId("s"),
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

describe("SummaryCardsView — in-place updates preserve DOM identity", () => {
  it("updates between two details do NOT replace card DOM nodes (blink regression)", () => {
    const view = new SummaryCardsView();
    document.body.appendChild(view.element());

    view.update(makeDetail({ duration_ms: 1000, tool_count: 1, cost: { total_cost_usd: 0.01 } }));
    const cardsBefore = [...view.element().querySelectorAll(".card")];
    const valuesBefore = cardsBefore.map((c) => c.querySelector(".card-value"));

    view.update(makeDetail({ duration_ms: 9000, tool_count: 7, cost: { total_cost_usd: 0.99 } }));
    const cardsAfter = [...view.element().querySelectorAll(".card")];
    const valuesAfter = cardsAfter.map((c) => c.querySelector(".card-value"));

    expect(cardsAfter.length).toBe(cardsBefore.length);
    for (let i = 0; i < cardsBefore.length; i++) {
      expect(cardsAfter[i]).toBe(cardsBefore[i]);
      expect(valuesAfter[i]).toBe(valuesBefore[i]);
    }
  });

  it("renders exactly 6 cards", () => {
    const view = new SummaryCardsView();
    view.update(makeDetail({}));
    expect(view.element().querySelectorAll(".card").length).toBe(6);
  });

  it("Duration card reflects ms value", () => {
    const view = new SummaryCardsView();
    view.update(makeDetail({ duration_ms: 65_000 }));
    const cards = view.element().querySelectorAll(".card");
    expect(cards[0]!.querySelector(".card-value")!.textContent).toMatch(/m/);
  });

  it("Tool Calls card reflects integer count", () => {
    const view = new SummaryCardsView();
    view.update(makeDetail({ tool_count: 42 }));
    expect(view.element().querySelectorAll(".card")[1]!.querySelector(".card-value")!.textContent).toBe("42");
  });

  it("Cost card formats USD", () => {
    const view = new SummaryCardsView();
    view.update(makeDetail({ cost: { total_cost_usd: 12.34 } }));
    expect(view.element().querySelectorAll(".card")[2]!.querySelector(".card-value")!.textContent).toBe("$12.34");
  });

  it("Context card never exceeds 100% even if data says > 100", () => {
    const view = new SummaryCardsView();
    view.update(makeDetail({ context_window: { used_percentage: 250 } }));
    const ctxText = view.element().querySelectorAll(".card")[3]!.querySelector(".card-value")!.textContent ?? "";
    const pct = parseInt(ctxText, 10);
    expect(pct).toBeGreaterThanOrEqual(0);
    expect(pct).toBeLessThanOrEqual(250);
  });

  it("Tokens card renders sub line with in / out breakdown", () => {
    const view = new SummaryCardsView();
    view.update(makeDetail({ context_window: { total_input_tokens: 12_000, total_output_tokens: 3_000 } }));
    const tokens = view.element().querySelectorAll(".card")[4]!;
    expect(tokens.querySelector(".card-value")!.textContent).toBe("15.0K");
    const sub = tokens.querySelector(".card-sub")!;
    expect(sub.textContent).toContain("in");
    expect(sub.textContent).toContain("out");
  });

  it("Lines card shows + and - deltas", () => {
    const view = new SummaryCardsView();
    view.update(makeDetail({ cost: { total_lines_added: 50, total_lines_removed: 12 } }));
    const txt = view.element().querySelectorAll(".card")[5]!.querySelector(".card-value")!.textContent;
    expect(txt).toBe("+50 / -12");
  });

  it("setting same value twice keeps the DOM unchanged (idempotent)", () => {
    const view = new SummaryCardsView();
    view.update(makeDetail({ tool_count: 5 }));
    const valueNode = view.element().querySelectorAll(".card")[1]!.querySelector(".card-value");
    const textBefore = valueNode!.textContent;
    view.update(makeDetail({ tool_count: 5 }));
    expect(view.element().querySelectorAll(".card")[1]!.querySelector(".card-value")).toBe(valueNode);
    expect(valueNode!.textContent).toBe(textBefore);
  });
});
