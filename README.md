# Claude Trace

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/nrigalle.claude-trace.svg?label=VS%20Marketplace&color=2D7DD2)](https://marketplace.visualstudio.com/items?itemName=nrigalle.claude-trace)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/nrigalle.claude-trace.svg)](https://marketplace.visualstudio.com/items?itemName=nrigalle.claude-trace)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/nrigalle.claude-trace.svg)](https://marketplace.visualstudio.com/items?itemName=nrigalle.claude-trace)
[![License: MIT](https://img.shields.io/github/license/nrigalle/claude-trace.svg)](LICENSE)

> **Claude Code doesn't tell you what you spent. Or what it changed. Or what you started yesterday.**
> Claude Trace does — from a sidebar in VS Code, reading the transcripts Claude Code already writes to your disk. Nothing leaves your machine.

![Claude Trace dashboard](https://raw.githubusercontent.com/nrigalle/claude-trace/main/media/screenshot-dashboard.png)

## Install

```bash
code --install-extension nrigalle.claude-trace
```

Press `Ctrl+Alt+T` to open the dashboard (`Cmd+Alt+T` on macOS). No config, no hooks, no API keys.

## Why this exists

[ccusage](https://github.com/ryoppippi/ccusage) has 10,000 stars on GitHub. It does one thing: parse the JSONL files Claude Code writes locally and tell you what you spent. Ten thousand stars because the official CLI shows a per-turn cost in the terminal and nothing else.

People are reading their own transcripts to figure out their bill.

The same files that hold cost data also hold every tool call, every file Claude wrote, every prompt you sent. Claude Trace started by surfacing the cost and grew sideways. The dashboard reads the whole transcript and shows all of it: while sessions are running, and after they end.

## What you get

|  |  |
|---|---|
| **Live cost meter.** The status bar shows what you spent today. Amber at 80% of your daily budget, red when you cross it. Per-session and per-day caps that actually fire. | **Multi-session tiles.** New Claude sessions open as splits in the editor, like tmux but native. Run four agents in parallel without losing track of which window is doing what. |
| **Diffs that survive the session.** Every file Claude touched gets a side-by-side diff against the current state. Reviewable after the terminal closes, the context compacts, or the laptop reboots. | **Sessions you can find again.** Cross-project search, date filters, pinned favorites, custom names. `/resume` becomes a thing you click, not a guessing game across folders. |
| **Model picker on new sessions.** Opus 4.7, Sonnet 4.6, or Haiku 4.5, with the per-million-token rate printed under each option. Pick the model before the spend, not after the bill. | **Permission mode per session.** All six modes from the CLI surfaced as a QuickPick. Use `acceptEdits` for refactors, `plan` for unfamiliar codebases, skip `--dangerously-skip-permissions` for good. |

Plus a timeline of every tool call, a chart of context usage with a warning line at 80%, a tool-distribution donut, file-touch summaries, memory-edit visibility, and a markdown export of any session's conversation.

## Who this is for

- You're $30 into a Sonnet session and didn't notice.
- You're keeping four Claude windows open for four branches and they all look the same.
- You opened VS Code on Monday, want to keep going on Wednesday's work, and have no idea which session that was.

If none of those are familiar, you might not need this yet.

## How it works

Claude Code writes a complete JSONL transcript for every session under `~/.claude/projects/<encoded-path>/<session-id>.jsonl`. Each line is one event: a user prompt, an assistant turn, a tool call, a tool result.

This extension watches that directory with `vscode.workspace.createFileSystemWatcher`, plus a one-second poll backstop for platforms where the watcher misses appends. When a file grows, only the new bytes are read and the delta is pushed to the webview. Updates batch through `requestAnimationFrame`, so even a flood of events stays under one render per frame.

Cost is computed locally from the token counts in the transcript, using current Anthropic rates including the 5-minute and 1-hour cache-write tiers. Context window is auto-detected: 200K by default, 1M for Opus 4.7, Opus 4.6, and Sonnet 4.6, or whenever observed input tokens cross 200K.

Nothing leaves your machine. No network requests, no telemetry, no opt-out flag because there's nothing to opt out of.

## Settings

| Setting | What it does |
|---|---|
| `claudeTrace.budgetPerSession` | Warn when a single session crosses this dollar amount. Default off. |
| `claudeTrace.budgetPerDay` | Warn when today's total crosses this dollar amount. Default off. |
| `CLAUDE_TRACE_PROJECTS_DIR` (env var) | Use this directory instead of `~/.claude/projects`. |

## What it doesn't do

- No per-team rollup or shared dashboard. This reads your local disk.
- No prompt-content classification (e.g., "this many tokens were code, this many were prose"). For deeper token accounting, use [ccusage](https://github.com/ryoppippi/ccusage).
- Windows works in light testing. If something breaks on Windows specifically, file an issue.

## Requirements

- VS Code 1.85 or newer
- Claude Code 1.x or newer (the JSONL format has been stable since early 2026)

## For contributors

```bash
git clone https://github.com/nrigalle/claude-trace.git
cd claude-trace
npm install
npm run compile       # build extension + webview bundles
npm run watch         # rebuild on save
npm run typecheck     # both targets
npm run test:unit     # 395 tests, vitest
```

Press `F5` in VS Code to launch the extension in a development host.

The codebase splits three ways:

- `src/domain/`: pure logic (parsing, pricing, summaries). Zero `vscode` imports.
- `src/infra/`: adapters touching VS Code APIs, the filesystem, the webview lifecycle.
- `src/app/`: orchestration (session service, refresh scheduler, dashboard controller).

The webview is its own TypeScript bundle under `media/src/`, sharing message types with the extension host through `src/protocol.ts`.

## Uninstall

```bash
code --uninstall-extension nrigalle.claude-trace
```

## License

MIT. See [LICENSE](LICENSE).
