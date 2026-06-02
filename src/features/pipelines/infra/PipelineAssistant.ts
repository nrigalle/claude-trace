import * as path from "path";
import { TRACE_DATA_DIR } from "../../../shared/config";
import {
  ClaudeChatEngine,
  type ChatHooks,
  type ChatPtySpawner,
  type TimelineEvent,
} from "../../../shared/assistant/claudeChatEngine";
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
  readonly inactivityTimeoutMs?: number;
}

const ASSISTANT_CWD_ROOT = path.join(TRACE_DATA_DIR, "pipeline-assistant");
const ASSISTANT_SIGNALS_DIR = path.join(TRACE_DATA_DIR, "pipeline-assistant", "signals");
const ASSISTANT_HOOKS_DIR = path.join(TRACE_DATA_DIR, "pipeline-assistant", "hooks");
const DISALLOWED_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "Task", "Agent", "AskUserQuestion", "ExitPlanMode"];
const ALLOWED_TOOLS = ["Read", "Grep", "Glob", "WebSearch", "WebFetch", "TodoWrite"];

export class PipelineAssistant {
  private readonly engine: ClaudeChatEngine;
  private readonly now: () => number;

  constructor(config: PipelineAssistantConfig = {}) {
    this.engine = new ClaudeChatEngine({
      claudeBin: config.claudeBin,
      claudeArgsPrefix: config.claudeArgsPrefix,
      ptySpawner: config.ptySpawner,
      cwdRoot: config.cwdRoot ?? ASSISTANT_CWD_ROOT,
      transcriptRoot: config.transcriptRoot,
      signalsDir: ASSISTANT_SIGNALS_DIR,
      hooksDir: ASSISTANT_HOOKS_DIR,
      allowedTools: ALLOWED_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
      hooks: config.hooks,
      inactivityTimeoutMs: config.inactivityTimeoutMs,
    });
    this.now = config.now ?? Date.now;
  }

  dispose(): void {
    this.engine.dispose();
  }

  reset(conversationId: string): void {
    this.engine.reset(conversationId);
  }

  cancel(conversationId: string): void {
    this.engine.cancel(conversationId);
  }

  async ask(
    conversationId: string,
    context: PipelineAssistantContext,
    message: string,
    options: PipelineAssistantOptions = {},
  ): Promise<PipelineAssistantResult> {
    const systemPrompt = systemPromptFor(context.pipeline, context.otherPipelines ?? []);
    const result = await this.engine.ask(conversationId, message, systemPrompt, context.workspaceCwd, {
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

  adopt(conversationId: string, sessionId: string, sessionCwd: string): void {
    this.engine.adopt(conversationId, sessionId, sessionCwd);
  }

  history(conversationId: string): readonly TimelineEvent[] {
    return this.engine.history(conversationId);
  }

  sessionInfo(conversationId: string): { readonly sessionId: string; readonly cwd: string } | null {
    const state = this.engine.sessionMap().get(conversationId);
    return state ? { sessionId: state.sessionId, cwd: state.sessionCwd } : null;
  }

  buildArgsForTesting(conversationId: string, message: string, model?: ModelChoice, effort?: EffortChoice): string[] | null {
    return this.engine.buildArgsForTesting(conversationId, message, model, effort);
  }
}

const pipelineSummaryLine = (p: Pipeline): string => {
  const kinds = new Map<string, number>();
  for (const b of p.blocks) kinds.set(b.kind, (kinds.get(b.kind) ?? 0) + 1);
  const kindSummary = [...kinds.entries()].map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(", ") || "no blocks";
  const triggerSummary = p.triggers.length > 0 ? p.triggers.map((t) => t.kind).join("+") : "manual";
  return `- "${p.name}" (id: ${fromPipelineId(p.id)}): ${p.blocks.length} blocks [${kindSummary}]; trigger: ${triggerSummary}`;
};

export const systemPromptFor = (pipeline: Pipeline, otherPipelines: readonly Pipeline[] = []): string => [
  "You are an expert at designing automation workflows in Claude Trace, helping the user turn a goal (or an existing repo of scripts) into a valid, runnable workflow graph.",
  "You are editing THIS workflow live; what you propose is applied to the canvas the user is looking at.",
  "",
  "Your job has two modes in one conversation:",
  "1. INTERVIEW: when anything about the workflow is unclear, ask focused questions until you are confident. Do not guess. Cover: the trigger (manual / schedule / webhook), each step's inputs and outputs, how data flows between steps, parallelism, and stop conditions. One or two sharp questions per turn, not a wall. Ask your questions as plain text and end your turn so the user can reply; never call AskUserQuestion or any interactive tool, and never enter plan mode.",
  "2. PROPOSE: once you are confident (or the user says go), emit the COMPLETE workflow as a single fenced JSON block (```json ... ```) matching the schema below. Always emit the whole pipeline, never a diff. Put a one or two sentence summary before the block. The UI parses the LAST json block and applies it after the user clicks Apply.",
  "",
  "You may use Read, Grep, Glob to inspect the user's repo (you run in their workspace) and WebSearch / WebFetch to confirm APIs. You CANNOT run code or deploy anything: Bash, Edit, Write are disabled. You never create infrastructure yourself.",
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
  "- Schedule: { kind: 'schedule', intervalMs, enabled } — a FIXED interval only. There is no cron. For 'every Friday', explain it runs on a weekly interval from when enabled, or that a precise day-of-week needs an external scheduler hitting a webhook.",
  "- Webhook: { kind: 'webhook', token, enabled } — Claude Trace listens locally on 127.0.0.1:<claudeTrace.webhookPort>; a POST to http://127.0.0.1:<port>/?token=<token> starts the run.",
  "On webhooks you GUIDE, you never create one. If the user needs a public endpoint (e.g. Google Sheets or a Vercel function calling in), explain clearly how THEY can create and integrate it: deploy their own endpoint/relay that forwards to the local webhook URL with the token, or expose the local port with a tunnel. Give concrete steps, but do not attempt to deploy it.",
  "",
  "Your environment: you run inside Claude Trace. You already have, below, the workflow being edited AND every other workflow the user has saved. This is your full, authoritative knowledge of their workflows. Never go looking for workflow files: they live in ~/.claude-trace/automations (NOT in the repo you are cwd'd into), and everything you need is already inline here. Use Read/Grep/Glob ONLY to inspect the user's code/scripts in the repo, never to find workflows.",
  "",
  "Current workflow (edit from here):",
  "<current_workflow>",
  serializePipeline(pipeline),
  "</current_workflow>",
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
].join("\n");
