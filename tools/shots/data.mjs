const HOUR = 3600_000;
const MIN = 60_000;
const now = Date.now();

const opus = { display_name: "Opus 4.7", id: "claude-opus-4-7" };
const sonnet = { display_name: "Sonnet 4.6", id: "claude-sonnet-4-6" };
const haiku = { display_name: "Haiku 4.5", id: "claude-haiku-4-5" };

const session = (o) => ({
  session_id: o.id,
  title: o.title,
  event_count: o.events ?? 180,
  tool_count: o.tools ?? 64,
  tools: ["Read", "Edit", "Bash", "Grep", "Write"],
  duration_ms: o.duration ?? 42 * MIN,
  started_at: now - (o.ageH ?? 2) * HOUR,
  ended_at: now - (o.ageH ?? 2) * HOUR + (o.duration ?? 42 * MIN),
  cwd: o.cwd,
  cost: { total_cost_usd: o.cost, total_lines_added: o.add ?? 0, total_lines_removed: o.rem ?? 0 },
  context_window: {
    used_percentage: o.ctx ?? 41,
    total_input_tokens: o.inTok ?? 82000,
    total_output_tokens: o.outTok ?? 14500,
    context_window_size: o.model === opus ? 1_000_000 : 200_000,
  },
  model: o.model,
  last_modified_ms: now - (o.ageH ?? 2) * HOUR,
  pinned: !!o.pinned,
  searchable_text: o.title,
});

export const sessions = [
  session({ id: "9f2a-checkout", title: "Stripe checkout + webhook retries", cwd: "/Users/alex/code/payments-api", cost: 4.82, model: sonnet, ageH: 1, ctx: 63, add: 412, rem: 88, pinned: true, tools: 91 }),
  session({ id: "3b7c-authmw", title: "Rewrite auth middleware to async", cwd: "/Users/alex/code/payments-api", cost: 2.14, model: sonnet, ageH: 3, ctx: 38, add: 156, rem: 203, tools: 47 }),
  session({ id: "11de-flaky", title: "Track down flaky checkout e2e test", cwd: "/Users/alex/code/web-app", cost: 0.91, model: haiku, ageH: 5, ctx: 22, add: 12, rem: 9, tools: 28 }),
  session({ id: "7a44-migrate", title: "Migrate Postgres 14 to 16, fix enums", cwd: "/Users/alex/code/banking-edge", cost: 9.37, model: opus, ageH: 26, ctx: 71, add: 890, rem: 311, pinned: true, tools: 134, duration: 88 * MIN }),
  session({ id: "c0e1-dash", title: "Customizable dashboard panels", cwd: "/Users/alex/code/claude-trace", cost: 3.05, model: sonnet, ageH: 28, ctx: 44, add: 274, rem: 61, tools: 73 }),
  session({ id: "5d92-rate", title: "Rate limiter for public API", cwd: "/Users/alex/code/banking-edge", cost: 1.66, model: sonnet, ageH: 50, ctx: 29, add: 98, rem: 14, tools: 39 }),
];

export const stats = {
  total_sessions: 137,
  total_tool_calls: 8420,
  total_duration_ms: 312 * HOUR,
  total_cost_usd: 286.43,
};

export const update = {
  type: "update",
  sessions,
  stats,
  changedIds: [],
  removedIds: [],
};

const tick = (i) => now - (60 - i) * MIN;
const ctxCurve = [6, 11, 17, 19, 24, 28, 33, 37, 35, 41, 46, 52, 55, 58, 61, 60, 63];
const costCurve = [0.2, 0.5, 0.7, 0.9, 1.2, 1.5, 1.9, 2.2, 2.5, 2.9, 3.3, 3.6, 4.0, 4.2, 4.5, 4.7, 4.82];

const ev = (i, o) => ({
  ts: tick(i),
  event: o.event,
  session_id: "9f2a-checkout",
  cwd: "/Users/alex/code/payments-api",
  tool_name: o.tool ?? null,
  tool_input: o.input ?? null,
  tool_result: o.result ?? null,
  stop_reason: null,
  model: sonnet,
  cost: o.cost ?? null,
  context_window: null,
  tokens_freed: null,
  error: o.error ?? null,
  is_sidechain: false,
});

