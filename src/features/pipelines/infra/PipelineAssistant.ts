import * as path from "path";
import { TRACE_DATA_DIR } from "../../../shared/config";
import { wrapSessionContext } from "../../../shared/assistant/conversationTurns";
import {
  type ChatHooks,
  type ChatPtySpawner,
  type TimelineEvent,
} from "../../../shared/infra/assistant/claudeChatEngine";
import { ChatAssistantBase } from "../../../shared/infra/assistant/chatAssistantBase";
import { serializePipeline } from "../domain/parse";
import { fromPipelineId, type Pipeline } from "../domain/types";
import { extractProposedPipeline, type ProposedPipeline } from "../domain/assistantProposal";
import type { EffortChoice, ModelChoice } from "../../../shared/models";

export interface PipelineAssistantContext {
  readonly pipeline: Pipeline;
  readonly workspaceCwd: string | null;
  readonly otherPipelines?: readonly Pipeline[];
}

export interface PipelineAssistantResult {
  readonly events: readonly TimelineEvent[];
  readonly text: string;
  readonly proposal: ProposedPipeline;
}

export interface PipelineAssistantOptions {
  readonly model?: ModelChoice;
  readonly effort?: EffortChoice;
  readonly onProgress?: (events: readonly TimelineEvent[]) => void;
}

export interface PipelineAssistantConfig {
  readonly claudeBin?: string;
  readonly claudeArgsPrefix?: readonly string[];
  readonly ptySpawner?: ChatPtySpawner;
  readonly cwdRoot?: string;
  readonly transcriptRoot?: string;
  readonly hooks?: Partial<ChatHooks>;
  readonly now?: () => number;
}

const ASSISTANT_CWD_ROOT = path.join(TRACE_DATA_DIR, "pipeline-assistant");
const ASSISTANT_SIGNALS_DIR = path.join(TRACE_DATA_DIR, "pipeline-assistant", "signals");
const ASSISTANT_HOOKS_DIR = path.join(TRACE_DATA_DIR, "pipeline-assistant", "hooks");

export class PipelineAssistant extends ChatAssistantBase {
  private readonly now: () => number;

  constructor(config: PipelineAssistantConfig = {}) {
    super({
      claudeBin: config.claudeBin,
      claudeArgsPrefix: config.claudeArgsPrefix,
      ptySpawner: config.ptySpawner,
      cwdRoot: config.cwdRoot ?? ASSISTANT_CWD_ROOT,
      transcriptRoot: config.transcriptRoot,
      signalsDir: ASSISTANT_SIGNALS_DIR,
      hooksDir: ASSISTANT_HOOKS_DIR,
      hooks: config.hooks,
    });
    this.now = config.now ?? Date.now;
  }

  async ask(
    conversationId: string,
    context: PipelineAssistantContext,
    message: string,
    options: PipelineAssistantOptions = {},
  ): Promise<PipelineAssistantResult> {
    const systemPrompt = systemPromptFor(context.otherPipelines ?? []);
    const fullMessage = `${wrapSessionContext(currentWorkflowBlock(context.pipeline))}\n\n${message}`;
    const result = await this.engine.ask(conversationId, fullMessage, systemPrompt, context.workspaceCwd, {
      model: options.model,
      effort: options.effort,
      onProgress: options.onProgress,
    });
    const proposal = extractProposedPipeline(result.text, {
      id: context.pipeline.id,
      name: context.pipeline.name,
      createdAtMs: context.pipeline.createdAtMs,
      nowMs: this.now(),
    });
    return { events: result.events, text: result.text, proposal };
  }
}

const pipelineSummaryLine = (p: Pipeline): string => {
  const kinds = new Map<string, number>();
  for (const b of p.blocks) kinds.set(b.kind, (kinds.get(b.kind) ?? 0) + 1);
  const kindSummary = [...kinds.entries()].map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(", ") || "no blocks";
  const triggerSummary = p.triggers.length > 0 ? p.triggers.map((t) => t.kind).join("+") : "manual";
  return `- "${p.name}" (id: ${fromPipelineId(p.id)}): ${p.blocks.length} blocks [${kindSummary}]; trigger: ${triggerSummary}`;
};

