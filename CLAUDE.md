# jules-task-archiver

Chrome Extension (Manifest V3) for bulk operations on Jules tasks via batchexecute API.

## Structure

- `manifest.json` -- Extension config: permissions, content_scripts, action
- `background.js` -- Service worker: batchexecute client, response parser, orchestrator, suggestions
- `content.js` -- Content script: WIZ_global_data token extraction + fetch observer (MAIN world)
- `items.js` -- Items list shared by popup and background: task states, labels, item resolution
- `settings.js` -- Settings shared by popup and background: defaults and limits, Jules API values, bundle rediscovery parser
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
                chrome.storage.sync (settings, schedule)
                chrome.storage.local (GitHub token, Jules API values)
```

The popup picks an **Item** (`items.js`: All, one entry per Jules task state with its code, or Suggestions) and one of two actions. Dry-run (on by default) lists what would happen and sends nothing that changes Jules; it still reads the quota.

Task state codes (`row[5]`): 12 Waiting on You, 10 Awaiting Plan Approval, 4 Error, 8 Paused, 2 In Progress, 9 Planning, 1 Queued, 11 Queued Restart, 3 and 7 Completed, 0 Unknown. A task without a state code counts as Completed (3).

1. **Archive** (tasks) -- ListTasks (p1Takd) -> tasks of the chosen item -> check GitHub PRs -> ArchiveTask (Tjmm5c). Force skips the open-PR check. A repo whose open PRs can't be read (GitHub 404 is retried once after a random wait, with the request timeout + 1 s; any other failure is not) has its tasks skipped, never archived. All = every task.
2. **Proceed** (tasks) -- ListTasks (p1Takd) -> tasks of the chosen item, in this order: Waiting on You (reply: the default reply, with the message appended), Plan Approval (approve the plan), Paused (ResumeTask wk4vKd), running states (only with a message), Error (retry: the default retry prompt, with the message appended), Completed (follow-up, only with a message; under All only with Force). Replies, approvals and follow-ups go through GetTask (n74qPd, view 3) for the newest activity id -> Interact (SLmX6). Retries and follow-ups start a new run, so they are capped to the remaining daily quota (KQOO7), first come first served. A send is never retried (a 5xx may still have delivered it). Archived tasks are not covered.
3. **Proceed** (Suggestions) -- ListSources (YqkSHd) filtered to Suggestions-enabled repos -> ListSuggestions (hQP40d) per repo -> cap to remaining daily quota (KQOO7) -> StartSuggestion (Rja83d), one per suggestion, or with **One session for all** ONE per repo whose prompt carries every suggestion (an explicitly chosen owner/repo is used as-is). The message is appended to each prompt under "Additional instructions". Only repos whose per-repo Suggestions toggle is ON are touched; the daily session limit is never exceeded.
4. **Archive** (Suggestions) -- ListSources (YqkSHd) filtered to Suggestions-enabled repos -> ListSuggestions (hQP40d) per repo -> DismissSuggestion (sc1vFf) per suggestion.
5. **Export suggestions** (link) -- ListSources (all connected repos, read-only) -> ListSuggestions (hQP40d) per repo -> JSON file via chrome.downloads (re-downloadable from the popup).

START messages carry `{action: 'proceed'|'archive'|'export', item, dryRun, force, message, oneSession, ...}`; `resolveRunOptions` rejects an unknown action or item (a missing item never becomes All). The schedule (chrome.alarms) runs Archive Completed with the PR check, then optionally Proceed Suggestions.

Every action accepts an optional repository filter (popup dropdown or typed `owner/repo`); empty = all repos. Matching is exact and case-insensitive (`owner/plate` never matches `owner/plate-docs`).

## Settings and client behavior

- **Popup ↔ background version** (`RUN_PROTOCOL`, `START_OPTION_KEYS` in `settings.js`): Chrome reads the popup from disk each time it opens but keeps the old service worker until the extension is reloaded; on 2026-10-19 an old worker read a new popup's Proceed as "archive every task" (65 tasks). The popup asks `HELLO` on open and before every run and, when the answer is missing or differs, blocks every run and locks the schedule (the old worker would act on a schedule change; it stays locked until HELLO answers, and once stale it stays stale) behind a "reload the extension" banner; the background refuses a START without the same `protocol` or with an option outside `START_OPTION_KEYS`. Bump `RUN_PROTOCOL` whenever a popup↔background message changes meaning.
- **Settings** (`chrome.storage.sync`: key `settings` for the numbers and switches, `defaultReply` / `defaultRetry` each under their own key so neither passes sync's 8 KB per item; `settingsFromSync` / `settingsToSync` in `settings.js`; the old popup's `continueMessage` / `continueErrorMessage` are read until the first successful save removes them): request timeout 30 s, task-list timeout 300 s, extra jitter (off, up to 10 s), parallel requests 6 per account / 12 total, Run up to N items (0 = no limit; dry and scheduled runs count too; a scheduled tick's archive and suggestion steps share one budget, and an account the archive step paused or stopped stays so for the suggestions (`resetRunLimits` runs once per tick); Export is read-only and not counted), default reply / retry (empty = built-in), reload the tab on sign-in failure (on). The background keeps them in memory and follows `storage.onChanged`; if the start-up read fails, START and the scheduled tick refuse until the extension is reloaded. START also waits for the run state a woken worker restores.
- **Pacing** (`postBatchExecute`, at each POST to Jules): the per-account and total parallel limits apply to every physical request, retries included, until its reply has downloaded (`jFetch({ buffer: true })` reads the body under the request timeout; of the error bodies only a 400's is read, for its sign-in token, so a 429 pauses the account on its headers and one that stalls keeps its status); a request sent while others of its account are in flight waits a random 500–2000 ms first, plus the extra jitter; a lone request goes straight out. GitHub PR checks sent together wait the same random delay (`githubActive`), and their bodies are buffered too.
- **HTTP 429**: the account's requests wait out Retry-After (seconds or a date; 30 s when absent). More than 5 minutes, or a 4th 429 in a row for the account (counted across its requests, reset by any success), stops that account for the run. `isRetryable` does not retry 429.
- **Sign-in ladder** on 400/401/403, shared by all requests of a run's config: the xsrf token in the 400 body -> a token minted by KQOO7 sent without `at` -> `WIZ_global_data` re-read past content.js's 5-minute cache (`GET_CONFIG {fresh: true}`) -> reload the tab (setting; only while it is still on Jules for that account) and read again -> stop with "Open that Jules tab, check you're signed in". bl and f.sid refresh with the token.
- **Jules API values** (`chrome.storage.local` key `julesApi`): RPC id per `SweBotService` method, archive batch 50 / split 10, task states (`null` = the built-in table in `items.js`). `rpc('Method')` returns the id in force. **Rediscover from Jules** (popup, `REDISCOVER_API`) and the daily `jta-api-rediscover` alarm run `readJulesBundle` in a Jules tab (only https scripts on jules.google.com / *.gstatic.com), apply the changes and keep the last 20 checks in `julesApiLog`. If fewer than half the RPCs are found, nothing changes. Rediscovery is refused while a run is going, one check runs at a time (each script gets 20 s, the whole check 2 min; a check that ran out of time is not applied, so it can't roll back a newer one), and new values (from a rediscovery or the Settings panel) wait for the run in progress to end. content.js passes the CreateTask id in force to main-world.js (`JULES_CREATE_TASK_RPC`).

Content script extracts auth tokens (SNlM0e, cfb2h, FdrFJe) from `WIZ_global_data` via MAIN world script injection. Also observes fetch() for CreateTask (Rja83d) calls to capture model config and experiment IDs (`fetch(url, init)`, `fetch(URL)` and `fetch(Request)`; a Request body is read from a clone before the page sends it).

Background service worker makes all API calls. No DOM automation.

## Key RPC IDs

- `p1Takd` -- ListTasks (filter, state)
- `Tjmm5c` -- ArchiveTasks `[taskIds, 1]` archives, `[taskIds]` unarchives (the Jules client drops `false`); a `[]` reply can still skip an id, so check with ListTasks
- `tqq5v` -- PauseTask / stop a running session (taskId)
- `YqkSHd` -- ListSources (connected repos); row `[5][2][0] === 2` => Suggestions toggle ON
- `hQP40d` -- ListSuggestions (repo); returns the raw pool, does NOT respect the toggle
- `e4motb` -- SetSuggestionsToggle (repo, [2]=enable / [1]=disable)
- `Rja83d` -- StartSuggestion (prompt, model config, repo, experiment IDs)
- `sc1vFf` -- DismissSuggestion (suggestionId, [1]=2 dismiss)
- `UTrvy` -- Suggestions-repo counter `[max, enabled, free]` (e.g. `[5,3,2]` = 3/5 repos enabled)
- `KQOO7` -- Daily session quota `[usedToday, [windowSeconds], dailyLimit, ...]`
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
Both jobs use the built-in `GITHUB_TOKEN` (`contents: write`): the repo is a fork with no GitHub App, and `main` is not protected.
No Docker, no npm/pypi, no MCP registry.

## Important Notes

- Zero dependencies -- vanilla JS, no build step
- Biome for linting (biome.json config): single quotes, no semicolons, 120 line width
- batchexecute responses have XSS prefix `)]}'` and may contain raw control chars in JSON strings
- Tjmm5c archives in batches of 50; a batch rejected with an RPC error code (e.g. `[4]` DEADLINE_EXCEEDED) is retried in chunks of 10
- Service worker keepAlive: `setInterval` calling `chrome.runtime.getPlatformInfo()` every 25s
- State persisted in `chrome.storage.session` -- survives SW restart
- Tests use `vm.createContext` sandbox to mock Chrome APIs
