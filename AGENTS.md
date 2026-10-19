# jules-task-archiver

Chrome Extension (Manifest V3) for bulk operations on Jules tasks via batchexecute API.

## Structure

- `manifest.json` -- Extension config: permissions, content_scripts, action
- `background.js` -- Service worker: batchexecute client, response parser, orchestrator, suggestions
- `content.js` -- Content script: WIZ_global_data token extraction + fetch observer (MAIN world)
- `items.js` -- Items list shared by popup and background: task states, labels, item resolution
- `popup.html/js/css` -- Popup UI: Items dropdown, Proceed/Archive, settings, schedule, progress display
- `fonts/` -- Libre Franklin and Roboto Mono (latin subsets, OFL / Apache 2.0)
- `icons/` -- Extension icons (16/48/128px)
- `tests/` -- Unit tests (node:test + vm sandbox)

## Architecture (v2)

```
popup.js (UI) <-> background.js (batchexecute client) <-> content.js (token extractor)
                        |                                        |
                  fetch() to jules.google.com          MAIN world injection
                  /_/Swebot/data/batchexecute          reads WIZ_global_data
                        |
                chrome.storage.session (state)
                chrome.storage.sync (settings)
```

The popup picks an **Item** (`items.js`: All, one entry per Jules task state with its code, or Suggestions) and one of two actions. Dry-run (on by default) lists what would happen and sends nothing that changes Jules; it still reads the quota.

Task state codes (`row[5]`): 12 Waiting on You, 10 Awaiting Plan Approval, 4 Error, 8 Paused, 2 In Progress, 9 Planning, 1 Queued, 11 Queued Restart, 3 and 7 Completed, 0 Unknown. A task without a state code counts as Completed (3).

1. **Archive** (tasks) -- ListTasks (p1Takd) -> tasks of the chosen item -> check GitHub PRs -> ArchiveTask (Tjmm5c). Force skips the open-PR check. All = every task.
2. **Proceed** (tasks) -- ListTasks (p1Takd) -> tasks of the chosen item, in this order: Waiting on You (reply: the default reply, with the message appended), Plan Approval (approve the plan), Paused (ResumeTask wk4vKd), running states (only with a message), Error (retry: the default retry prompt, with the message appended), Completed (follow-up, only with a message; under All only with Force). Replies, approvals and follow-ups go through GetTask (n74qPd, view 3) for the newest activity id -> Interact (SLmX6). Retries and follow-ups start a new run, so they are capped to the remaining daily quota (KQOO7), first come first served. A send is never retried (a 5xx may still have delivered it). Archived tasks are not covered.
3. **Proceed** (Suggestions) -- ListSources (YqkSHd) filtered to Suggestions-enabled repos -> ListSuggestions (hQP40d) per repo -> cap to remaining daily quota (KQOO7) -> StartSuggestion (Rja83d), one per suggestion, or with **One session for all** ONE per repo whose prompt carries every suggestion (an explicitly chosen owner/repo is used as-is). The message is appended to each prompt under "Additional instructions". Only repos whose per-repo Suggestions toggle is ON are touched; the daily session limit is never exceeded.
4. **Archive** (Suggestions) -- ListSources (YqkSHd) filtered to Suggestions-enabled repos -> ListSuggestions (hQP40d) per repo -> DismissSuggestion (sc1vFf) per suggestion.
5. **Export suggestions** (link) -- ListSources (all connected repos, read-only) -> ListSuggestions (hQP40d) per repo -> JSON file via chrome.downloads (re-downloadable from the popup).

START messages carry `{action: 'proceed'|'archive'|'export', item, dryRun, force, message, oneSession, ...}`; `resolveRunOptions` rejects an unknown action or item (a missing item never becomes All). The schedule (chrome.alarms) runs Archive Completed with the PR check, then optionally Proceed Suggestions.

Every action accepts an optional repository filter (popup dropdown or typed `owner/repo`); empty = all repos. Matching is exact and case-insensitive (`owner/plate` never matches `owner/plate-docs`).

Content script extracts auth tokens (SNlM0e, cfb2h, FdrFJe) from `WIZ_global_data` via MAIN world script injection. Also observes fetch() for Rja83d calls to capture model config and experiment IDs.

Background service worker makes all API calls. No DOM automation.

## Key RPC IDs

- `p1Takd` -- ListTasks (filter, state)
- `Tjmm5c` -- ArchiveTask (taskId, action)
- `hQP40d` -- ListSuggestions (repo)
- `Rja83d` -- StartSuggestion (prompt, model config, repo, experiment IDs)
- `sc1vFf` -- DismissSuggestion (suggestionId, [1]=2 dismiss)
- `n74qPd` -- GetTask `[taskId, 3]`; view 3 includes the activity log at `[0][3]`
- `SLmX6` -- Interact `[taskId, [_, [planId], [text, null, clientUuid], lastActivityId], null, [experimentIds]]`; `[1]` approves a plan, `[2]` sends a reply
- `wk4vKd` -- ResumeTask `[taskId]` (resumes a paused session; payload not yet confirmed against a live capture)

## Development

```bash
# Lint + format
npx @biomejs/biome check .
npx @biomejs/biome check --write .

# Run tests
node --test

# Load extension
# chrome://extensions -> Developer mode -> Load unpacked -> select this folder
```

## Commit Convention

Conventional Commits enforced by pre-commit hook.
Tag format: `v{version}`. PSR config: `semantic-release.toml`.

## CD Pipeline

workflow_dispatch (beta/stable) -> PSR v10 -> zip extension files -> upload to GitHub Release.
No Docker, no npm/pypi, no MCP registry.

## Important Notes

- Zero dependencies -- vanilla JS, no build step
- Biome for linting (biome.json config): single quotes, no semicolons, 120 line width
- batchexecute responses have XSS prefix `)]}'` and may contain raw control chars in JSON strings
- Tjmm5c archives in batches of 50; a batch rejected with an RPC error code (e.g. `[4]` DEADLINE_EXCEEDED) is retried in chunks of 10
- Service worker keepAlive: `setInterval` calling `chrome.runtime.getPlatformInfo()` every 25s
- State persisted in `chrome.storage.session` -- survives SW restart
- Tests use `vm.createContext` sandbox to mock Chrome APIs
