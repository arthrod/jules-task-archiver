# Jules Task Archiver

**Chrome Extension for bulk operations on Jules tasks via batchexecute API -- archive tasks and start code suggestions at scale.**

[![CI](https://github.com/n24q02m/jules-task-archiver/actions/workflows/ci.yml/badge.svg)](https://github.com/n24q02m/jules-task-archiver/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/n24q02m/jules-task-archiver/branch/main/graph/badge.svg)](https://codecov.io/gh/n24q02m/jules-task-archiver)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Renovate](https://img.shields.io/badge/renovate-enabled-brightgreen.svg)](https://renovatebot.com)
[![semantic-release](https://img.shields.io/badge/semantic--release-conventionalcommits-e10079?logo=semantic-release)](https://github.com/semantic-release/semantic-release)

<!-- BEGIN: AUTO-GENERATED-CROSS-PROMO -->
<details>
  <summary><strong>Sister projects from n24q02m</strong> (click to expand)</summary>

| Project | Tagline | Tag |
|---|---|---|
| [agent-chat-plugin](https://github.com/n24q02m/agent-chat-plugin) | Peer AI agents chat in a shared folder — no human relay, no orchestrator, wor... | Tooling |
| [better-code-review-graph](https://github.com/n24q02m/better-code-review-graph) | Knowledge graph for token-efficient code reviews -- semantic search and call-... | MCP |
| [better-drive](https://github.com/n24q02m/better-drive) | 2-way Google Drive sync with .driveignore filter — rclone engine, Windows tray | Tooling |
| [better-email-mcp](https://github.com/n24q02m/better-email-mcp) | IMAP/SMTP email for AI agents -- read, send, organize folders, and manage att... | MCP |
| [better-godot-mcp](https://github.com/n24q02m/better-godot-mcp) | Composite MCP server for Godot Engine -- 17 composite tools for AI-assisted g... | MCP |
| [better-notion-mcp](https://github.com/n24q02m/better-notion-mcp) | Markdown-first Notion for AI agents -- pages, databases, blocks, and comments... | MCP |
| [better-semantic-release](https://github.com/n24q02m/better-semantic-release) | Drop-in python-semantic-release fork with built-in release-safety guards (orp... | Tooling |
| [better-telegram-mcp](https://github.com/n24q02m/better-telegram-mcp) | Telegram for AI agents -- messages, chats, media, and contacts across both bo... | MCP |
| [better-workspace-mcp](https://github.com/n24q02m/better-workspace-mcp) | Google Workspace MCP server (Docs/Drive/Calendar/Gmail/Sheets/Slides/Tasks/Ch... | MCP |
| [claude-plugins](https://github.com/n24q02m/claude-plugins) | Claude Code plugin marketplace for the n24q02m MCP servers -- install web sea... | Marketplace |
| [imagine-mcp](https://github.com/n24q02m/imagine-mcp) | Image and video understanding + generation for AI agents -- across Gemini, Op... | MCP |
| [jules-task-archiver](https://github.com/n24q02m/jules-task-archiver) | Chrome Extension for bulk operations on Jules tasks via batchexecute API -- a... | Tooling |
| [mcp-core](https://github.com/n24q02m/mcp-core) | Shared foundation for building MCP servers -- Streamable HTTP transport, OAut... | MCP |
| [mnemo-mcp](https://github.com/n24q02m/mnemo-mcp) | Persistent AI memory with hybrid search and embedded sync. Open, free, unlimi... | MCP |
| [qwen3-embed](https://github.com/n24q02m/qwen3-embed) | Lightweight Qwen3 text embedding and reranking via ONNX Runtime and GGUF | Library |
| [skret](https://github.com/n24q02m/skret) | Secrets without the server. | CLI |
| [tacet](https://github.com/n24q02m/tacet) | A self-distilling neuro-symbolic cascade that amortises LLM cost across knowl... | Tooling |
| [web-core](https://github.com/n24q02m/web-core) | Shared web infrastructure package for search, scraping, HTTP security, and st... | Library |
| [wet-mcp](https://github.com/n24q02m/wet-mcp) | Open-source MCP server for AI agents: web search, content extraction, and lib... | MCP |

</details>
<!-- END: AUTO-GENERATED-CROSS-PROMO -->

## Table of contents

- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [How It Works](#how-it-works)
- [Permissions](#permissions)
- [Development](#development)
- [Related Projects](#related-projects)
- [Contributing](#contributing)
- [License](#license)



## Features

### Items, Proceed and Archive

Pick an **Item** -- All, one Jules task state (each listed with its state code, e.g. *Waiting on You (12)*, *Error (4)*, *Completed (3)*), or Suggestions -- then press **Proceed** or **Archive**.

- **Proceed** moves each task forward according to its state:
  - *Waiting on You* -- sends the default reply, with your message appended
  - *Awaiting Plan Approval* -- approves the plan
  - *Paused* -- resumes the session
  - *Error* -- retries with the default retry prompt, with your message appended
  - *In Progress, Planning, Queued* -- sends your message (nothing without one)
  - *Completed* -- sends your message as a follow-up (nothing without one). Under **All**, Completed tasks are skipped unless **Force** is on
  - Tasks are handled in that order. Retries and follow-ups start a new run, so they are capped to the daily sessions you have left
- **Archive** archives the chosen item's tasks, skipping tasks with a matching open GitHub PR. **Force** skips that check
- **Dry-run** (on by default) lists what would happen without changing anything
- **Add a message** appends your text (up to 2000 characters) to whatever the extension sends: the default reply, the retry prompt, each suggestion prompt. Running and Completed tasks get it on its own. Plan approvals and resumes take no message. The **?** next to Force and Add a message explains what they do for the chosen item
- The popup asks before risky live runs: Archive on All, any Force archive, and a Force Proceed that messages Completed tasks

### Suggestions

- **Proceed** starts every queued code suggestion (security, performance, testing, cleanup) on Suggestions-enabled repos, with a prompt tailored to its category, capped to the daily sessions you have left
- **One session for all** starts one Jules session per repo whose prompt carries every queued suggestion
- **Archive** dismisses the queued suggestions
- **Export suggestions** saves every suggestion across all connected repos to `jules-suggestions-YYYY-MM-DD.json` (one file per account); the popup's re-download combines all accounts under `accounts`
- **Config capture** -- observes the Jules UI to capture model config and experiment IDs for accurate reproduction
- **Repository filter** -- every action can be narrowed to one repo from the dropdown or a typed `owner/repo`

### Settings

The **Settings** panel (header) holds everything you may want to tune:

- **GitHub** -- owner for the open-PR check, and an optional token for private repos
- **Timeouts** -- per request (30 s) and for listing every task (300 s; big accounts take minutes)
- **Pacing** -- requests sent together each wait a random 0.5–2 s first; **Extra jitter** adds up to N more seconds (off, 10 s). **Parallel requests** caps how many go at once (6 per account, 12 in total). When Jules answers HTTP 429, that account pauses for as long as Jules asks
- **Run up to N items** -- the whole run (dry and scheduled runs too) acts on at most N items; 0 means no limit
- **Reload the Jules tab when its sign-in stops working** (on) -- when Jules rejects the tokens, the extension tries the fresh token Jules sends back, then mints one, then re-reads the page, then reloads the tab; if none works it stops that account and tells you to sign in. It never reloads a tab you have moved off Jules or to another account
- **Default messages** -- your own default reply (Waiting on You) and retry prompt (Error); empty uses the built-in text, and **Add a message** goes after it
- **Jules API values** -- the RPC id of each Jules method, the archive batch size and the task states. **Rediscover from Jules** reads them from the Jules web app in an open tab and applies any change (after the run in progress, if one is going); it also runs once a day. **Reset to defaults** goes back to the built-in values
- **About** -- License & Credits

### Scheduled Operations

- **Auto-archive on a schedule** -- `chrome.alarms`-driven periodic archive of finished tasks across all Jules tabs; runs in the background while the popup is closed (service-worker safe, no `setInterval`)
- **Scheduled suggestion start** -- optionally start queued code suggestions after each archive tick, capped per tick to bound API usage (Jules' daily session quota still applies)
- **Configurable** -- interval in minutes and independent toggles in the popup's Schedule section; both default to OFF

### General

- **Multi-account** -- processes all Jules tabs (`/u/0`, `/u/1`, etc.) automatically
- **Dry run mode** -- preview what would happen without making changes
- **batchexecute API** -- direct HTTP calls, no DOM automation, 10x faster than UI clicks
- **Live progress** -- real-time log and progress bar in popup UI
- **State persistence** -- operation continues even if popup is closed; progress restored on reopen

## Installation

1. Download the latest `jules-task-archiver.zip` from [Releases](../../releases)
2. Extract the zip
3. Open `chrome://extensions` in Chrome
4. Enable **Developer mode** (top right toggle)
5. Click **Load unpacked** and select the extracted folder

After you update the files of an unpacked extension, click **Reload** (↻) on its card in `chrome://extensions`. Until then Chrome keeps running the old background, and the popup refuses to run, with a banner that says so.

## Usage

1. Open one or more `jules.google.com` tabs (supports multiple accounts)
2. Click the extension icon in the toolbar
3. Choose:
   - **Items** -- All, one task state, or Suggestions. The popup remembers your choice; if that state no longer exists (Jules renumbered it), it shows **Choose an item** instead of falling back to All
   - **Dry-run** -- on: preview only; off: make the changes
   - **Force** -- Archive skips the open-PR check; Proceed on All also messages Completed tasks. Without Force, a repo whose open PRs can't be read from GitHub (a 404 is tried once more) keeps its tasks: they are skipped, not archived
   - **Add a message** -- text appended to what Proceed sends
   - **One session for all** -- Suggestions only: one session per repo
   - **Scope** -- all Jules tabs or the current tab only
   - **Repository** -- All Repositories (default), one repo from the list, or a typed `owner/repo`
   - **Settings** (header) -- GitHub, timeouts, pacing, run limit, default messages and the Jules API values (see [Settings](#settings))
4. Click **Proceed** or **Archive**

5. (Optional) In **Schedule**, enable **Archive Completed tasks automatically**, set the interval in minutes, and optionally enable **Also start suggestions each run** with a max-starts cap. Scheduled runs archive Completed tasks (3, 7 and tasks without a state) with the open-PR check -- they never Force.

**More Actions** (before Export) loads one category for all repos or one `org/repo`: **All** (tasks and schedules, without the archived tasks, like Jules' All tab), **Scheduled**, **Completed** or **Archived**. Typing a repo picks **Repo**. Select items, choose an action and click **Confirm**. The action list offers what Jules' own item menus offer for the shown items: **Pause session** / **Resume session** (running / paused tasks), **Copy session URL** and **Archive** (tasks; archived tasks get **Unarchive**), **Pause schedule** / **Resume schedule** and **Delete schedule** (schedules). Only eligible items receive the action. **Copy session URL** puts the selected tasks' URLs on the clipboard, one per line. **Delete schedule** can't be undone, so Confirm asks for a second click. Confirm acts for real unless the panel's own **Dry run** box is checked. **Archive** skips a task with a matching open PR, as the main Archive does; **Force** skips that check. The Settings item limit applies. Unarchive checks the result and retries missing items once. Archived for one repo takes seconds. Archived for all repos lists every repo in turn, a few at a time (the Parallel per account setting), disconnected repos included, and shows "N of M repos" meanwhile. On a large account that takes minutes: about 16 for 2,084 repos at 6 in parallel. Keep the popup open until it finishes. Listing errors appear beside the counts. A task without a title shows its prompt's first line, and a completed task Jules marks for review shows as "Ready for review". Tasks are never deleted.

### Suggestions tips

- For best results, manually click "Start" on any suggestion in the Jules UI first -- the extension captures the model config and experiment IDs from that request
- Without this capture, the extension uses sensible defaults that may differ from Jules' current configuration

## How It Works

### v2 Architecture

```
popup.js (UI) <-> background.js (batchexecute client) <-> content.js (message relay)
                        |                                        |
                  fetch() to jules.google.com          main-world.js (MAIN world)
                  /_/Swebot/data/batchexecute          reads WIZ_global_data tokens
```

1. `main-world.js` runs in the page's MAIN world, reads auth tokens from `WIZ_global_data`, and observes fetch calls for StartSuggestion config
2. `content.js` relays tokens and config to the background service worker
3. `background.js` makes direct HTTP calls to Jules' batchexecute API endpoint
4. `popup.js` displays real-time progress and manages settings

### RPC IDs

| RPC | ID | Purpose |
|-----|-----|---------|
| ListTasks | `p1Takd` | Fetch all active tasks |
| ArchiveTask | `Tjmm5c` | Archive a single task |
| ListSuggestions | `hQP40d` | Fetch code suggestions for a repo |
| StartSuggestion | `Rja83d` | Start a suggestion as a new task |
| DismissSuggestion | `sc1vFf` | Remove a queued suggestion |
| ListSources | `YqkSHd` | Connected repos + per-repo Suggestions toggle |
| DailyQuota | `KQOO7` | Sessions used today vs. daily limit |

## Permissions

| Permission | Why |
|-----------|-----|
| `storage` | Save settings, schedule config, and operation state |
| `tabs` | Query all Jules tabs for multi-account support |
| `scripting` | Inject content script into pre-existing tabs |
| `alarms` | Periodic scheduled archive/suggestion ticks via `chrome.alarms` |
| `downloads` | Save the Export Suggestions JSON file |
| `notifications` | Notify when an export is saved or a Batch Agent is dispatched |
| `jules.google.com` | Content script for token extraction |
| `api.github.com` | Check open PRs via GitHub REST API |

## Development

```bash
# Lint and format
npx @biomejs/biome check .
npx @biomejs/biome check --write .

# Run tests
node --test

# Load unpacked in chrome://extensions for testing
```

No build step, no dependencies. Pure vanilla JavaScript with `node:test` for unit tests.

## Related Projects

Check out these MCP servers for AI-powered development:

- [wet-mcp](https://github.com/n24q02m/wet-mcp) -- Web search, extract, and media MCP server
- [better-notion-mcp](https://github.com/n24q02m/better-notion-mcp) -- Notion API MCP server
- [mnemo-mcp](https://github.com/n24q02m/mnemo-mcp) -- Persistent AI memory MCP server

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Credits

Repository filtering, Remove Suggestions, Export Suggestions JSON and Batch Agent were contributed by [tommyzed](https://github.com/tommyzed/jules-task-manager) and [PaddyO84](https://github.com/PaddyO84/jules-task-manager). See `license.html` (popup → License & Credits).

## License

[Apache-2.0](LICENSE)