const events = [
  ev(0, { event: "UserPrompt", result: "Add a Stripe webhook handler that verifies the signature and retries failed charge events with exponential backoff." }),
  ev(1, { event: "PostToolUse", tool: "Read", input: { file_path: "src/payments/webhook.ts" }, result: "export async function handleWebhook(req: Request) { ... }" }),
  ev(2, { event: "PostToolUse", tool: "Grep", input: { pattern: "constructEvent", path: "src" }, result: "src/payments/stripe.ts:42" }),
  ev(3, { event: "AssistantText", result: "The handler is missing signature verification. I'll add `stripe.webhooks.constructEvent` and a retry queue." }),
  ev(4, { event: "PostToolUse", tool: "Edit", input: { file_path: "src/payments/webhook.ts", old_string: "JSON.parse(body)", new_string: "stripe.webhooks.constructEvent(body, sig, secret)" }, result: "Edited src/payments/webhook.ts" }),
  ev(5, { event: "PostToolUse", tool: "Write", input: { file_path: "src/payments/retry.ts" }, result: "Created src/payments/retry.ts (74 lines)" }),
  ev(6, { event: "PostToolUse", tool: "Bash", input: { command: "npm test -- payments" }, result: "FAIL  payments/webhook.test.ts — invalid signature (expected)" }),
  ev(7, { event: "AssistantText", result: "One test asserts the old parse path. Updating the fixture to sign the payload." }),
  ev(8, { event: "PostToolUse", tool: "Edit", input: { file_path: "test/payments/webhook.test.ts" }, result: "Edited test/payments/webhook.test.ts" }),
  ev(9, { event: "PostToolUse", tool: "Bash", input: { command: "npm test -- payments" }, result: "PASS  payments/webhook.test.ts (12 tests)" }),
  ev(10, { event: "Metrics", cost: { total_cost_usd: 4.82 } }),
];

export const detail = {
  type: "sessionDetail",
  sessionId: "9f2a-checkout",
  detail: {
    ...sessions[0],
    events,
    tool_stats: [
      { name: "Read", count: 31 },
      { name: "Edit", count: 24 },
      { name: "Bash", count: 18 },
      { name: "Grep", count: 11 },
      { name: "Write", count: 5 },
      { name: "TodoWrite", count: 2 },
    ],
    context_timeline: ctxCurve.map((value, i) => ({ ts: tick(i), value })),
    cost_timeline: costCurve.map((value, i) => ({ ts: tick(i), value })),
    files_touched: [
      { filePath: "/Users/alex/code/payments-api/src/payments/webhook.ts", fileName: "webhook.ts", latestTs: now - 5 * MIN, count: 4, added: 63, removed: 21, dominantAction: "edit", changes: [] },
      { filePath: "/Users/alex/code/payments-api/src/payments/retry.ts", fileName: "retry.ts", latestTs: now - 9 * MIN, count: 1, added: 74, removed: 0, dominantAction: "write", changes: [] },
      { filePath: "/Users/alex/code/payments-api/test/payments/webhook.test.ts", fileName: "webhook.test.ts", latestTs: now - 3 * MIN, count: 2, added: 28, removed: 6, dominantAction: "edit", changes: [] },
      { filePath: "/Users/alex/code/payments-api/src/payments/stripe.ts", fileName: "stripe.ts", latestTs: now - 18 * MIN, count: 1, added: 9, removed: 2, dominantAction: "edit", changes: [] },
    ],
    memory_edits: [
      { filePath: "/Users/alex/.claude/projects/payments-api/memory/webhook-signing.md", fileName: "webhook-signing.md", latestTs: now - 6 * MIN, count: 1, added: 7, removed: 0, dominantAction: "write", changes: [] },
    ],
  },
};

const term = (o) => ({
  sessionId: o.id,
  windowId: o.id,
  name: o.name,
  spaceId: o.space ?? null,
  cwd: o.cwd ?? "/Users/alex/code/payments-api",
  alive: o.alive ?? true,
  exitCode: null,
  startedAtMs: now - 20 * MIN,
});

