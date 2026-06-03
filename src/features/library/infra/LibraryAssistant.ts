import * as path from "path";
import { TRACE_DATA_DIR } from "../../../shared/config";
import {
  concatTextEvents,
  extractTimelineEvents,
  wrapSessionContext,
} from "../../../shared/assistant/conversationTurns";
import { encodeForClaudeProjects, readEventsFrom } from "../../../shared/infra/assistant/claudeChatEngine";
import type {
  ChatHooks,
  ChatPty,
  ChatPtyOptions,
  ChatPtySpawner,
  SessionState,
  TimelineEvent,
} from "../../../shared/infra/assistant/claudeChatEngine";
import { ChatAssistantBase } from "../../../shared/infra/assistant/chatAssistantBase";
import type {
  AssistantContext,
  AssistantMode,
} from "../protocol";
import type { EffortChoice, ModelChoice } from "../../../shared/models";

export { concatTextEvents, encodeForClaudeProjects, extractTimelineEvents, readEventsFrom };
export type LibraryPty = ChatPty;
export type LibraryPtyOptions = ChatPtyOptions;
export type LibraryPtySpawner = ChatPtySpawner;
export type AssistantHooks = ChatHooks;

export interface AssistantResult {
  readonly events: readonly TimelineEvent[];
  readonly text: string;
  readonly suggestedDescription: string | null;
}

export interface LibraryCatalogEntry {
  readonly name: string;
  readonly description: string;
}

export interface LibraryCatalog {
  readonly skills: readonly LibraryCatalogEntry[];
  readonly agents: readonly LibraryCatalogEntry[];
}

export interface AssistantOptions {
  readonly conversationId?: string;
  readonly cwd?: string;
  readonly mode?: AssistantMode;
  readonly model?: ModelChoice;
  readonly effort?: EffortChoice;
  readonly catalog?: LibraryCatalog;
  readonly onProgress?: (events: readonly TimelineEvent[]) => void;
}

export interface LibraryAssistantConfig {
  readonly claudeBin?: string;
  readonly claudeArgsPrefix?: readonly string[];
  readonly ptySpawner?: ChatPtySpawner;
  readonly cwdRoot?: string;
  readonly transcriptRoot?: string;
  readonly hooks?: Partial<ChatHooks>;
}

const ASSISTANT_CWD_ROOT = path.join(TRACE_DATA_DIR, "library-assistant");
const ASSISTANT_SIGNALS_DIR = path.join(TRACE_DATA_DIR, "library-assistant", "signals");
const ASSISTANT_HOOKS_DIR = path.join(TRACE_DATA_DIR, "library-assistant", "hooks");

export class LibraryAssistant extends ChatAssistantBase {
  constructor(config: LibraryAssistantConfig = {}) {
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
  }

  async ask(
    context: AssistantContext,
    message: string,
    options: AssistantOptions = {},
  ): Promise<AssistantResult> {
    const key = options.conversationId ?? context.itemKey;
    const systemPrompt = systemPromptFor(context, options.mode ?? "writeBody", options.catalog);
    const fullMessage = `${wrapSessionContext(currentBodyBlock(context))}\n\n${message}`;
    const result = await this.engine.ask(key, fullMessage, systemPrompt, null, {
      model: options.model,
      effort: options.effort,
      onProgress: options.onProgress,
    });
    const parsed = parseReply(result.text);
    return { events: result.events, text: parsed.text, suggestedDescription: parsed.suggestedDescription };
  }

  get items(): Map<string, SessionState> {
    return this.engine.sessionMap();
  }

  ensureItem(context: AssistantContext, mode: AssistantMode): SessionState {
    return this.engine.ensure(context.itemKey, systemPromptFor(context, mode), null);
  }
}

