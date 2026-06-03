import { describe, expect, it, beforeEach } from "vitest";
import { LibraryApp } from "../../../media/src/library/LibraryApp";
import {
  toAgentName,
  toProjectPath,
  toSkillName,
  type LibrarySnapshot,
} from "../../../src/features/library/domain/types";
import type { LibraryWebviewToHost } from "../../../src/features/library/protocol";

const snapshot = (over: Partial<LibrarySnapshot> = {}): LibrarySnapshot => ({
  skills: [],
  agents: [],
  projects: [],
  ...over,
});

const banking = toProjectPath("/p/banking");
const inventory = toProjectPath("/p/inventory");

const baseSnapshot = snapshot({
  projects: [
    { path: banking, label: "banking-edge", source: "workspace" },
    { path: inventory, label: "inventory-svc", source: "tracked" },
  ],
  skills: [
    {
      name: toSkillName("code-review"),
      frontmatter: { name: "code-review", description: "Reviews diffs" },
      body: "",
      resources: [],
      scope: { kind: "global" },
      updatedAtMs: 0,
    },
    {
      name: toSkillName("lint"),
      frontmatter: { name: "lint", description: "Lints code" },
      body: "",
      resources: [],
      scope: { kind: "projects", paths: [banking] },
      updatedAtMs: 0,
    },
    {
      name: toSkillName("drafts"),
      frontmatter: { name: "drafts", description: "Unassigned drafts" },
      body: "",
      resources: [],
      scope: { kind: "unassigned" },
      updatedAtMs: 0,
    },
  ],
  agents: [
    {
      name: toAgentName("reviewer"),
      frontmatter: { name: "reviewer", description: "code reviewer" },
      body: "prompt",
      scope: { kind: "global" },
      attachedSkills: [toSkillName("code-review")],
      updatedAtMs: 0,
    },
  ],
});

let sent: LibraryWebviewToHost[] = [];

const mount = (): { app: LibraryApp; root: HTMLElement } => {
  sent = [];
  const app = new LibraryApp({ send: (m) => sent.push(m) });
  document.body.appendChild(app.element());
  return { app, root: app.element() };
};

beforeEach(() => {
  document.body.innerHTML = "";
  sent = [];
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const findModalInput = (): HTMLInputElement | null =>
  document.querySelector(".ct-modal-overlay .ct-modal-input") as HTMLInputElement | null;

const findModalPrimary = (): HTMLButtonElement | null =>
  document.querySelector(".ct-modal-overlay .ct-modal-primary") as HTMLButtonElement | null;

const findModalGhost = (): HTMLButtonElement | null =>
  document.querySelector(".ct-modal-overlay .ct-modal-ghost") as HTMLButtonElement | null;

const waitForModal = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) {
    if (document.querySelector(".ct-modal-overlay")) return;
    await tick();
  }
};