export const cockpitState = {
  type: "cockpitState",
  state: {
    profiles: [],
    spaces: [
      { id: "sp-pay", name: "payments-api" },
      { id: "sp-web", name: "web-app" },
    ],
    terminals: [
      term({ id: "t1", name: "Reviewer", space: "sp-pay" }),
      term({ id: "t2", name: "Implementer", space: "sp-pay" }),
      term({ id: "t3", name: "Test fixer", space: "sp-pay" }),
      term({ id: "t4", name: "Docs", space: "sp-pay" }),
    ],
  },
};

const C = {
  reset: "\x1b[0m",
  orange: "\x1b[38;5;173m",
  dim: "\x1b[2m",
  green: "\x1b[38;5;71m",
  cyan: "\x1b[38;5;73m",
  bold: "\x1b[1m",
  white: "\x1b[38;5;252m",
};

const BOX_W = 46;
const rule = (l, m, r) => `${l}${"─".repeat(BOX_W)}${r}`;
const inputBox = (status) =>
  `${C.dim}${rule("╭", "─", "╮")}${C.reset}\r\n` +
  `${C.dim}│${C.reset} ${C.orange}>${C.reset}${" ".repeat(BOX_W - 3)}${C.dim}│${C.reset}\r\n` +
  `${C.dim}${rule("╰", "─", "╯")}${C.reset}\r\n` +
  `  ${C.dim}⏵⏵ accept edits on${C.reset}  ${C.dim}·${C.reset}  ${C.dim}${status}${C.reset}`;

// Mimics the real Claude Code TUI: ⏺ tool bullets, ⎿ result connectors,
// an assistant turn, then the rounded input box and status line.
const claudeScreen = (cwd, model, lines) =>
  `\x1b[2J\x1b[H` +
  `${C.dim}  ${cwd}${C.reset}\r\n\r\n` +
  lines.map((l) => `  ${l}`).join("\r\n") +
  `\r\n\r\n` +
  inputBox(model);

const tool = (name, arg) => `${C.green}⏺${C.reset} ${C.white}${name}${C.reset}(${C.dim}${arg}${C.reset})`;
const out = (text) => `${C.dim}⎿  ${text}${C.reset}`;
const say = (text) => `${C.orange}⏺${C.reset} ${text}`;

export const terminalData = [
  { type: "terminalData", sessionId: "t1", data: claudeScreen("~/code/payments-api", "claude-sonnet-4-6", [
    `${C.dim}> review the webhook handler for security issues${C.reset}`,
    ``,
    tool("Read", "src/payments/webhook.ts"),
    out("Read 84 lines"),
    tool("Grep", "constructEvent"),
    out("1 match in src/payments/stripe.ts"),
    say("Signature verification is correct, but the retry"),
    `  backoff caps at 3 tries. A 5xx storm could still drop`,
    `  events. I'd add a dead-letter queue.`,
  ]) },
  { type: "terminalData", sessionId: "t2", data: claudeScreen("~/code/payments-api", "claude-sonnet-4-6", [
    `${C.dim}> add the dead-letter queue the reviewer suggested${C.reset}`,
    ``,
    tool("Update", "src/payments/retry.ts"),
    out(`${C.green}+34${C.reset}${C.dim} -3   dead-letter queue after max retries`),
    tool("Bash", "npm run typecheck"),
    out("no errors"),
    say("Wired the DLQ into the worker. Failed charges now"),
    `  land in payments.dlq after 3 attempts.`,
  ]) },
  { type: "terminalData", sessionId: "t3", data: claudeScreen("~/code/payments-api", "claude-haiku-4-5", [
    `${C.dim}> run the payments tests${C.reset}`,
    ``,
    tool("Bash", "npm test -- payments"),
    out(`${C.green}PASS${C.reset}${C.dim}  payments/webhook.test.ts (12 tests)`),
    out(`${C.green}PASS${C.reset}${C.dim}  payments/retry.test.ts (8 tests)`),
    out(`${C.green}PASS${C.reset}${C.dim}  payments/dlq.test.ts (5 tests)`),
    say(`${C.green}25 passed${C.reset}, 0 failed. The DLQ path is covered.`),
  ]) },
  { type: "terminalData", sessionId: "t4", data: claudeScreen("~/code/payments-api", "claude-sonnet-4-6", [
    `${C.dim}> document the new webhook + DLQ setup${C.reset}`,
    ``,
    tool("Write", "docs/webhooks.md"),
    out("48 lines"),
    say("Drafted the setup guide and the signing steps."),
    ``,
    `${C.orange}?${C.reset} Should I also document the DLQ replay command,`,
    `  or keep that in the runbook?`,
  ]) },
];

