# Claude Trace

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/nrigalle.claude-trace.svg?label=VS%20Marketplace&color=2D7DD2)](https://marketplace.visualstudio.com/items?itemName=nrigalle.claude-trace)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/nrigalle.claude-trace.svg)](https://marketplace.visualstudio.com/items?itemName=nrigalle.claude-trace)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/nrigalle.claude-trace.svg)](https://marketplace.visualstudio.com/items?itemName=nrigalle.claude-trace)
[![License: MIT](https://img.shields.io/github/license/nrigalle/claude-trace.svg)](LICENSE)

> A live dashboard inside VS Code that shows you what Claude Code is actually doing in your sessions: tool calls, context usage, tokens, and cost.

If you've used Claude Code for more than a few hours, you've probably wondered: *how much did that session cost? how close did I get to the context limit? which tools did Claude lean on?* Claude Trace answers all three at a glance, without leaving your editor.

It reads the transcripts Claude Code already writes to your machine. No hooks. No daemon. No data leaves your computer.

## Screenshot

![Claude Trace dashboard](https://raw.githubusercontent.com/nrigalle/claude-trace/main/media/screenshot-dashboard.png)

The dashboard has a sidebar of sessions on the left, summary cards and charts in the middle, and a virtualized event timeline at the bottom.

## Highlights

* Every Claude Code session on your machine, listed by last activity.
* Live updates as the active session runs. Smooth, with no flicker.
* Context window usage chart with a warning line at 80%.
* Cost breakdown that tracks the actual token rates for Opus 4.7, Sonnet 4.6, and Haiku 4.5.
* Tool distribution donut so you can see at a glance which tools dominate.
* Virtualized timeline that stays responsive at 10,000+ events.
* Adapts to your VS Code theme (light, dark, high contrast).
* Full keyboard navigation, ARIA landmarks, `prefers-reduced-motion` support.

## Install

```bash
code --install-extension nrigalle.claude-trace
```

That's it. No configuration, no hooks to install, no API keys.

## Open the dashboard

Press `Ctrl+Alt+T` (or `Cmd+Alt+T` on macOS).

You can also run **Claude Trace: Open Dashboard** from the command palette, or click the `$(pulse) Claude Trace` button in the status bar.

The first time you open it, you'll see every Claude Code session that's already on your machine, sorted by recency. Click one to dive into the details.

## How it works

Claude Code stores a full transcript for every session under `~/.claude/projects/<encoded-path>/<session-id>.jsonl`. Each line is a JSON object recording one event: a user prompt, an assistant turn, a tool call, a tool result.

Claude Trace watches that directory with `vscode.workspace.createFileSystemWatcher`. When a session file grows (a new event was appended), the extension reads only the new bytes (not the whole file) and pushes the delta to the dashboard webview. The webview batches incoming updates through `requestAnimationFrame` so even a flood of events stays under one render per frame.

Cost numbers are computed locally from the token counts already in the transcript, using public Anthropic pricing. The context percentage is auto detected: if any turn in the session reports more than 200K input tokens, the dashboard assumes a 1M context window (the variant Claude Code uses on Max and Team plans).

Nothing is sent off your machine. The dashboard is a webview reading local files.

## Privacy

All data stays on your machine. The extension never makes a network request. To wipe the data Claude Code wrote (independently of this extension):

```bash
rm -rf ~/.claude/projects
```

## Features at a glance

**Session list.** Every session you've ever run with Claude Code, sorted by last activity. Each entry shows the session title (the AI generated topic name), the project folder it ran in, tool count, duration, and cost.

**Summary cards.** Six tiles for the selected session: duration, tool calls, cost, context %, total tokens (with an input/output breakdown), and lines added/removed.

**Context usage chart.** Area chart over time. A red dashed line marks the 80% threshold so you can see when a session is getting tight.

**Cost chart.** Cumulative cost over time. Useful for spotting which part of a long session cost the most.

**Tool distribution.** Donut chart showing which tools the model used and how often.

**Event timeline.** Filterable, virtualized, expandable. Click any event to see the inputs the model passed and the result it received back.

**Live updates.** When you have Claude Code running in one window and the dashboard open in another, the active session updates in place. The cards refresh their values, the charts redraw, and new events stream into the timeline. No flicker, no scroll jump, no focus loss in the search box.

## Usage

The dashboard is read only. You drive Claude Code from its own terminal or IDE integration. Open the dashboard whenever you want to inspect a session.

Two common workflows:

1. **Live monitoring.** Keep the dashboard open in a side panel while you work. Watch your context fill up, catch expensive turns early.
2. **Post mortem.** After a long session, open the dashboard, pick the session from the sidebar, and walk through the timeline to see what happened.

## Settings

There aren't any. The extension activates on startup and reads from the default Claude Code location. If you've moved your `~/.claude` directory, set the `CLAUDE_TRACE_PROJECTS_DIR` environment variable before launching VS Code.

## Requirements

* VS Code 1.85 or newer
* Claude Code 1.x or newer (it has been writing transcripts to `~/.claude/projects` since early 2026)

## Uninstall

```bash
code --uninstall-extension nrigalle.claude-trace
```

## For contributors

```bash
git clone https://github.com/nrigalle/claude-trace.git
cd claude-trace
npm install

# build both bundles (extension host + webview)
npm run compile

# watch mode
npm run watch

# type check both projects
npm run typecheck

# the test suite
npm run test:unit
```

Press `F5` in VS Code to launch an Extension Development Host with the unpackaged extension loaded.

The codebase is split into three layers:

* `src/domain/` is pure logic (parsing, summarizing, pricing). Zero `vscode` imports, easy to unit test.
* `src/infra/` adapters touch the file system, VS Code API, and webview lifecycle.
* `src/app/` is the orchestration layer (session service, refresh scheduler, dashboard controller).

The webview is its own TypeScript bundle under `media/src/`, sharing the message protocol types with the extension host through `src/protocol.ts`.

## License

MIT. See [LICENSE](LICENSE).