const closeAfterAnimation = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) {
    if (!document.querySelector(".ct-modal-overlay")) return;
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("LibraryApp filter", () => {
  it("renders all library items by default", () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    const titles = [...root.querySelectorAll(".lib-row-title")].map((n) => n.textContent);
    expect(titles).toContain("code-review");
    expect(titles).toContain("lint");
    expect(titles).toContain("drafts");
  });

  it("filters to only items assigned to a specific project", () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    const select = root.querySelector(".lib-filter-select") as HTMLSelectElement;
    select.value = `project:${banking as string}`;
    select.dispatchEvent(new Event("change"));
    const titles = [...root.querySelectorAll(".lib-row-title")].map((n) => n.textContent);
    expect(titles).toEqual(["lint"]);
  });

  it("filters to only globally-scoped items", () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    const select = root.querySelector(".lib-filter-select") as HTMLSelectElement;
    select.value = "global";
    select.dispatchEvent(new Event("change"));
    const titles = [...root.querySelectorAll(".lib-row-title")].map((n) => n.textContent);
    expect(titles).toEqual(["code-review"]);
  });

  it("filters to unassigned items only", () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    const select = root.querySelector(".lib-filter-select") as HTMLSelectElement;
    select.value = "unassigned";
    select.dispatchEvent(new Event("change"));
    const titles = [...root.querySelectorAll(".lib-row-title")].map((n) => n.textContent);
    expect(titles).toEqual(["drafts"]);
  });

  it("resets the filter to All when the previously selected project disappears", () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    const select = root.querySelector(".lib-filter-select") as HTMLSelectElement;
    select.value = `project:${banking as string}`;
    select.dispatchEvent(new Event("change"));
    const reduced = { ...baseSnapshot, projects: [baseSnapshot.projects[1]!] };
    app.receive({ type: "librarySnapshot", snapshot: reduced });
    const titles = [...root.querySelectorAll(".lib-row-title")].map((n) => n.textContent);
    expect(titles.length).toBeGreaterThan(1);
  });
});
describe("LibraryApp bulk delete (multi-select)", () => {
  const rowCheck = (root: HTMLElement, title: string): HTMLButtonElement => {
    const row = [...root.querySelectorAll(".lib-row")].find(
      (r) => r.querySelector(".lib-row-title")?.textContent === title,
    );
    if (!row) throw new Error(`row not found: ${title}`);
    return row.querySelector(".lib-row-check") as HTMLButtonElement;
  };

  it("selects multiple skills and sends one deleteSkillsBulk with every selected name", async () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });

    (root.querySelector(".lib-select-btn") as HTMLButtonElement).click();
    expect(root.querySelectorAll(".lib-row-check").length).toBe(3);

    rowCheck(root, "code-review").click();
    rowCheck(root, "lint").click();

    const delBtn = root.querySelector(".lib-bulk-delete-btn") as HTMLButtonElement;
    expect(delBtn.hasAttribute("disabled")).toBe(false);
    delBtn.click();
    await waitForModal();
    expect(findModalPrimary()?.textContent).toBe("Delete 2");
    findModalPrimary()!.click();
    await closeAfterAnimation();

    const bulk = sent.find((m) => m.type === "deleteSkillsBulk") as
      | { type: "deleteSkillsBulk"; names: readonly string[] }
      | undefined;
    expect(bulk).toBeDefined();
    expect([...bulk!.names].map(String).sort()).toEqual(["code-review", "lint"]);
  });

  it("Select all then delete removes every visible skill in one message", async () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    (root.querySelector(".lib-select-btn") as HTMLButtonElement).click();
    (root.querySelector(".lib-bulk-checkall") as HTMLButtonElement).click();
    (root.querySelector(".lib-bulk-delete-btn") as HTMLButtonElement).click();
    await waitForModal();
    findModalPrimary()!.click();
    await closeAfterAnimation();

    const bulk = sent.find((m) => m.type === "deleteSkillsBulk") as
      | { type: "deleteSkillsBulk"; names: readonly string[] }
      | undefined;
    expect(bulk).toBeDefined();
    expect([...bulk!.names].map(String).sort()).toEqual(["code-review", "drafts", "lint"]);
  });

  it("selects multiple agents and sends one deleteAgentsBulk with every selected name", async () => {
    const twoAgents = snapshot({
      agents: [
        { name: toAgentName("reviewer"), frontmatter: { name: "reviewer", description: "" }, body: "", scope: { kind: "global" }, attachedSkills: [], updatedAtMs: 0 },
        { name: toAgentName("planner"), frontmatter: { name: "planner", description: "" }, body: "", scope: { kind: "global" }, attachedSkills: [], updatedAtMs: 0 },
      ],
    });
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: twoAgents });
    const agentsTab = [...root.querySelectorAll(".lib-seg")].find((b) => b.textContent === "Agents") as HTMLButtonElement;
    agentsTab.click();

    (root.querySelector(".lib-select-btn") as HTMLButtonElement).click();
    rowCheck(root, "reviewer").click();
    rowCheck(root, "planner").click();
    (root.querySelector(".lib-bulk-delete-btn") as HTMLButtonElement).click();
    await waitForModal();
    findModalPrimary()!.click();
    await closeAfterAnimation();

    const bulk = sent.find((m) => m.type === "deleteAgentsBulk") as
      | { type: "deleteAgentsBulk"; names: readonly string[] }
      | undefined;
    expect(bulk).toBeDefined();
    expect([...bulk!.names].map(String).sort()).toEqual(["planner", "reviewer"]);
  });
});