export const parseReply = (text: string): { text: string; suggestedDescription: string | null } => {
  const lines = text.split(/\r?\n/);
  let suggestedDescription: string | null = null;
  const kept: string[] = [];
  for (const line of lines) {
    const match = /^SUGGESTED_DESCRIPTION:\s*(.+)$/.exec(line.trim());
    if (match && suggestedDescription === null) {
      suggestedDescription = match[1] ?? "";
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n").trim(), suggestedDescription };
};

const catalogLines = (entries: readonly LibraryCatalogEntry[]): string =>
  entries.length > 0
    ? entries.map((e) => `- ${e.name}: ${e.description.trim().length > 0 ? e.description.trim() : "(no description)"}`).join("\n")
    : "(none)";

export const currentBodyBlock = (ctx: AssistantContext): string =>
  [
    "The current draft of the body (authoritative, up to date as of this turn):",
    "<current_body>",
    ctx.body && ctx.body.trim().length > 0 ? ctx.body : "(empty)",
    "</current_body>",
  ].join("\n");

export const systemPromptFor = (ctx: AssistantContext, mode: AssistantMode, catalog?: LibraryCatalog): string => {
  const kindLong = ctx.kind === "skill" ? "Claude Code Skill" : "Claude Code Subagent";
  const formatRules = ctx.kind === "skill" ? SKILL_FORMAT : AGENT_FORMAT;
  const attached = ctx.attachedSkills.length > 0
    ? `\nAttached skills (preloaded into this agent's context at startup): ${ctx.attachedSkills.join(", ")}`
    : "";
  const modeRules = mode === "writeBody" ? WRITE_BODY_RULES : DISCUSS_RULES;
  return [
    `You are an expert Claude Code author helping the user draft the BODY (markdown content under the YAML frontmatter) of a ${kindLong}.`,
    `The user is editing this ${ctx.kind} in the Claude Trace library at this moment.`,
    "",
    `Name: ${ctx.name}`,
    `Current description: ${ctx.description || "(empty)"}`,
    `${attached}`,
    "",
    "The current draft of the body is sent fresh in a <session_context> block with every message, so it is always the latest (the user may edit it directly between turns - always work from that, not from a body you wrote earlier).",
    "",
    "Your environment: you run inside the Claude Trace library, which holds the user's whole collection of skills and agents. The full catalog of what currently exists is below. This is your authoritative knowledge of their library; never go looking on disk for skill or agent files. When the user mentions another skill or agent by name (for example to compose with it, attach it, or match its style), find it in this catalog and use it. Only the current item's body is yours to write.",
    "<library_skills>",
    catalogLines(catalog?.skills ?? []),
    "</library_skills>",
    "<library_agents>",
    catalogLines(catalog?.agents ?? []),
    "</library_agents>",
    "",
    "2026 Claude Code format reference:",
    formatRules,
    "",
    "You have full tools available and they run without approval prompts. Use them when they genuinely help draft this content (e.g. WebSearch to confirm current best practices, or Read/Grep on a repo the user points you at). This panel streams like a terminal but has no interactive picker, so ask any clarifying question as plain text and end your turn rather than using a multiple-choice question tool or plan mode.",
    "",
    "Response rules:",
    modeRules,
    "Never invent frontmatter fields that do not exist in the 2026 spec. Use kebab-case for skill fields (allowed-tools, when_to_use, argument-hint) and camelCase for subagent fields (disallowedTools, permissionMode, maxTurns).",
    "If you have a strong suggestion for the description, put a separate line at the very end of your reply in this exact form (the UI parses it):",
    "SUGGESTED_DESCRIPTION: <your suggested description, one line>",
    "Only include that line when you have a meaningfully better description; otherwise omit it.",
    "Be terse. No filler. Production-grade voice: declarative, specific, no hedging.",
  ].join("\n");
};

const WRITE_BODY_RULES = [
  "1. The user has chosen 'Write to body' mode. The body field will be REPLACED with the text you emit AFTER your last tool call. That trailing text is the body. Nothing else (no preamble, no inline narration) is preserved.",
  "2. CRITICAL: every turn MUST end with a single closing text block containing the complete body markdown. Even if you used WebSearch / WebFetch / Read first, you MUST follow them with a final text block that IS the body. A turn that ends with only tool calls and no closing body text produces NOTHING for the user. That is a failure.",
  "3. No preamble. Do not say 'I'll research…' or 'Now let me write…' or 'Here is the body:' or 'I hope this helps'. Tool calls do your thinking; the final text block does your writing. The reader is the LLM that will run this skill/agent, not the user.",
  "4. Always emit the COMPLETE body in that final text block, not a diff or a patch. Multi-turn iteration means you rewrite the whole body each turn.",
  "5. When the user asks a clarifying question that would change the design, do not stall: use tools if helpful, then end with the body that reflects your best interpretation. The user can refine in the next turn.",
].join("\n");

const DISCUSS_RULES = [
  "1. The user has chosen 'Discuss' mode: respond conversationally. Your text will appear in the chat panel only; it will NOT be written to the body field.",
  "2. Help the user think through the design before generating. Ask clarifying questions when useful.",
  "3. When the user is ready to draft, tell them to switch to 'Write to body' mode.",
].join("\n");

const SKILL_FORMAT = [
  "- A skill is a directory containing SKILL.md (uppercase, case-sensitive).",
  "- The directory may carry scripts/, references/, assets/ alongside SKILL.md.",
  "- Frontmatter is YAML, kebab-case. Common fields: name, description, when_to_use, allowed-tools, argument-hint, model, disable-model-invocation (bool), user-invocable (bool).",
  "- Body is prose markdown: instructions for Claude to follow when invoking the skill.",
  "- A great skill body: starts with a one-line statement of when to invoke, then numbered steps or sections. Concrete heuristics, not vibes. Calls out edge cases. Cites file paths only as placeholders.",
].join("\n");

const AGENT_FORMAT = [
  "- A subagent is a single .md file with YAML frontmatter.",
  "- Fields: name, description, tools (comma list), disallowedTools, model (sonnet|opus|haiku|inherit), permissionMode (default|acceptEdits|plan|auto|dontAsk|bypassPermissions), maxTurns, skills (preload skill content).",
  "- The body IS the agent's system prompt. It replaces Claude Code's default system prompt entirely (only env info is appended).",
  "- A great agent body: opens with a one-line identity ('You are X. You do Y.'). Defines the persona, the inputs it expects, the deliverable it returns, and the explicit guardrails. Does not include conversational filler.",
].join("\n");