const blockId = (s) => s;
const pipeline = {
  id: "pl-review",
  name: "Parallel review then converge",
  createdAtMs: now - 3 * 24 * HOUR,
  updatedAtMs: now - 2 * HOUR,
  triggers: [{ kind: "webhook", token: "demo", enabled: true }],
  blocks: [
    { id: "b-seed", kind: "worker", name: "Draft the change", prompt: "Implement the feature described in the issue.", model: "claude-sonnet-4-6", effort: "high" },
    {
      id: "b-par", kind: "parallel", name: "Three critics", mergerGoal: "Merge the three reviews into one prioritized action list.", mergerModel: "claude-opus-4-7",
      workers: [
        { id: "b-sec", kind: "worker", name: "Security", prompt: "Review for security issues.", model: "claude-sonnet-4-6", effort: "high" },
        { id: "b-perf", kind: "worker", name: "Performance", prompt: "Review for performance issues.", model: "claude-sonnet-4-6", effort: "high" },
        { id: "b-style", kind: "worker", name: "Readability", prompt: "Review for readability.", model: "claude-haiku-4-5", effort: "medium" },
      ],
    },
    { id: "b-fix", kind: "worker", name: "Apply the fixes", prompt: "Apply the merged action list.", model: "claude-sonnet-4-6", effort: "high" },
    { id: "b-loop", kind: "loop", name: "Until reviewers approve", loopBackToBlockId: "b-par", goal: "All reviewers approve with no high-severity findings.", maxIterations: 3, evaluatorModel: "claude-opus-4-7" },
  ],
};

const rec = (o) => ({ sessionId: o.sid, iteration: o.it ?? 0, promptSent: o.prompt ?? "", summary: o.summary ?? null, workerOutput: o.out ?? null, startedAtMs: now - 30 * MIN, endedAtMs: o.running ? null : now - 5 * MIN });
const brun = (o) => ({ blockId: o.id, status: o.status, sessions: o.sessions ?? [], parallel: o.parallel ?? null, output: o.output ?? null, stuckReason: null, failureReason: null, startedAtMs: now - 30 * MIN, endedAtMs: o.status === "done" ? now - 6 * MIN : null });

export const pipelinesList = {
  type: "pipelinesList",
  payload: {
    pipelines: [pipeline],
    runs: [
      { runId: "r1", pipelineId: "pl-review", pipelineName: pipeline.name, startedAtMs: now - 31 * MIN, endedAtMs: null, status: "running", blockCount: 4 },
      { runId: "r0", pipelineId: "pl-review", pipelineName: pipeline.name, startedAtMs: now - 5 * HOUR, endedAtMs: now - 4 * HOUR, status: "completed", blockCount: 4 },
    ],
  },
};

export const runUpdate = {
  type: "runUpdate",
  run: {
    runId: "r1",
    pipelineId: "pl-review",
    pipelineSnapshot: pipeline,
    startedAtMs: now - 31 * MIN,
    endedAtMs: null,
    status: "running",
    variables: {},
    blocks: [
      brun({ id: "b-seed", status: "done", sessions: [rec({ sid: "s-seed", summary: "Implemented the feature across 6 files.", out: "done" })] }),
      brun({ id: "b-par", status: "running", parallel: {
        mergerStatus: "pending", mergerStuckReason: null, mergerSessions: [],
        workerRuns: [
          { workerBlockId: "b-sec", status: "done", sessions: [rec({ sid: "s-sec", summary: "1 high: unsigned webhook path. 2 low." })], stuckReason: null, failureReason: null, startedAtMs: now - 28 * MIN, endedAtMs: now - 12 * MIN },
          { workerBlockId: "b-perf", status: "running", sessions: [rec({ sid: "s-perf", running: true })], stuckReason: null, failureReason: null, startedAtMs: now - 28 * MIN, endedAtMs: null },
          { workerBlockId: "b-style", status: "done", sessions: [rec({ sid: "s-style", summary: "Naming is clear. Suggest 3 doc comments." })], stuckReason: null, failureReason: null, startedAtMs: now - 28 * MIN, endedAtMs: now - 15 * MIN },
        ],
      } }),
      brun({ id: "b-fix", status: "pending" }),
      brun({ id: "b-loop", status: "pending" }),
    ],
  },
};