describe("LibraryApp delete affordance", () => {
  it("each row has a delete button that requests deletion when the modal is confirmed", async () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    const rows = root.querySelectorAll(".lib-row");
    expect(rows.length).toBe(3);
    rows.forEach((r) => expect(r.querySelector(".lib-row-delete")).toBeTruthy());

    const codeReviewRow = [...rows].find((r) => r.querySelector(".lib-row-title")?.textContent === "code-review");
    expect(codeReviewRow).toBeDefined();
    (codeReviewRow!.querySelector(".lib-row-delete") as HTMLButtonElement).click();
    await waitForModal();
    expect(document.querySelector(".ct-modal-overlay")).toBeTruthy();
    const confirmBtn = findModalPrimary();
    expect(confirmBtn?.textContent).toBe("Delete");
    confirmBtn!.click();
    await closeAfterAnimation();
    expect(sent.some((m) => m.type === "deleteSkill" && (m as { name: string }).name === "code-review")).toBe(true);
  });

  it("does not delete when the user cancels the modal", async () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    const row = root.querySelector(".lib-row");
    (row!.querySelector(".lib-row-delete") as HTMLButtonElement).click();
    await waitForModal();
    findModalGhost()!.click();
    await closeAfterAnimation();
    expect(sent.some((m) => m.type === "deleteSkill")).toBe(false);
  });

  it("clicking the delete button does not select the row", async () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    const row = root.querySelector(".lib-row");
    (row!.querySelector(".lib-row-delete") as HTMLButtonElement).click();
    await waitForModal();
    findModalGhost()!.click();
    await closeAfterAnimation();
    expect(row!.classList.contains("selected")).toBe(false);
  });
});

describe("LibraryApp New button (modal-driven, does not use blocked window.prompt)", () => {
  it("opens a modal, then clicking Create sends createSkill with the normalized name", async () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    const newBtn = root.querySelector(".lib-new-btn") as HTMLButtonElement;
    newBtn.click();
    await waitForModal();
    const input = findModalInput();
    expect(input).toBeTruthy();
    input!.value = "Release Notes";
    input!.dispatchEvent(new Event("input"));
    findModalPrimary()!.click();
    await closeAfterAnimation();
    const created = sent.find((m) => m.type === "createSkill");
    expect(created).toBeDefined();
    expect((created as { name: string }).name).toBe("release-notes");
  });

  it("opens a modal on the Agents tab and sends createAgent on confirm", async () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    const agentsTab = [...root.querySelectorAll(".lib-seg")].find((b) => b.textContent === "Agents") as HTMLButtonElement;
    agentsTab.click();
    const newBtn = root.querySelector(".lib-new-btn") as HTMLButtonElement;
    newBtn.click();
    await waitForModal();
    findModalInput()!.value = "code-critic";
    findModalInput()!.dispatchEvent(new Event("input"));
    findModalPrimary()!.click();
    await closeAfterAnimation();
    const created = sent.find((m) => m.type === "createAgent");
    expect(created).toBeDefined();
    expect((created as { name: string }).name).toBe("code-critic");
  });

  it("blocks creation and shows an error when the name collides with an existing item", async () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    (root.querySelector(".lib-new-btn") as HTMLButtonElement).click();
    await waitForModal();
    findModalInput()!.value = "code-review";
    findModalInput()!.dispatchEvent(new Event("input"));
    findModalPrimary()!.click();
    await tick();
    expect(document.querySelector(".ct-modal-overlay")).toBeTruthy();
    expect(document.querySelector(".ct-modal-error.show")?.textContent ?? "").toContain("already exists");
    expect(sent.some((m) => m.type === "createSkill")).toBe(false);
  });

  it("blocks creation and shows an error when the name is empty", async () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    (root.querySelector(".lib-new-btn") as HTMLButtonElement).click();
    await waitForModal();
    findModalInput()!.value = "   ";
    findModalInput()!.dispatchEvent(new Event("input"));
    findModalPrimary()!.click();
    await tick();
    expect(document.querySelector(".ct-modal-overlay")).toBeTruthy();
    expect(sent.some((m) => m.type === "createSkill")).toBe(false);
  });

  it("Cancel closes the modal and sends nothing", async () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    (root.querySelector(".lib-new-btn") as HTMLButtonElement).click();
    await waitForModal();
    findModalGhost()!.click();
    await closeAfterAnimation();
    expect(sent.some((m) => m.type === "createSkill" || m.type === "createAgent")).toBe(false);
  });

  it("does not rely on window.prompt at all — keeping window.prompt undefined still works", async () => {
    const original = (window as unknown as { prompt: unknown }).prompt;
    (window as unknown as { prompt: unknown }).prompt = undefined;
    try {
      const { app, root } = mount();
      app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
      (root.querySelector(".lib-new-btn") as HTMLButtonElement).click();
      await waitForModal();
      findModalInput()!.value = "shipping-tools";
      findModalInput()!.dispatchEvent(new Event("input"));
      findModalPrimary()!.click();
      await closeAfterAnimation();
      const created = sent.find((m) => m.type === "createSkill");
      expect(created).toBeDefined();
      expect((created as { name: string }).name).toBe("shipping-tools");
    } finally {
      (window as unknown as { prompt: unknown }).prompt = original;
    }
  });
});

