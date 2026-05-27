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
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

const claudeScreen = (title, lines) =>
  `\x1b[2J\x1b[H${C.orange}${C.bold} ✻ Claude Code${C.reset}${C.dim}  ${title}${C.reset}\r\n\r\n` +
  lines.map((l) => `  ${l}`).join("\r\n") +
  `\r\n\r\n${C.dim}  ───────────────────────────────────────────${C.reset}\r\n  ${C.orange}>${C.reset} `;

export const terminalData = [
  { type: "terminalData", sessionId: "t1", data: claudeScreen("reviewing diff", [
    `${C.cyan}● Read${C.reset} src/payments/webhook.ts`,
    `${C.cyan}● Read${C.reset} src/payments/retry.ts`,
    `${C.green}✓${C.reset} Signature verification looks correct.`,
    `${C.dim}  One concern: the retry backoff caps at 3 tries —${C.reset}`,
    `${C.dim}  a 5xx storm could still drop events. Suggest a DLQ.${C.reset}`,
  ]) },
  { type: "terminalData", sessionId: "t2", data: claudeScreen("editing", [
    `${C.cyan}● Edit${C.reset} src/payments/retry.ts`,
    `${C.green}+${C.reset} added dead-letter queue after max retries`,
    `${C.cyan}● Bash${C.reset} npm run typecheck`,
    `${C.green}✓${C.reset} no type errors`,
    `${C.dim}  Wiring the DLQ into the worker now...${C.reset}`,
  ]) },
  { type: "terminalData", sessionId: "t3", data: claudeScreen("running tests", [
    `${C.cyan}● Bash${C.reset} npm test -- payments`,
    `${C.green}PASS${C.reset}  payments/webhook.test.ts ${C.dim}(12 tests)${C.reset}`,
    `${C.green}PASS${C.reset}  payments/retry.test.ts ${C.dim}(8 tests)${C.reset}`,
    `${C.green}✓${C.reset} 20 passed`,
  ]) },
  { type: "terminalData", sessionId: "t4", data: claudeScreen("waiting", [
    `${C.cyan}● Write${C.reset} docs/webhooks.md`,
    `${C.dim}  Drafted the webhook setup guide.${C.reset}`,
    `${C.orange}? ${C.reset}Should I also document the DLQ replay command?`,
    `${C.dim}  (waiting for your input)${C.reset}`,
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
