# Claude Trace

[![VS Marketplace](https://vsmarketplacebadges.dev/version-short/nrigalle.claude-trace.svg?label=VS%20Marketplace&color=2D7DD2)](https://marketplace.visualstudio.com/items?itemName=nrigalle.claude-trace)
[![Installs](https://vsmarketplacebadges.dev/installs-short/nrigalle.claude-trace.svg?label=Installs&color=2D7DD2)](https://marketplace.visualstudio.com/items?itemName=nrigalle.claude-trace)
[![Open VSX](https://img.shields.io/open-vsx/v/nrigalle/claude-trace?label=Open%20VSX&color=a60ee5)](https://open-vsx.org/extension/nrigalle/claude-trace)
[![License: MIT](https://img.shields.io/github/license/nrigalle/claude-trace.svg)](LICENSE)

A cost dashboard, a multi-session terminal cockpit, a visual agent workflow builder, and a home for your skills and agents. All for [Claude Code](https://www.claude.com/product/claude-code), inside VS Code, reading the session logs Claude Code already writes to your disk. Nothing leaves your machine.

![Claude Trace cost and observability dashboard](https://raw.githubusercontent.com/nrigalle/claude-trace/main/media/shot-dashboard.png)

## The problem

Claude Code is a black box about three things. You don't see what a session costs until the bill arrives, and Anthropic's usage page can lag by days. Someone left a session running overnight recently and woke up to a $6,000 charge with no live counter to warn them. When you keep four sessions open for four branches, they all look the same and you lose track of which one is doing what. And there is no built in way to chain agents together so one's output feeds the next.

Claude Trace fixes all three from one panel. Press `Ctrl+Alt+T` (`Cmd+Alt+T` on macOS) to open it.

```bash
code --install-extension nrigalle.claude-trace
```

No config, no hooks, no API keys.

## See what every session costs

The status bar shows what you spent today. It turns amber at 80 percent of your daily budget and red when you cross it. Set a per session or per day cap and it actually fires.

Open any session and you get the full picture: cost over time, context window usage with a warning line at 80 percent, a breakdown of every tool call, and the files Claude touched. The diffs survive after the terminal closes, the context compacts, or the laptop reboots, so you can review what changed whenever you get to it. Cross project search, date filters, pinned favorites, and custom names turn `/resume` into something you click instead of a guessing game across folders.

Cost is computed locally from the token counts in the transcript, at current Anthropic rates, including the 5 minute and 1 hour cache write tiers.

## Run a cockpit of Claude sessions

![Multi-session terminal cockpit with attention indicator](https://raw.githubusercontent.com/nrigalle/claude-trace/main/media/shot-cockpit.png)

Launch many Claude Code sessions as tiled terminals in one view, like tmux but native to the editor. Group them into folders by project. A dot lights up on a session, and on its folder, the moment it finishes a turn or asks for your input, so you always know which window needs you without staring at all of them.

The sessions run in detached tmux, so they keep working when you quit VS Code and they are still there when you come back. Spin up a batch from a saved profile, pick the model and permission mode per session, and drop an image straight onto a terminal.

## Build workflows that chain agents

![Visual agent workflow orchestrator](https://raw.githubusercontent.com/nrigalle/claude-trace/main/media/shot-workflows.png)

Wire several Claude sessions into a pipeline on a canvas. Run workers in sequence so each one picks up where the last left off. Fan out to parallel workers and merge their results. Loop a block until an evaluator decides the work is good enough. Add scripts, HTTP calls, file steps, and conditions between the agent steps. Kick a run off by hand, on a schedule, or with a webhook.

Every step drives a real Claude Code session and passes its output to the next. The result is the kind of deterministic multi agent flow that subagents and agent teams don't give you, built visually instead of in code.

You don't have to draw every workflow by hand either. Press Build with AI, describe what you want or point it at the scripts you already have, and the assistant reads your repo, asks the questions it needs to get the design right, then proposes a complete workflow you drop onto the canvas in one click. Changed your mind? Undo puts the canvas back exactly as it was.

![Describe a workflow and the assistant builds it](https://raw.githubusercontent.com/nrigalle/claude-trace/main/media/shot-workflow-assistant.png)

And it remembers. Every workflow keeps its own chats, named and resumable, so when you reopen one next week the whole design conversation is still there instead of gone the moment you closed the panel.

## Keep your skills and agents in one place

![Centralized skills and agents library](https://raw.githubusercontent.com/nrigalle/claude-trace/main/media/shot-library.png)

Skills and agents are the best part of Claude Code, and they sprawl. Some live in `~/.claude` and apply everywhere. Others live in a `.claude` folder inside each project. After a few weeks you have near copies in five repos, you can't remember which ones you wrote, and you have no idea which projects each one is actually in. Editing means opening markdown files by hand and hoping the frontmatter is right.

The library puts all of it on one screen. Every skill and every agent, with a real editor for the instructions, the description, the attached skills, and the bundled resources. No more digging through dotfiles to find the thing you wrote last month.

Then you set the scope on each one, and Claude Trace writes the real files where they belong: global for `~/.claude`, the specific projects you pick, or unassigned while you are still shaping it. It only touches files it created and it tracks every one, so a skill you scope to three projects lands in all three and stays in sync. Change it once here and every target sees the change.

Not sure how to word a skill? Press Help me write and a side panel drafts the body with you in a real Claude session, then drops it straight into the editor.

## Run agents on your subscription, not the API meter

This is the part worth reading twice. On June 15, 2026, Anthropic splits programmatic Claude Code into separate metered billing. The Agent SDK, `claude -p`, and GitHub Actions move to a small monthly credit pool ($20 on Pro, $100 on Max 5x, $200 on Max 20x) and then charge full API rates on top. Interactive Claude Code in the terminal and IDE keeps drawing from your normal subscription limits, [exactly as before](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

Claude Trace runs its cockpit and its workflows through real interactive terminal sessions. So the orchestration you build here stays on your subscription instead of the metered API. If you were planning to coordinate agents through the SDK or headless mode, this is a direct way to keep doing that work without the new meter running.

## Make the dashboard yours

![Customize panel for showing and hiding dashboard sections](https://raw.githubusercontent.com/nrigalle/claude-trace/main/media/shot-customize.png)

Hit Customize and toggle any section on or off: summary cards, context and tool usage, cost over time, files touched, memory edits, the activity timeline. Set a section to half or full width and drag to reorder. The layout you pick applies to every session.

## How it works

Claude Code writes a complete JSONL transcript for every session under `~/.claude/projects/<encoded-path>/<session-id>.jsonl`. Each line is one event: a prompt, an assistant turn, a tool call, a tool result.

Claude Trace watches that directory and reads only the new bytes when a file grows, then pushes the delta to the panel. Updates batch through `requestAnimationFrame`, so even a flood of events stays under one render per frame. Context window size is detected per model: 200K by default, 1M for the models that support it or whenever observed input tokens cross 200K.

## Your data stays yours

There are no network requests, no telemetry, and no opt out flag because there is nothing to opt out of. Everything is read from your local disk and rendered locally.

## About the cost numbers

The dollar figures are local estimates from the token counts in your transcripts at published Anthropic rates. They are accurate enough to catch a runaway session or compare projects, but treat your Anthropic billing page as the authority for what you actually owe.

## Settings

| Setting | What it does |
|---|---|
| `claudeTrace.budgetPerSession` | Track a per session dollar budget. Off by default. |
| `claudeTrace.budgetPerDay` | Track a daily dollar budget in the status bar, which changes color as you approach it. Off by default. |
| `claudeTrace.webhookPort` | Local port for the workflow webhook trigger. Set to 0 to disable. |
| `CLAUDE_TRACE_PROJECTS_DIR` (env var) | Read from this directory instead of `~/.claude/projects`. |

## Requirements

VS Code 1.85 or newer, and Claude Code 1.x or newer. The cockpit and workflows use tmux for session persistence, which ships on macOS and Linux. The cost dashboard and the skills and agents library work everywhere.

## Building from source

```bash
git clone https://github.com/nrigalle/claude-trace.git
cd claude-trace
npm install
npm run compile      # build the extension and webview bundles
npm run test:unit    # 1207 tests, vitest
```

Press `F5` in VS Code to launch a development host. The code is organized by feature under `src/features/` (dashboard, cockpit, pipelines, library), with pure logic in each `domain/`, VS Code and filesystem adapters in `infra/`, and orchestration in `app/`. The webview is its own TypeScript bundle under `media/src/`.

## Uninstall

```bash
code --uninstall-extension nrigalle.claude-trace
```

## License

MIT. See [LICENSE](LICENSE).