describe("LibraryApp first-open auto import scan", () => {
  it("automatically asks the host to scan when the first snapshot arrives empty", () => {
    const { app } = mount();
    app.receive({ type: "librarySnapshot", snapshot: snapshot() });
    expect(sent.some((m) => m.type === "scanForImports")).toBe(true);
  });

  it("does NOT auto-scan when the library already has items on first open", () => {
    const { app } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    expect(sent.some((m) => m.type === "scanForImports")).toBe(false);
  });

  it("does not re-scan automatically on subsequent snapshots, even if the library becomes empty later", () => {
    const { app } = mount();
    app.receive({ type: "librarySnapshot", snapshot: snapshot() });
    const firstScans = sent.filter((m) => m.type === "scanForImports").length;
    expect(firstScans).toBe(1);
    sent.length = 0;
    app.receive({ type: "librarySnapshot", snapshot: snapshot() });
    expect(sent.some((m) => m.type === "scanForImports")).toBe(false);
  });

  it("shows the import sheet automatically when candidates come back and offers to import them", () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: snapshot() });
    app.receive({
      type: "libraryImportCandidates",
      candidates: [
        { kind: "skill", name: "code-review", origin: "global", description: "" },
        { kind: "agent", name: "reviewer", origin: "global", description: "" },
      ],
    });
    const sheet = root.querySelector(".lib-import-sheet");
    expect(sheet).toBeTruthy();
    expect(sheet!.textContent).toContain("code-review");
    expect(sheet!.textContent).toContain("reviewer");
  });

  it("the empty-state surfaces a 'Found N on your machine' affordance after the scan completes", () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: snapshot() });
    app.receive({
      type: "libraryImportCandidates",
      candidates: [
        { kind: "skill", name: "lint", origin: "global", description: "" },
      ],
    });
    document.querySelector(".lib-import-sheet")?.querySelector(".lib-ghost-btn")?.dispatchEvent(new Event("click"));
    const empty = root.querySelector(".lib-list-empty");
    expect(empty?.textContent ?? "").toContain("Found 1 on your machine");
  });
});

describe("LibraryApp Skills/Agents tabs", () => {
  it("switching to Agents shows the agent list", () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    const agentsTab = [...root.querySelectorAll(".lib-seg")].find((b) => b.textContent === "Agents") as HTMLButtonElement;
    agentsTab.click();
    const titles = [...root.querySelectorAll(".lib-row-title")].map((n) => n.textContent);
    expect(titles).toEqual(["reviewer"]);
  });
});