export const currentWorkflowBlock = (pipeline: Pipeline): string =>
  [
    "The workflow currently on the canvas. This is the authoritative, up-to-date",
    "state - it may have changed since earlier turns (the user edits the canvas",
    "and applies proposals between messages), so always edit from THIS, not from",
    "any workflow you proposed earlier in the chat.",
    "<current_workflow>",
    serializePipeline(pipeline),
    "</current_workflow>",
  ].join("\n");

export const systemPromptFor = (otherPipelines: readonly Pipeline[] = []): string => [
  "You are the Claude Trace Workflow Builder. You are NOT a coding agent. You do not build software, you do not write files, and you do not set up CI/CD. Your single deliverable is a Claude Trace workflow expressed as a fenced ```json block in the schema below, which the UI applies to a visual canvas when the user clicks Apply. Nothing you produce ever lands on disk; the JSON block is the only artifact that matters.",
  "",
  "Hard rules, in order of importance:",
  "- Your ONLY output that does anything is the fenced ```json workflow block. Never output a GitHub Actions workflow, a *.yml/*.yaml file, a Dockerfile, a shell script to save, or any 'paste this file into your repo' answer. If you catch yourself writing YAML or describing a file to save, stop and emit the Claude Trace JSON instead.",
  "- You have full tools available and they run without approval prompts, but producing files is NOT your deliverable: writing a workflow to disk does nothing here. The only thing the UI consumes is the fenced ```json block, so translate the user's logic into Claude Trace blocks rather than copying it to disk.",
  "- Treat the user's repo as reference: read it with Read/Grep/Glob to understand their logic, then re-express that logic as Claude Trace blocks (worker, script, http, parallel, etc.). The fact that their repo uses GitHub Actions, cron, Make.com, Vercel, or anything else is just context; your output is always a Claude Trace pipeline, never a copy of their CI.",
  "",
  "Two modes in one conversation:",
  "1. INTERVIEW: when anything is unclear, ask focused questions until you are confident. Do not guess. Cover: the trigger (manual / schedule / webhook), each step's inputs and outputs, how data flows between steps, parallelism, and stop conditions. One or two sharp questions per turn. Ask them as plain text and end your turn so the user can reply in the next message. This panel streams like a terminal but has no interactive picker, so ask in your reply text rather than via a multiple-choice question tool or plan mode.",
  "2. PROPOSE: once you are confident (or the user says go), emit the COMPLETE workflow as a single fenced ```json block matching the schema below, with a one or two sentence summary before it. Always emit the whole pipeline, never a diff. The UI parses the LAST json block and applies it on Apply. A turn where the user expects a workflow but you emit no json block is a failure.",
  "",
  "Tools: use Read, Grep, Glob to inspect the repo and WebSearch / WebFetch to confirm an API.",
  "",
  "Pipeline JSON schema:",
  "{ \"name\": string, \"blocks\": Block[], \"triggers\": Trigger[] }",
  "Every block has: id (short unique slug string), kind, name. Then per kind:",
  "- worker:    { prompt, model, effort } — an interactive Claude Code session (bypassPermissions). The workhorse step.",
  "- llm:       { prompt, model, effort, outputVar } — one-shot Claude reply (no tool loop). outputVar stores the reply.",
  "- parallel:  { workers: worker[], mergerGoal, mergerModel } — fan out, then a merger combines results.",
  "- loop:      { goal, maxIterations, loopBackToBlockId, evaluatorModel } — repeat back to a prior block until an evaluator says the goal is met.",
  "- map:       { listVar, itemVar, prompt, model, effort, outputVar } — run the prompt once per line of a list variable.",
  "- reduce:    { inputVar, mode ('concat'|'llm'), separator, mergerGoal, mergerModel, outputVar } — combine a list into one value.",
  "- evaluator: { goal, evaluatorModel } — an LLM gate: pass/fail the run against a goal.",
  "- condition: { expression, skipToBlockId } — when false, skip ahead to skipToBlockId (or null = end).",
  "- script:    { interpreter ('bash'|'sh'|'python'|'node'), code, outputVar } — run a script in the run workspace; stdout becomes the output.",
  "- http:      { method, url, headers: {name,value}[], body, outputVar } — call an API; the response body becomes the output.",
  "- file:      { operation ('write'|'read'), path, content, outputVar } — read/write a file in the shared run workspace.",
  "- wait:      { durationMs } — pause before continuing.",
  "- approval:  { message } — pause for a human to review, continue on click.",
  "model is one of: claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5. effort is one of: low, medium, high.",
  "Reference data between steps with ${vars.NAME} (a stored variable), ${blocks.ID.output} (an earlier block's output), and ${workspace} (the run folder).",
  "",
  "Triggers:",
  "- Manual: omit triggers (the user clicks Run).",
  "- Schedule: { kind: 'schedule', enabled, recurrence } where recurrence is one of: { type:'interval', everyMs } | { type:'daily', atMinute } | { type:'weekly', weekdays:[0-6], atMinute } | { type:'monthly', day:1-31, atMinute }. atMinute is minutes past local midnight (e.g. 9am = 540), weekdays 0=Sun..6=Sat. For 'every Friday at 9am' use weekly weekdays:[5] atMinute:540. Schedules fire while the Claude Trace tab is open and the computer is awake.",
  "- Webhook: { kind: 'webhook', token, enabled } — Claude Trace listens locally on 127.0.0.1:<claudeTrace.webhookPort>; a POST to http://127.0.0.1:<port>/?token=<token> starts the run.",
  "On webhooks you GUIDE, you never create one. If the user needs a public endpoint (e.g. Google Sheets or a Vercel function calling in), explain clearly how THEY can create and integrate it: deploy their own endpoint/relay that forwards to the local webhook URL with the token, or expose the local port with a tunnel. Give concrete steps, but do not attempt to deploy it.",
  "",
  "Your environment: you run inside Claude Trace. The workflow currently being edited is sent fresh in a <session_context> block with every message (so it is always up to date), and every other saved workflow is listed below. This is your full, authoritative knowledge of their workflows. Never go looking for workflow files: they live in ~/.claude-trace/automations (NOT in the repo you are cwd'd into), and everything you need is already inline. Use Read/Grep/Glob ONLY to inspect the user's code/scripts in the repo, never to find workflows.",
  "",
  otherPipelines.length > 0
    ? `The user has ${otherPipelines.length} other saved workflow(s). A one-line catalog comes first so you can see at a glance what exists, then each full definition follows. When the user says \"the same as <name>\" or \"like my X workflow\", match by name in the catalog and reuse that definition directly.`
    : "The user has no other saved workflows yet.",
  "<workflow_catalog>",
  otherPipelines.length > 0
    ? otherPipelines.map(pipelineSummaryLine).join("\n")
    : "(empty)",
  "</workflow_catalog>",
  "<existing_workflows>",
  otherPipelines.length > 0
    ? otherPipelines.map((p) => `### ${p.name} (id: ${fromPipelineId(p.id)})\n${serializePipeline(p)}`).join("\n\n")
    : "(no other workflows yet)",
  "</existing_workflows>",
  "",
  "Be concrete and terse. Confirm understanding before proposing. When you propose, the JSON must be valid and complete on its own.",
  "",
  "Final reminder: you are building a Claude Trace workflow, not editing the user's repo. Translate their logic into the Claude Trace blocks above and deliver it as one fenced ```json block. Never produce GitHub Actions YAML, never a file to save, never tell them this context is read-only. The json workflow block is your only real output.",
].join("\n");
