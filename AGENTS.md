# jules-task-archiver

Chrome Extension (Manifest V3) for bulk operations on Jules tasks via batchexecute API.

## Structure

- `manifest.json` -- Extension config: permissions, content_scripts, action
- `background.js` -- Service worker: batchexecute client, response parser, orchestrator, suggestions
- `content.js` -- Content script: WIZ_global_data token extraction + fetch observer (MAIN world)
- `popup.html/js/css` -- Popup UI: settings, operation mode, controls, progress display
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

Six operation modes:
1. **Archive Tasks** -- ListTasks (p1Takd) -> check GitHub PRs -> ArchiveTask (Tjmm5c)
2. **Start Suggestions** -- ListSources (YqkSHd) filtered to Suggestions-enabled repos -> ListSuggestions (hQP40d) per repo -> cap to remaining daily quota (KQOO7) -> StartSuggestion (Rja83d)
3. **Batch Agent** -- ListSources -> ListSuggestions (hQP40d) per repo -> ONE StartSuggestion (Rja83d) per repo whose prompt carries every suggestion; same toggle + daily-quota (KQOO7) rules as Start Suggestions, except an explicitly chosen owner/repo is used as-is.
4. **Remove Suggestions** -- ListSources (YqkSHd) filtered to Suggestions-enabled repos -> ListSuggestions (hQP40d) per repo -> DismissSuggestion (sc1vFf) per suggestion.
5. **Export Suggestions JSON** -- ListSources (all connected repos, read-only) -> ListSuggestions (hQP40d) per repo -> JSON file via chrome.downloads (re-downloadable from the popup).
6. **Continue Waiting** -- ListTasks (p1Takd) -> tasks in state 12 (awaiting user feedback), 10 (awaiting plan approval) or 4 (error) -> GetTask (n74qPd, view 3) for the newest activity id -> Interact (SLmX6): the reply for state 12, a plan approval for state 10, the retry prompt for state 4. A retry starts a new run, so failed sessions are capped to the remaining daily quota (KQOO7); replies to live sessions are not. The reply is never retried (a 5xx may still have delivered it); a re-run only finds tasks still waiting. Archived tasks are not covered.

Every mode accepts an optional repository filter (popup dropdown or typed `owner/repo`); empty = all repos. Matching is exact and case-insensitive (`owner/plate` never matches `owner/plate-docs`).

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