describe("LibraryApp — assistant body-apply 100% guarantee", () => {
  const openItem = (root: HTMLElement, name: string): void => {
    const row = [...root.querySelectorAll(".lib-row-main")].find((r) => r.querySelector(".lib-row-title")?.textContent === name) as HTMLElement;
    row.click();
  };

  const findBodyTextarea = (root: HTMLElement): HTMLTextAreaElement | null =>
    root.querySelector('[data-section="body"] .ct-ta-input') as HTMLTextAreaElement | null;

  const openAssistantPanel = (root: HTMLElement): void => {
    const btn = root.querySelector(".lib-assist-btn") as HTMLButtonElement;
    btn.click();
  };

  const findInputTextarea = (root: HTMLElement): HTMLTextAreaElement =>
    root.querySelector(".lib-asst-input .ct-ta-input") as HTMLTextAreaElement;

  const activeCid = (): string => {
    for (let i = sent.length - 1; i >= 0; i--) {
      const m = sent[i]!;
      if (m.type === "assistantAsk") return m.conversationId;
    }
    return "c-none";
  };

  const sendThenReply = (root: HTMLElement, app: LibraryApp, message: string, reply: string): void => {
    const input = findInputTextarea(root);
    input.value = message;
    (root.querySelector(".lib-asst-send") as HTMLButtonElement).click();
    app.receive({
      type: "assistantReply",
      itemKey: "skill:code-review",
      conversationId: activeCid(),
      events: [{ kind: "text", text: reply }],
      text: reply,
      suggestedDescription: null,
    });
  };

  it("an assistantReply in writeBody mode lands the text in the body textarea exactly", async () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    openItem(root, "code-review");
    openAssistantPanel(root);
    await new Promise((r) => setTimeout(r, 0));

    sendThenReply(root, app, "draft", "## new body\n\nFresh content from Claude.");
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));

    const body = findBodyTextarea(root);
    expect(body).not.toBeNull();
    expect(body!.value).toBe("## new body\n\nFresh content from Claude.");
  });

  it("an assistantReply while user is on the Assignments sub-tab still lands the body (auto-switches to Edit)", async () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    openItem(root, "code-review");
    const assignTab = [...root.querySelectorAll(".lib-editor-tab")].find((b) => b.textContent === "Assignments") as HTMLButtonElement;
    assignTab.click();
    openAssistantPanel(root);
    await new Promise((r) => setTimeout(r, 0));

    expect(findBodyTextarea(root)).toBeNull();

    sendThenReply(root, app, "draft", "auto-tab-switch body content");
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));

    const body = findBodyTextarea(root);
    expect(body).not.toBeNull();
    expect(body!.value).toBe("auto-tab-switch body content");
  });

  it("subsequent replies REPLACE the body (multi-turn iteration), not append", async () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    openItem(root, "code-review");
    openAssistantPanel(root);
    await new Promise((r) => setTimeout(r, 0));

    sendThenReply(root, app, "v1", "version one");
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    sendThenReply(root, app, "v2", "version two");
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));

    const body = findBodyTextarea(root);
    expect(body!.value).toBe("version two");
  });

  it("a suggested description lands in the description field automatically", async () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    openItem(root, "code-review");
    openAssistantPanel(root);
    await new Promise((r) => setTimeout(r, 0));

    const input = findInputTextarea(root);
    input.value = "draft";
    (root.querySelector(".lib-asst-send") as HTMLButtonElement).click();
    app.receive({
      type: "assistantReply",
      itemKey: "skill:code-review",
      conversationId: activeCid(),
      events: [{ kind: "text", text: "body" }],
      text: "body",
      suggestedDescription: "A tightened description.",
    });
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));

    const desc = root.querySelector('[data-field="description"] .ct-ta-input') as HTMLTextAreaElement;
    expect(desc.value).toBe("A tightened description.");
  });

  it("an empty assistantReply does NOT clobber the existing body field", async () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: baseSnapshot });
    openItem(root, "code-review");
    openAssistantPanel(root);
    await new Promise((r) => setTimeout(r, 0));

    const body = findBodyTextarea(root)!;
    body.value = "user-typed content stays put";
    body.dispatchEvent(new Event("input", { bubbles: true }));

    const input = findInputTextarea(root);
    input.value = "go";
    (root.querySelector(".lib-asst-send") as HTMLButtonElement).click();
    app.receive({
      type: "assistantReply",
      itemKey: "skill:code-review",
      conversationId: activeCid(),
      events: [],
      text: "",
      suggestedDescription: null,
    });
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));

    const bodyAfter = findBodyTextarea(root)!;
    expect(bodyAfter.value).toBe("user-typed content stays put");
  });
});