export const librarySnapshot = {
  type: "librarySnapshot",
  snapshot: {
    projects: [
      { path: "/Users/alex/code/my-api", label: "my-api", source: "workspace" },
      { path: "/Users/alex/code/banking-edge", label: "banking-edge", source: "tracked" },
      { path: "/Users/alex/code/claude-trace", label: "claude-trace", source: "tracked" },
    ],
    skills: [
      {
        name: "code-review",
        frontmatter: { name: "code-review", description: "Reviews diffs for security and clarity. Run before opening a PR.", "allowed-tools": ["Read", "Grep", "Bash(git diff *)"] },
        body: "Read every changed file in the diff. Look for: secret leaks, missing input validation, error-handling holes, and SQL/command injection.\n",
        resources: [{ relativePath: "references/owasp-top-10.md", sha256: "abc", bytes: 4321 }],
        scope: { kind: "global" },
        updatedAtMs: now - 2 * HOUR,
      },
      {
        name: "migration-doctor",
        frontmatter: { name: "migration-doctor", description: "Dry-runs a Postgres migration against a snapshot and explains the diff in plain English." },
        body: "Snapshot the schema, run the migration, diff the result, summarize what changed for humans.\n",
        resources: [],
        scope: { kind: "projects", paths: ["/Users/alex/code/my-api", "/Users/alex/code/banking-edge"] },
        updatedAtMs: now - 6 * HOUR,
      },
      {
        name: "release-notes",
        frontmatter: { name: "release-notes", description: "Drafts release notes from recent commits and merged PRs." },
        body: "Walk the commit log since the last tag and produce three sections: features, fixes, and breaking changes.\n",
        resources: [],
        scope: { kind: "projects", paths: ["/Users/alex/code/claude-trace"] },
        updatedAtMs: now - 9 * HOUR,
      },
      {
        name: "test-doctor",
        frontmatter: { name: "test-doctor", description: "Triages a failing test, isolates the root cause, proposes a fix." },
        body: "Read the failing test. Run it locally. Read related source files. Identify the underlying cause, not just the symptom.\n",
        resources: [{ relativePath: "scripts/run-isolated.sh", sha256: "def", bytes: 412 }],
        scope: { kind: "global" },
        updatedAtMs: now - 12 * HOUR,
      },
      {
        name: "doc-skeleton",
        frontmatter: { name: "doc-skeleton", description: "Drafts a README section from a code module." },
        body: "Read the module's public exports and write the missing section with examples.\n",
        resources: [],
        scope: { kind: "unassigned" },
        updatedAtMs: now - 26 * HOUR,
      },
    ],
    agents: [
      {
        name: "reviewer",
        frontmatter: { name: "reviewer", description: "Senior reviewer persona. Speaks plainly, flags risks, suggests fixes.", model: "sonnet", permissionMode: "default" },
        body: "Act like a senior reviewer. Be specific. Cite file:line. Suggest the smallest fix that works.\n",
        scope: { kind: "global" },
        attachedSkills: ["code-review", "test-doctor"],
        updatedAtMs: now - 4 * HOUR,
      },
      {
        name: "migration-planner",
        frontmatter: { name: "migration-planner", description: "Plans risky database migrations end-to-end.", model: "opus", permissionMode: "plan" },
        body: "Read the migration, the schema, and the rollback. Produce a step-by-step plan with checkpoints.\n",
        scope: { kind: "projects", paths: ["/Users/alex/code/my-api"] },
        attachedSkills: ["migration-doctor"],
        updatedAtMs: now - 18 * HOUR,
      },
      {
        name: "docs-writer",
        frontmatter: { name: "docs-writer", description: "Writes user-facing documentation in a clear, plain-English voice." },
        body: "Write for a smart reader who is new to the project. No marketing fluff.\n",
        scope: { kind: "unassigned" },
        attachedSkills: [],
        updatedAtMs: now - 30 * HOUR,
      },
    ],
  },
};