describe("LibraryApp — multi-select bulk delete", () => {
  const populated = (): LibrarySnapshot => ({
    projects: [],
    agents: [],
    skills: [
      { name: toSkillName("a"), frontmatter: { description: "Skill A" }, body: "", resources: [], scope: { kind: "global" }, updatedAtMs: 0 },
      { name: toSkillName("b"), frontmatter: { description: "Skill B" }, body: "", resources: [], scope: { kind: "global" }, updatedAtMs: 0 },
      { name: toSkillName("c"), frontmatter: { description: "Skill C" }, body: "", resources: [], scope: { kind: "global" }, updatedAtMs: 0 },
    ],
  });

  const findRows = (root: HTMLElement): HTMLElement[] => Array.from(root.querySelectorAll(".lib-row")) as HTMLElement[];
  const findSelectBtn = (root: HTMLElement): HTMLButtonElement => root.querySelector(".lib-select-btn")! as HTMLButtonElement;
  const findBulkBar = (root: HTMLElement): HTMLElement => root.querySelector(".lib-bulk-bar")! as HTMLElement;
  const findBulkDelete = (root: HTMLElement): HTMLButtonElement => root.querySelector(".lib-bulk-delete-btn")! as HTMLButtonElement;

  it("starts hidden; clicking Select reveals the bulk bar and shows row checkboxes", () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: populated() });
    expect(findBulkBar(root).hasAttribute("hidden")).toBe(true);
    findSelectBtn(root).click();
    expect(findBulkBar(root).hasAttribute("hidden")).toBe(false);
    expect(root.querySelectorAll(".lib-row-check").length).toBe(3);
  });

  it("clicking a row in select mode toggles a checkbox; second click deselects", () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: populated() });
    findSelectBtn(root).click();
    const rows = findRows(root);
    (rows[0]!.querySelector(".lib-row-main") as HTMLButtonElement).click();
    expect(root.querySelectorAll(".lib-row-check.checked").length).toBe(1);
    expect(root.querySelector(".lib-bulk-count")!.textContent).toBe("1 selected");
    (rows[0]!.querySelector(".lib-row-main") as HTMLButtonElement).click();
    expect(root.querySelectorAll(".lib-row-check.checked").length).toBe(0);
    expect(root.querySelector(".lib-bulk-count")!.textContent).toBe("Select items to delete");
  });

  it("the bulk Delete button is disabled until something is selected", () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: populated() });
    findSelectBtn(root).click();
    expect(findBulkDelete(root).hasAttribute("disabled")).toBe(true);
    (findRows(root)[0]!.querySelector(".lib-row-main") as HTMLButtonElement).click();
    expect(findBulkDelete(root).hasAttribute("disabled")).toBe(false);
  });

  it("Select all checkbox selects every visible row at once", () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: populated() });
    findSelectBtn(root).click();
    (root.querySelector(".lib-bulk-checkall") as HTMLButtonElement).click();
    expect(root.querySelectorAll(".lib-row-check.checked").length).toBe(3);
    expect(root.querySelector(".lib-bulk-count")!.textContent).toBe("3 selected");
    expect(root.querySelector(".lib-bulk-checkall")!.classList.contains("lib-bulk-state-all")).toBe(true);
  });

  it("Select all again deselects everything", () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: populated() });
    findSelectBtn(root).click();
    const all = root.querySelector(".lib-bulk-checkall") as HTMLButtonElement;
    all.click();
    expect(root.querySelectorAll(".lib-row-check.checked").length).toBe(3);
    (root.querySelector(".lib-bulk-checkall") as HTMLButtonElement).click();
    expect(root.querySelectorAll(".lib-row-check.checked").length).toBe(0);
  });

  it("Confirm + Delete sends deleteSkillsBulk with every selected name", async () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: populated() });
    findSelectBtn(root).click();
    (root.querySelector(".lib-bulk-checkall") as HTMLButtonElement).click();
    findBulkDelete(root).click();
    await waitForModal();
    findModalPrimary()!.click();
    await closeAfterAnimation();
    const bulkMsg = sent.find((m) => m.type === "deleteSkillsBulk");
    expect(bulkMsg).toBeDefined();
    expect((bulkMsg as { names: string[] }).names.sort()).toEqual(["a", "b", "c"]);
  });

  it("Cancel on the confirm modal sends no delete", async () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: populated() });
    findSelectBtn(root).click();
    (findRows(root)[1]!.querySelector(".lib-row-main") as HTMLButtonElement).click();
    findBulkDelete(root).click();
    await waitForModal();
    findModalGhost()!.click();
    await closeAfterAnimation();
    expect(sent.some((m) => m.type === "deleteSkillsBulk")).toBe(false);
  });

  it("turning Select off clears the selection and hides the bulk bar", () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: populated() });
    findSelectBtn(root).click();
    (findRows(root)[0]!.querySelector(".lib-row-main") as HTMLButtonElement).click();
    findSelectBtn(root).click();
    expect(findBulkBar(root).hasAttribute("hidden")).toBe(true);
    findSelectBtn(root).click();
    expect(root.querySelectorAll(".lib-row-check.checked").length).toBe(0);
  });

  it("switching to Agents tab in select mode resets the selection set", () => {
    const populatedAll = (): LibrarySnapshot => ({
      projects: [],
      skills: populated().skills,
      agents: [
        { name: toAgentName("agent1"), frontmatter: { description: "" }, body: "", scope: { kind: "global" }, attachedSkills: [], updatedAtMs: 0 },
        { name: toAgentName("agent2"), frontmatter: { description: "" }, body: "", scope: { kind: "global" }, attachedSkills: [], updatedAtMs: 0 },
      ],
    });
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: populatedAll() });
    findSelectBtn(root).click();
    (root.querySelector(".lib-bulk-checkall") as HTMLButtonElement).click();
    expect(root.querySelector(".lib-bulk-count")!.textContent).toBe("3 selected");
    (root.querySelectorAll(".lib-seg")[1] as HTMLButtonElement).click();
    expect(root.querySelector(".lib-bulk-count")!.textContent).toBe("Select items to delete");
  });

  it("clicking a row in select mode does NOT open the editor (no row.selected)", () => {
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: populated() });
    findSelectBtn(root).click();
    (findRows(root)[0]!.querySelector(".lib-row-main") as HTMLButtonElement).click();
    expect(root.querySelectorAll(".lib-row.selected").length).toBe(0);
  });

  it("the Agents tab supports bulk delete via deleteAgentsBulk", async () => {
    const populatedAgents = (): LibrarySnapshot => ({
      projects: [],
      skills: [],
      agents: [
        { name: toAgentName("a1"), frontmatter: { description: "" }, body: "", scope: { kind: "global" }, attachedSkills: [], updatedAtMs: 0 },
        { name: toAgentName("a2"), frontmatter: { description: "" }, body: "", scope: { kind: "global" }, attachedSkills: [], updatedAtMs: 0 },
      ],
    });
    const { app, root } = mount();
    app.receive({ type: "librarySnapshot", snapshot: populatedAgents() });
    (root.querySelectorAll(".lib-seg")[1] as HTMLButtonElement).click();
    findSelectBtn(root).click();
    (root.querySelector(".lib-bulk-checkall") as HTMLButtonElement).click();
    findBulkDelete(root).click();
    await waitForModal();
    findModalPrimary()!.click();
    await closeAfterAnimation();
    const bulkMsg = sent.find((m) => m.type === "deleteAgentsBulk");
    expect(bulkMsg).toBeDefined();
    expect((bulkMsg as { names: string[] }).names.sort()).toEqual(["a1", "a2"]);
  });
});
