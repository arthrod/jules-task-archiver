// Modified by tommyzed: Added repository filtering and suggestions
importScripts('utils.js', 'items.js', 'settings.js')
/**
 * Jules Task Archiver v2 — Background Service Worker
 *
 * Orchestrates bulk archive via Jules batchexecute RPC API.
 * No DOM automation — all operations are HTTP fetch calls.
 */

// =============================================================================
// Constants
// =============================================================================

const JULES_ORIGIN = 'https://jules.google.com'

// Max number of in-flight network operations. Caps fan-out so a tab with many
// repos/tasks does not fire hundreds of simultaneous fetches at once.
const API_CONCURRENCY = 5

// Fan-out. Accounts (tabs) are processed in parallel; each account drains its
// own pool of settings.perAccountParallel, while a shared limiter caps the
// TOTAL in-flight requests at settings.totalParallel so parallel work cannot
// overwhelm Jules (which rate-limits with HTTP 429).
// ArchiveTasks takes an array of task IDs, so tasks are archived in batches of
// julesApi.archiveBatch (50). A 50-id batch can be rejected with an RPC error
// code (seen live: [4], DEADLINE_EXCEEDED, on 2 of 147 batches) while the same
// ids succeed in smaller chunks, so a rejected batch is retried in chunks of
// julesApi.archiveSplit (10). Not anchored: callBatchExecute rethrows as
// "batchexecute Tjmm5c failed: RPC Tjmm5c error code [4]".
const RPC_ERROR_CODE_REGEX = /\bRPC \w+ error code \[/

// ⚡ Bolt Optimization: After parsing the URL, use a fast regex test to extract
// the account ID instead of allocating string arrays via `.split('/')`. This avoids
// object allocation overhead while preserving the original strict URL validation.
const ACCOUNT_NUM_REGEX = /\/u\/(\d+)(?:\/|$)/

// =============================================================================
// Settings and Jules API values (settings.js)
// =============================================================================

// Kept in memory and refreshed from storage (see the onChanged listener), so
// every request reads the values in force at that moment.
let settings = normalizeSettings()
let julesApi = normalizeJulesApi()

// New values (from a rediscovery or the Settings panel) wait for the run in
// progress to end, so one run never mixes two sets of RPC ids or states.
let pendingJulesApi = null

function applyJulesApi(raw) {
  if (state.status === 'running') {
    pendingJulesApi = { raw }
    return
  }
  pendingJulesApi = null
  julesApi = normalizeJulesApi(raw)
  setTaskStates(julesApi.states)
}

function applyPendingJulesApi() {
  if (pendingJulesApi) applyJulesApi(pendingJulesApi.raw)
}

// The sync values behind `settings`, kept so a change to one key can be
// merged with the rest.
const syncSettings = {}

// A change that lands while the start-up read is in flight is newer than
// what that read returns, so the read doesn't overwrite it.
const changedSinceStart = { syncKeys: new Set(), julesApi: false }

// Why the start-up read failed, or null. Runs refuse to start meanwhile:
// running on the defaults would drop "Run up to N" and the saved RPC ids.
let settingsLoadError = null

const settingsReadyPromise = Promise.allSettled([
  chrome.storage?.sync?.get?.(SETTINGS_SYNC_KEYS),
  chrome.storage?.local?.get?.(JULES_API_KEY)
]).then(([syncRead, localRead]) => {
  if (syncRead.status === 'fulfilled') {
    for (const key of SETTINGS_SYNC_KEYS) {
      if (!changedSinceStart.syncKeys.has(key)) syncSettings[key] = syncRead.value?.[key]
    }
    settings = settingsFromSync(syncSettings)
  }
  if (localRead.status === 'fulfilled' && !changedSinceStart.julesApi) applyJulesApi(localRead.value?.[JULES_API_KEY])
  const failed = [syncRead, localRead].find((read) => read.status === 'rejected')
  if (failed) {
    settingsLoadError = failed.reason?.message || String(failed.reason)
    console.error('[JTA] Could not load settings:', failed.reason)
  }
})

function settingsProblem() {
  if (!settingsLoadError) return null
  return `Could not read the settings (${settingsLoadError}). Reload the extension at chrome://extensions.`
}

// The popup saves settings to sync and the Jules API values to local storage.
chrome.storage?.onChanged?.addListener((changes, area) => {
  const syncKeys = area === 'sync' ? SETTINGS_SYNC_KEYS.filter((key) => key in changes) : []
  for (const key of syncKeys) {
    changedSinceStart.syncKeys.add(key)
    syncSettings[key] = changes[key].newValue
  }
  if (syncKeys.length) settings = settingsFromSync(syncSettings)
  if (area === 'local' && JULES_API_KEY in changes) {
    changedSinceStart.julesApi = true
    applyJulesApi(changes[JULES_API_KEY].newValue)
  }
})

// The RPC id Jules uses today for a SweBotService method (see settings.js). A
// method a rediscovery put in doubt may hold another method's id, so it is
// never sent.
function rpc(method) {
  if (julesApi.inDoubt.includes(method)) {
    throw new Error(`Jules' ${method} id is in doubt: Rediscover from Jules or Reset to defaults in Settings first.`)
  }
  return julesApi.rpc[method]
}

// =============================================================================
// Scheduling (chrome.alarms)
// =============================================================================

// MV3 service workers cannot rely on setInterval — the worker is killed between
// invocations — so scheduled runs use chrome.alarms, which persists across
// worker restarts and survives popup close. One periodic alarm drives the
// whole scheduled tick (archive, then optional suggestion-start).
const SCHEDULE_ALARM_NAME = 'jta-scheduled-tick'

const DEFAULT_SCHEDULE = {
  schedEnabled: false,
  schedIntervalMin: 60,
  schedStartSuggestions: false,
  // Cap on suggestion-starts per tick (across ALL accounts) so a scheduled run
  // cannot fan out into hundreds of Rja83d calls. Jules' per-account daily
  // session quota (KQOO7) still applies on top of this.
  schedMaxStarts: 20
}

const MIN_INTERVAL_MIN = 1
const MAX_INTERVAL_MIN = 24 * 60 // 1 day — the useful ceiling for a cleanup cron
const MIN_MAX_STARTS = 1
const MAX_MAX_STARTS = 500

function clampInt(value, min, max, fallback) {
  if (value === null || value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

// Coerce whatever is in storage (or partially stored) into a valid config.
// Missing/bad values fall back to DEFAULT_SCHEDULE so a corrupted sync entry
// can never yield interval 0 (Chrome throws for periodInMinutes < 1) or an
// unbounded suggestion fan-out.
function normalizeSchedule(raw) {
  const src = raw || {}
  return {
    schedEnabled: src.schedEnabled === true,
    schedIntervalMin: clampInt(
      src.schedIntervalMin,
      MIN_INTERVAL_MIN,
      MAX_INTERVAL_MIN,
      DEFAULT_SCHEDULE.schedIntervalMin
    ),
    schedStartSuggestions: src.schedStartSuggestions === true,
    schedMaxStarts: clampInt(src.schedMaxStarts, MIN_MAX_STARTS, MAX_MAX_STARTS, DEFAULT_SCHEDULE.schedMaxStarts)
  }
}

async function getScheduleConfig() {
  const data = await chrome.storage.sync.get(Object.keys(DEFAULT_SCHEDULE))
  return normalizeSchedule(data)
}

// Reconcile the persisted alarm with current config. The service worker runs
// this on every startup (alarms survive worker restarts, the worker does not),
// so it checks the existing alarm's period before re-creating — re-creating
// unconditionally would push the next fire time forward on every SW restart.
async function syncScheduleAlarm() {
  if (!chrome.alarms) return
  const cfg = await getScheduleConfig()
  const existing = await chrome.alarms.get(SCHEDULE_ALARM_NAME)
  if (!cfg.schedEnabled) {
    if (existing) await chrome.alarms.clear(SCHEDULE_ALARM_NAME)
    return
  }
  if (!existing || existing.periodInMinutes !== cfg.schedIntervalMin) {
    await chrome.alarms.create(SCHEDULE_ALARM_NAME, {
      delayInMinutes: cfg.schedIntervalMin,
      periodInMinutes: cfg.schedIntervalMin
    })
  }
}

// One alarm tick: archive Completed tasks (with the open-PR check; Force stays
// a deliberate manual choice), then optionally start queued suggestions with a
// per-tick global cap.
async function runScheduledTick() {
  await Promise.all([stateReadyPromise, settingsReadyPromise])
  if (settingsProblem()) {
    console.error('[JTA] Scheduled tick skipped:', settingsProblem())
    return
  }
  const cfg = await getScheduleConfig()
  if (!cfg.schedEnabled) return // defensive: config toggled off after alarm fired
  if (state.status === 'running' || startPending) {
    // A manual operation is in flight; skipping is safer than racing two bulk
    // runs against the same accounts (Jules rate-limits with HTTP 429).
    console.log('[JTA] Scheduled tick skipped: operation already running')
    return
  }

  // The two steps are one run: they share the Run up to N budget, and an
  // account the archive step paused or stopped stays so for the suggestions.
  // Reset here, before either step, so a step that fails early can't skip it.
  resetRunLimits()
  await startOperation({
    action: 'archive',
    items: ['Completed'],
    dryRun: false,
    force: false,
    scope: 'all',
    scheduled: true,
    tickStep: true
  })
  // A manual run may have started while the archive step was finishing.
  if (cfg.schedStartSuggestions && state.status !== 'running' && !startPending) {
    await startOperation({
      action: 'proceed',
      items: [ITEM_SUGGESTIONS],
      dryRun: false,
      force: false,
      scope: 'all',
      maxSuggestions: cfg.schedMaxStarts,
      scheduled: true,
      tickStep: true
    })
  }
}
function extractAccountNum(url) {
  try {
    const pathname = new URL(url).pathname
    const match = ACCOUNT_NUM_REGEX.exec(pathname)
    return match ? match[1] : '0'
  } catch (_e) {
    return '0'
  }
}

// =============================================================================
// Network Utilities
// =============================================================================

/**
 * Standard fetch wrapper with error handling and token injection.
 */
async function jFetch(url, options = {}) {
  const urlObj = new URL(url)
  const origin = urlObj.origin
  if (origin !== JULES_ORIGIN && origin !== 'https://api.github.com') {
    throw new Error('Security Error: Disallowed fetch origin')
  }

  const { token, headers = {}, timeout = settings.requestTimeoutSec * 1000, buffer = false, ...rest } = options
  const safeHeaders = { ...headers }

  if (token) {
    if (origin !== 'https://api.github.com') {
      throw new Error('Security Error: Refusing to send GitHub token to non-GitHub origin')
    }
    if (typeof token !== 'string') throw new Error('Token must be a string')
    if (/[\r\n]/.test(token)) throw new Error('Invalid token: contains newline')
    safeHeaders.Authorization = `token ${token}`
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    // 🛡️ Sentinel: Prevent accidental token leakage via open redirects
    // Only restrict redirects when sending credentials, and ensure the restriction cannot be bypassed by `...rest`
    const finalRedirect = token ? 'error' : rest.redirect || 'follow'
    const res = await fetch(url, { headers: safeHeaders, signal: controller.signal, ...rest, redirect: finalRedirect })
    // With `buffer`, the body is read under the same timeout, so a reply that
    // stops arriving fails instead of hanging the run. Of the error bodies only
    // a 400's is needed (it can carry a fresh sign-in token); any other error,
    // a 429 above all, is thrown on its headers at once, so the account pauses
    // before more requests go out.
    const readBody = buffer && (res.ok || res.status === 400)
    if (buffer && !readBody) res.body?.cancel?.().catch(() => {})
    const reply = readBody ? await bufferedReply(res) : res
    if (!res.ok) {
      // Callers that need the error body (e.g. the XSRF refresh) read it here.
      const err = new Error(`HTTP ${res.status}`)
      err.status = res.status
      err.response = reply
      throw err
    }
    return reply
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('NetworkError: Request timed out')
    }
    throw e
  } finally {
    clearTimeout(timeoutId)
  }
}

async function bufferedReply(res) {
  let text
  try {
    text = await res.text()
  } catch (e) {
    // An error body that won't read, or stops arriving, only loses its hints:
    // the status (a 429's Retry-After too) still stands.
    if (res.ok) throw e
    text = ''
  }
  return {
    ok: res.ok,
    status: res.status,
    headers: res.headers,
    text: async () => text,
    json: async () => JSON.parse(text)
  }
}

/**
 * Run `worker` over every item with at most `limit` tasks in flight at once.
 * Results are returned in input order. Unlike `Promise.all(items.map(...))`,
 * this bounds concurrency so large fan-outs cannot overwhelm the network.
 */
async function runInPool(items, limit, worker) {
  const len = items.length
  const results = new Array(len)
  let cursor = 0

  async function drain() {
    while (cursor < len) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  }

  const poolSize = len > 0 ? Math.max(1, Math.min(Math.floor(limit) || 1, len)) : 0
  const pool = new Array(poolSize)
  for (let i = 0; i < poolSize; i++) {
    pool[i] = drain()
  }
  await Promise.all(pool)
  return results
}

/**
 * A shared concurrency gate. `limit(fn)` runs `fn` once a slot is free and
 * resolves with its result. Unlike `runInPool` (a one-shot pool over a fixed
 * list), this is a long-lived limiter many independent callers funnel through —
 * used to cap TOTAL in-flight archive requests while accounts run in parallel.
 */
function createLimiter(max) {
  // `max` may be a function, so the limit follows the Settings panel.
  const limit = typeof max === 'function' ? max : () => max
  let active = 0
  const queue = []

  function next() {
    if (active >= limit() || queue.length === 0) return
    active++
    const { fn, resolve, reject } = queue.shift()
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--
        next()
      })
  }

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject })
      next()
    })
}

// --- Concurrency and pacing of requests to Jules ---
// Every POST to Jules (postBatchExecute) takes a slot of its account
// (Settings: parallel requests per account) and then one of the total. A
// request that goes out while others of its account are in flight or waiting
// first waits a random 0.5-2 s, plus up to the extra jitter when Settings
// turns it on, so a burst never reaches Jules in lockstep. A lone request
// goes straight out. GitHub calls don't go through here.
const globalLimit = createLimiter(() => settings.totalParallel)
const accountLimits = new Map() // accountNum -> limiter
const accountActive = new Map() // accountNum -> requests in flight or waiting

function accountKey(config) {
  return String(config?.accountNum ?? '0')
}

function accountLimit(config) {
  const key = accountKey(config)
  if (!accountLimits.has(key))
    accountLimits.set(
      key,
      createLimiter(() => settings.perAccountParallel)
    )
  return accountLimits.get(key)
}

function burstDelayMs() {
  const span = BURST_JITTER_MAX_MS - BURST_JITTER_MIN_MS
  const extra = settings.extraJitter ? Math.random() * settings.extraJitterMaxSec * 1000 : 0
  return Math.round(BURST_JITTER_MIN_MS + Math.random() * span + extra)
}

// --- Run up to N items (Settings) ---
// The whole run, across every account, acts on at most N items (dry runs
// and scheduled runs too); 0 means no limit. Reset when a run starts.
let runBudget = Number.POSITIVE_INFINITY

function takeRunBudget(label, items, noun) {
  if (items.length <= runBudget) {
    runBudget -= items.length
    return items
  }
  const kept = items.slice(0, Math.max(0, runBudget))
  runBudget = 0
  addLog(
    `[${label}] Settings: run up to ${settings.runLimit} item(s), so only ${kept.length} of ${items.length} ${noun}`
  )
  return kept
}

// =============================================================================
// batchexecute Client
// =============================================================================

let reqCounter = 100000

function buildBatchRequest(rpcId, payload, config) {
  const params = new URLSearchParams({
    rpcids: rpcId,
    bl: config.bl,
    'f.sid': config.fsid,
    _reqid: String(reqCounter++),
    rt: 'c'
  })

  const body = new URLSearchParams({
    'f.req': JSON.stringify([[[rpcId, JSON.stringify(payload), null, 'generic']]]),
    at: config.at
  })

  return {
    url: `${JULES_ORIGIN}/u/${config.accountNum}/_/Swebot/data/batchexecute?${params}`,
    body: body.toString()
  }
}

// The reply is read in full before this resolves, so postBatchExecute holds
// its parallel slots while a task list (up to 100+ MB) downloads.
function sendBatchExecute(rpcId, payload, config, timeout) {
  const { url, body } = buildBatchRequest(rpcId, payload, config)
  return jFetch(url, {
    buffer: true,
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'x-same-domain': '1'
    },
    credentials: 'include',
    body,
    ...(timeout ? { timeout } : {})
  })
}

// A pause or stop that lands while a request waits for its slot or its
// jitter sends it back to wait, so nothing goes out during a 429 pause.
const SEND_LATER = Symbol('send later')

async function postBatchExecute(rpcId, payload, config, timeout) {
  const key = accountKey(config)
  const burst = (accountActive.get(key) || 0) > 0
  accountActive.set(key, (accountActive.get(key) || 0) + 1)
  try {
    return await accountLimit(config)(async () => {
      for (;;) {
        await waitForAccount(config)
        const pausedUntil = accountPauses.get(key) || 0
        const res = await globalLimit(async () => {
          const ms = burst ? burstDelayMs() : 0
          if (ms > 0) await pause(ms)
          if (stoppedAccounts.has(key) || (accountPauses.get(key) || 0) !== pausedUntil) return SEND_LATER
          return sendBatchExecute(rpcId, payload, config, timeout)
        })
        if (res !== SEND_LATER) return res
      }
    })
  } finally {
    accountActive.set(key, accountActive.get(key) - 1)
  }
}

// The XSRF token (WIZ_global_data.SNlM0e) is frozen at page load, while the
// Jules page silently renews its own. A tab left open for hours therefore
// hands us an expired `at`, and every batchexecute call answers HTTP 400.
// Jules puts a replacement in the 400 body as ["xsrf","<token>"]; when it
// doesn't, a read-only KQOO7 call sent WITHOUT `at` returns one.
const XSRF_TOKEN_REGEX = /"xsrf","([^"]+)"/

async function readXsrfToken(err) {
  try {
    const text = await err?.response?.text()
    return XSRF_TOKEN_REGEX.exec(text || '')?.[1] || null
  } catch {
    return null
  }
}

async function mintXsrfToken(config) {
  try {
    // Rate-limited like any request: a 429 here pauses the account too.
    await postRateLimited(rpc('GetTaskUsage'), [], { ...config, at: '' })
    return null
  } catch (e) {
    return e.status === 400 ? readXsrfToken(e) : null
  }
}

function accountLabel(config) {
  const num = String(config?.accountNum ?? '0')
  return num !== '0' ? `u/${num}` : 'default'
}

// --- HTTP 429: pause the whole account ---
// Jules answers 429 when an account sends too much. Every request of that
// account then waits out Retry-After (30 s when Jules doesn't say) before it
// goes; a wait longer than 5 minutes stops the account for this run.
const RATE_LIMIT_DEFAULT_MS = 30 * 1000
const RATE_LIMIT_MAX_WAIT_MS = 5 * 60 * 1000
const RATE_LIMIT_RETRIES = 3
const accountPauses = new Map() // accountNum -> when its pause ends (ms)
const stoppedAccounts = new Map() // accountNum -> why it stopped
// accountNum -> 429s in a row, across all of the account's requests; a
// request that gets through resets it.
const accountRateLimits = new Map()

function pause(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function retryAfterMs(err) {
  const header = err?.response?.headers?.get?.('retry-after')
  if (!header) return RATE_LIMIT_DEFAULT_MS
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : RATE_LIMIT_DEFAULT_MS
}

// Waits out the account's pause, again if it was extended meanwhile; throws
// once the account is stopped for the run.
async function waitForAccount(config) {
  const key = accountKey(config)
  let waitedFor = 0
  for (;;) {
    const stopped = stoppedAccounts.get(key)
    if (stopped) throw new Error(stopped)
    const until = accountPauses.get(key) || 0
    if (until <= Date.now() || until === waitedFor) return
    waitedFor = until
    await pause(until - Date.now())
  }
}

function pauseAccount(config, ms) {
  const until = Date.now() + ms
  if (until <= (accountPauses.get(accountKey(config)) || 0)) return // already paused at least this long
  accountPauses.set(accountKey(config), until)
  addLog(
    `[${accountLabel(config)}] Jules is rate-limiting this account (HTTP 429): pausing its requests for ${Math.ceil(ms / 1000)} s`
  )
}

async function postRateLimited(rpcId, payload, config, timeout) {
  const key = accountKey(config)
  for (;;) {
    try {
      const res = await postBatchExecute(rpcId, payload, config, timeout)
      accountRateLimits.delete(key)
      return res
    } catch (e) {
      if (e.status !== 429) throw e
      const wait = retryAfterMs(e)
      const inARow = (accountRateLimits.get(key) || 0) + 1
      accountRateLimits.set(key, inARow)
      if (inARow > RATE_LIMIT_RETRIES || wait > RATE_LIMIT_MAX_WAIT_MS) {
        const why = `Jules rate-limited ${accountLabel(config)} (asked to wait ${Math.ceil(wait / 1000)} s); stopped this account for the run`
        stoppedAccounts.set(accountKey(config), why)
        throw new Error(why)
      }
      pauseAccount(config, wait)
    }
  }
}

// --- Sign-in tokens ---
// A stale token answers HTTP 400 (401/403 when signed out). The steps run in
// order, each only when the one before didn't bring new tokens, and the
// request is sent again after any step that did:
//   1. the fresh XSRF token Jules puts in the 400 body
//   2. a token minted by a read-only call sent without one
//   3. WIZ_global_data read again, past the content script's 5-minute cache
//   4. the Jules tab reloaded (Settings, on by default), then read again
// After the last one the account stops with a hint to sign in. The steps are
// shared by every request of the run's config, so parallel requests don't
// each reload the tab.
const SIGN_IN_STATUSES = new Set([400, 401, 403])
const SIGN_IN_STEPS = [
  { name: 'the token in the 400 reply', run: async (_config, err) => ({ at: await readXsrfToken(err) }) },
  {
    name: 'a newly minted token',
    run: async (config, err) => (err.status === 400 ? { at: await mintXsrfToken(config) } : null)
  },
  { name: "the tab's current tokens", run: (config) => readPageTokens(config) },
  {
    name: 'reloading the Jules tab',
    run: async (config) => {
      if (!settings.reloadTabOnSignIn || config.tabId === undefined) return null
      if (!(await tabOnAccount(config))) {
        addLog(`[${accountLabel(config)}] Not reloading: the tab is no longer on Jules for ${accountLabel(config)}`)
        return null
      }
      await reloadJulesTab(config.tabId)
      return readPageTokens(config)
    }
  }
]

// Copies new tokens into the run's config, so every later call uses them.
// Returns whether anything changed.
function setTokens(config, fresh) {
  if (!fresh?.at) return false
  const changed =
    fresh.at !== config.at || (fresh.bl && fresh.bl !== config.bl) || (fresh.fsid && fresh.fsid !== config.fsid)
  config.at = fresh.at
  if (fresh.bl) config.bl = fresh.bl
  if (fresh.fsid) config.fsid = fresh.fsid
  return Boolean(changed)
}

// A tab switched to another account mid-run holds that account's tokens,
// which must not be sent for this one.
async function readPageTokens(config) {
  if (config.tabId === undefined) return null
  try {
    const fresh = await getTabConfig(config.tabId, { fresh: true })
    return fresh.accountNum === String(config.accountNum ?? '0') ? fresh : null
  } catch {
    return null
  }
}

// The tab may have left Jules, or moved to another account, since the run
// started; a reload then would throw away whatever the user has open there.
async function tabOnAccount(config) {
  try {
    const { url } = await chrome.tabs.get(config.tabId)
    return new URL(url).origin === JULES_ORIGIN && extractAccountNum(url) === accountKey(config)
  } catch {
    return false
  }
}

// Reloads the tab and waits (up to 30 s) for it to finish loading.
async function reloadJulesTab(tabId) {
  await new Promise((resolve) => {
    const timer = setTimeout(done, 30 * 1000)
    function done() {
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') done()
    }
    chrome.tabs.onUpdated.addListener(listener)
    chrome.tabs.reload(tabId).catch(done)
  })
}

async function renewSignIn(config, err) {
  const label = accountLabel(config)
  while ((config.signInStep || 0) < SIGN_IN_STEPS.length) {
    const step = SIGN_IN_STEPS[config.signInStep || 0]
    config.signInStep = (config.signInStep || 0) + 1
    addLog(`[${label}] Sign-in tokens rejected (HTTP ${err.status}): trying ${step.name}`)
    if (setTokens(config, await step.run(config, err))) return true
  }
  return false
}

async function postWithSignIn(rpcId, payload, config, timeout) {
  for (;;) {
    const used = config.at
    try {
      const res = await postRateLimited(rpcId, payload, config, timeout)
      config.signInStep = 0 // these tokens work; a later expiry starts over
      return res
    } catch (e) {
      if (!SIGN_IN_STATUSES.has(e.status)) throw e
      if (config.at !== used) continue // another request already renewed them
      if (!config.signInPromise) {
        config.signInPromise = renewSignIn(config, e).finally(() => {
          config.signInPromise = null
        })
      }
      if (!(await config.signInPromise) && config.at === used) {
        // The rest of the run's requests for this account would fail the same way.
        const why = `HTTP ${e.status}: Jules rejected the sign-in for ${accountLabel(config)}. Open that Jules tab, check you're signed in, and run again.`
        stoppedAccounts.set(accountKey(config), why)
        throw new Error(why)
      }
    }
  }
}

async function callBatchExecute(rpcId, payload, config, { timeout } = {}) {
  try {
    const res = await postWithSignIn(rpcId, payload, config, timeout)
    return parseResponse(await res.text(), rpcId)
  } catch (e) {
    throw new Error(`batchexecute ${rpcId} failed: ${e.message}`)
  }
}

// =============================================================================
// Response Parser
// =============================================================================

/**
 * Find the end of the outermost JSON array using bracket balancing.
 * Handles control chars inside strings by skipping them.
 *
 * `startPos` lets callers scan a slice of a larger string without first
 * allocating a substring copy — important for multi-MB batchexecute payloads.
 * The returned index is absolute (relative to the start of `str`).
 */
function findJsonEnd(str, startPos = 0) {
  if (!str) return -1
  // ⚡ Bolt Optimization: Use String.prototype.indexOf('"') to fast-forward
  // through string literals instead of character-by-character iteration.
  // This avoids huge JS overhead for large string payloads.
  let depth = 0
  const len = str.length
  for (let i = startPos; i < len; i++) {
    const code = str.charCodeAt(i)
    if (code === 34) {
      // '"'
      while (true) {
        i = str.indexOf('"', i + 1)
        if (i === -1) return -1
        let count = 0
        while (i - 1 - count >= 0 && str.charCodeAt(i - 1 - count) === 92) {
          count++
        }
        if (count % 2 === 0) break
      }
    } else if (code === 91 || code === 123) {
      // '[', '{'
      depth++
    } else if (code === 93 || code === 125) {
      // ']', '}'
      depth--
      if (depth === 0) return i + 1
    }
  }

  return -1
}

function parseResponse(text, rpcId) {
  // Strip XSS protection prefix: )]}'
  let pos = 0
  if (text.startsWith(")]}'")) {
    pos = 4
  }
  // Skip leading whitespace
  while (pos < text.length) {
    const code = text.charCodeAt(pos)
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
      pos++
    } else {
      break
    }
  }

  // Skip byte-length line
  const firstNewline = text.indexOf('\n', pos)
  if (firstNewline === -1) throw new Error('Invalid batchexecute response')
  const dataStart = firstNewline + 1

  // ⚡ Bolt Optimization: Scan for the JSON boundary directly in `text` using an
  // offset instead of allocating a `data` substring copy of the whole payload.
  const jsonEnd = findJsonEnd(text, dataStart)
  if (jsonEnd === -1) throw new Error('Could not find JSON boundary in response')

  const jsonStr = text.substring(dataStart, jsonEnd)
  const fixed = fixJsonControlChars(jsonStr)
  const outer = JSON.parse(fixed)
  if (!Array.isArray(outer)) throw new Error('Invalid batchexecute response: expected array')

  // Find the entry matching our rpcId
  // ⚡ Bolt Optimization: Replace `for...of` loop over outer with a standard `for` loop to avoid
  // iterator allocation and closure overhead in this hot path parsing large response arrays.
  for (let i = 0; i < outer.length; i++) {
    const entry = outer[i]
    if (!Array.isArray(entry) || entry[1] !== rpcId) continue
    if (entry[5] && Array.isArray(entry[5])) {
      throw new Error(`RPC ${rpcId} error code [${entry[5].join(', ')}]`)
    }
    if (typeof entry[2] !== 'string') return null
    const innerFixed = fixJsonControlChars(entry[2])
    const inner = JSON.parse(innerFixed)
    if (!Array.isArray(inner)) return null
    return inner
  }

  return null
}

// =============================================================================
// Task Operations
// =============================================================================

// Task field indices (from reverse-engineered response)
const TASK = {
  ID: 0,
  SHORT_TITLE: 1,
  PROMPT: 2,
  SOURCE: 4,
  STATE: 5,
  CREATE_TIME: 6,
  UPDATE_TIME: 7,
  PLAN: 10,
  AWAITING_REVIEW: 12,
  STATUS_CODE: 25,
  DISPLAY_TITLE: 26
}

// Source (connected repo) row layout from YqkSHd.
// [5] is a per-repo Suggestions block: [bool, bool, [TOGGLE], [bool]] where
// TOGGLE === 2 means the repo's Suggestions toggle is ON, 1/absent means OFF.
// This mirrors the e4motb write RPC (payload [2]=enable, [1]=disable) and was
// verified 2026-06-04 against Jules' own "X / 5 repo max" counter (UTrvy) across
// all 5 accounts: the enabled-repo count matched UTrvy exactly every time.
const SOURCE = {
  ID: 0,
  // 1 = connected, 2 = disconnected (no longer shown in Jules' repo list).
  STATUS: 4,
  SUGGESTION_BLOCK: 5
}
const SOURCE_DISCONNECTED = 2
const SUGGESTION_TOGGLE_ON = 2

// A Jules account may enable Suggestions on at most 5 repos. The extension must
// only start suggestions on those, never on every connected source.
function isSuggestionEnabled(row) {
  const block = row?.[SOURCE.SUGGESTION_BLOCK]
  return Array.isArray(block) && Array.isArray(block[2]) && block[2][0] === SUGGESTION_TOGGLE_ON
}

// Jules titles a task or schedule without a title by its prompt's first line.
// One match, not a split: a prompt can be 12 KB, on thousands of tasks.
function firstLine(text) {
  return (
    String(text || '')
      .match(/\S[^\r\n]*/)?.[0]
      .trim()
      .slice(0, 120) || ''
  )
}

function parseTask(raw) {
  const source = raw[TASK.SOURCE] || ''

  // ⚡ Bolt Optimization: Use indexOf and substring instead of .split('/') to extract
  // owner and repoName. This prevents allocating string arrays for every task,
  // reducing GC pressure when parsing payloads with thousands of tasks.
  let owner = ''
  let repoName = ''
  const isGithub = source.startsWith('github/')

  if (isGithub) {
    const firstSlash = 6 // index of slash in 'github/'
    const secondSlash = source.indexOf('/', firstSlash + 1)
    if (secondSlash !== -1) {
      owner = source.substring(firstSlash + 1, secondSlash)
      const thirdSlash = source.indexOf('/', secondSlash + 1)
      repoName = thirdSlash !== -1 ? source.substring(secondSlash + 1, thirdSlash) : source.substring(secondSlash + 1)
    }
  } else {
    // Fallback for non-github sources if they ever occur
    const parts = source.split('/')
    owner = parts[1] || ''
    repoName = parts[2] || ''
  }

  return {
    id: raw[TASK.ID],
    title: raw[TASK.DISPLAY_TITLE] || raw[TASK.SHORT_TITLE] || firstLine(raw[TASK.PROMPT]) || '(untitled)',
    source,
    state: raw[TASK.STATE],
    // Jules shows a Completed task with this flag as "Ready for review".
    awaitingReview: raw[TASK.AWAITING_REVIEW] === true,
    statusCode: raw[TASK.STATUS_CODE],
    planId: raw[TASK.PLAN]?.[0] || null,
    repo: isGithub ? source.slice(7) : source,
    owner,
    repoName
  }
}

// ⚡ Bolt Optimization: Use a standard for loop instead of for...of, and replace
// double Map lookup (.has() + .get()) with a single .get() + undefined check.
// This reduces hashing and lookups in the hot path.
function groupTasksByRepo(tasks) {
  const map = new Map()
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]
    const key = t.repo || '(no repo)'
    let arr = map.get(key)
    if (arr === undefined) {
      arr = []
      map.set(key, arr)
    }
    arr.push(t)
  }
  return map
}

// ListTasks returns every task with its full prompt in one response — 121 MB
// and ~85 s for a 7,355-task account (measured 2026-10-19). The 30 s request
// timeout would abort it before the headers even arrive, so it gets its own
// (settings.listTimeoutSec, 300 s by default).
async function listTasks(filter, config) {
  const payload = [filter, 4]
  const result = await callBatchExecute(rpc('ListTasks'), payload, config, { timeout: settings.listTimeoutSec * 1000 })
  if (!result?.[0]) return []

  const arr = result[0]
  const len = arr.length
  const tasks = new Array(len)
  for (let i = 0; i < len; i++) {
    tasks[i] = parseTask(arr[i])
  }
  return tasks
}

async function safeListTasks(label, config) {
  try {
    const tasks = await listTasks('', config)
    if (tasks.length === 0) {
      addLog(`[${label}] No tasks found.`)
      return null
    }
    return tasks
  } catch (e) {
    addLog(`[${label}] ERROR listing tasks: ${e.message}`)
    return null
  }
}

async function archiveTasks(taskIds, config, unarchive = false) {
  const payload = new Array(2).fill(null)
  payload[TJMM5C.TASK_IDS] = taskIds
  payload[TJMM5C.ACTION] = 1
  await callBatchExecute(rpc('ArchiveTasks'), unarchive ? [taskIds] : payload, config)
}

const RETRY_ATTEMPTS = 4
const RETRY_BASE_MS = 400

// A transient 5xx or network failure is retried with backoff rather than
// dropping the task. HTTP 429 is handled by postRateLimited, which pauses the
// whole account for as long as Jules asks.
function isRetryable(message) {
  return /HTTP 5\d\d|Failed to fetch|NetworkError/i.test(message || '')
}

async function withRetry(fn) {
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (attempt === RETRY_ATTEMPTS - 1 || !isRetryable(e.message)) throw e
      const delay = RETRY_BASE_MS * 2 ** attempt + Math.random() * 200
      await new Promise((r) => setTimeout(r, delay))
    }
  }
}

function archiveTasksWithRetry(taskIds, config, unarchive = false) {
  return withRetry(() => archiveTasks(taskIds, config, unarchive))
}

// Dismiss a single suggestion via sc1vFf (DismissSuggestion)
const SC1VFF = {
  SUGGESTION_ID: 0,
  ACTION: 1
}
const SC1VFF_ACTION_DISMISS = 2

async function dismissSuggestion(suggestionId, config) {
  const payload = new Array(2).fill(null)
  payload[SC1VFF.SUGGESTION_ID] = suggestionId
  payload[SC1VFF.ACTION] = SC1VFF_ACTION_DISMISS
  await callBatchExecute(rpc('UpdateProactiveSuggestionStatus'), payload, config)
}

function dismissSuggestionWithRetry(suggestionId, config) {
  return withRetry(() => dismissSuggestion(suggestionId, config))
}

// =============================================================================
// Suggestion Operations
// =============================================================================

const SUGGESTION = {
  ID: 0,
  DETAILS: 1,
  STATUS: 2,
  RELATED: 3,
  CATEGORY_TAB: 4
}

const SDETAIL = {
  TITLE: 0,
  DESCRIPTION: 1,
  GITHUB_URL: 2,
  FILE_PATH: 3,
  LINE: 4,
  CONFIDENCE: 5,
  RATIONALE: 6,
  CODE_SNIPPET: 7,
  LANGUAGE: 8,
  CATEGORY_SLUG: 9,
  PRIORITY: 10
}

// Start Suggestion payload layout (Rja83d)
const RJA83D = {
  PROMPT: 0,
  MODEL_CONFIG: 2,
  REPO: 4,
  METADATA: 9,
  START_FLAG: 14
}

// Model Config array layout (used in Rja83d payload [2])
const MCONFIG = {
  MODEL_ID: 1,
  FEATURE_FLAGS: 10
}

// Suggestion Metadata array layout (used in Rja83d payload [9])
const SMETA = {
  EXPERIMENT_IDS: 4,
  SUGGESTION_ID_WRAPPER: 11,
  STATUS_FLAGS: 5
}

// Archive Task payload layout (Tjmm5c)
const TJMM5C = {
  TASK_IDS: 0,
  ACTION: 1
}

function parseSuggestion(raw) {
  if (!raw || !Array.isArray(raw)) return null
  const d = raw[SUGGESTION.DETAILS]
  if (!d) return null
  return {
    id: raw[SUGGESTION.ID],
    title: d[SDETAIL.TITLE],
    description: d[SDETAIL.DESCRIPTION],
    githubUrl: d[SDETAIL.GITHUB_URL],
    filePath: d[SDETAIL.FILE_PATH],
    line: d[SDETAIL.LINE],
    confidence: d[SDETAIL.CONFIDENCE],
    rationale: d[SDETAIL.RATIONALE],
    codeSnippet: d[SDETAIL.CODE_SNIPPET],
    language: d[SDETAIL.LANGUAGE],
    categorySlug: d[SDETAIL.CATEGORY_SLUG],
    priority: d[SDETAIL.PRIORITY],
    status: raw[SUGGESTION.STATUS],
    categoryTab: raw[SUGGESTION.CATEGORY_TAB]
  }
}

async function listSuggestions(repo, config) {
  const result = await callBatchExecute(rpc('ListProactiveSuggestions'), [repo], config)
  if (!result || !Array.isArray(result) || !Array.isArray(result[0])) return []

  // ⚡ Bolt Optimization: Use a standard for loop instead of `.reduce()` to
  // avoid function call overhead per element and intermediate closure allocation.
  const arr = result[0]
  const parsedSuggestions = []
  for (let i = 0; i < arr.length; i++) {
    const parsed = parseSuggestion(arr[i])
    if (parsed) parsedSuggestions.push(parsed)
  }
  return parsedSuggestions
}

// List the repos that have the Jules Suggestions toggle ENABLED for this account.
// Response shape (YqkSHd): result[0] is an array of source rows whose [0] is the
// "github/owner/repo" id and whose [5] block encodes the per-repo toggle.
// Returning every connected source (not just enabled ones) is what caused the
// extension to start hundreds of unwanted suggestion tasks across all repos.
async function listSuggestionEnabledSources(config) {
  const result = await callBatchExecute(rpc('ListSources'), [null, 'source_status=SOURCE_STATUS_ACTIVE'], config)
  if (!result?.[0]) return []

  // ⚡ Bolt Optimization: Replace `.filter().map()` chain with a single
  // standard for loop to avoid intermediate array allocations.
  const arr = result[0]
  const sources = []
  for (let i = 0; i < arr.length; i++) {
    const row = arr[i]
    if (isSuggestionEnabled(row) && typeof row?.[SOURCE.ID] === 'string' && row[SOURCE.ID].startsWith('github/')) {
      sources.push(row[SOURCE.ID])
    }
  }
  return sources
}

// Every connected GitHub source, regardless of the Suggestions toggle. Only for
// read-only work (export, repo picker) or an explicit user-chosen repo — never
// for bulk session starts across "all" repos.
async function listAllSources(config) {
  const result = await callBatchExecute(rpc('ListSources'), [null, 'source_status=SOURCE_STATUS_ACTIVE'], config)
  if (!result?.[0]) return []
  const arr = result[0]
  const sources = []
  for (let i = 0; i < arr.length; i++) {
    const row = arr[i]
    if (typeof row?.[SOURCE.ID] === 'string' && row[SOURCE.ID].startsWith('github/')) {
      sources.push(row[SOURCE.ID])
    }
  }
  return sources
}

// Every GitHub source the account ever had, the connected ones first: a
// disconnected repo keeps its tasks. Read-only work only.
async function listEverySource(config) {
  const rows = (await callBatchExecute(rpc('ListSources'), [null, null], config))?.[0] || []
  const github = rows.filter((row) => typeof row?.[SOURCE.ID] === 'string' && row[SOURCE.ID].startsWith('github/'))
  const disconnected = (row) => row[SOURCE.STATUS] === SOURCE_DISCONNECTED
  return [...github.filter((row) => !disconnected(row)), ...github.filter(disconnected)].map((row) => row[SOURCE.ID])
}

async function safeListSources(label, config, allowAll = false) {
  try {
    const repos = allowAll ? await listAllSources(config) : await listSuggestionEnabledSources(config)
    if (repos.length === 0) {
      addLog(
        allowAll
          ? `[${label}] No connected repos found. Nothing to do.`
          : `[${label}] No repos have Suggestions enabled. Nothing to do.`
      )
      return null
    }
    return repos
  } catch (e) {
    addLog(`[${label}] ERROR listing sources: ${e.message}`)
    return null
  }
}

// Jules caps suggestion sessions per account per day. KQOO7 returns
// [usedToday, [windowSeconds], dailyLimit, ...]; the extension must not start
// more sessions than the remaining quota, or it blows past the limit (observed
// 268/100). Returns null if the shape is unrecognised so callers can no-op the
// guard rather than block the run.
async function getDailySessionQuota(config) {
  const result = await callBatchExecute(rpc('GetTaskUsage'), [], config)
  if (!Array.isArray(result) || typeof result[0] !== 'number' || typeof result[2] !== 'number') return null
  return { used: result[0], limit: result[2], remaining: Math.max(0, result[2] - result[0]) }
}

// =============================================================================
// Repository Filter
// =============================================================================

// The popup sends repoFilter as "owner/repo" (dropdown or typed); '' means all
// repos. Sources are "github/owner/repo" ids, tasks carry both forms. Matching
// is exact (case-insensitive): a substring match would let "owner/plate" also
// archive or dismiss in "owner/plate-docs". A bare name matches the repo segment.
function normalizeRepoId(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/^github\//, '')
}

function matchesRepoFilter(repoFilter, ...candidates) {
  const wanted = normalizeRepoId(repoFilter)
  const bareName = !wanted.includes('/')
  for (const c of candidates) {
    if (!c) continue
    const repo = normalizeRepoId(c)
    if (bareName ? repo.slice(repo.lastIndexOf('/') + 1) === wanted : repo === wanted) return true
  }
  return false
}

// Returns the repos matching options.repoFilter, or null (after logging) when
// nothing matches. No filter -> the input list unchanged.
function filterReposByRepoFilter(label, repos, repoFilter) {
  if (!repoFilter) return repos
  const filtered = repos.filter((r) => matchesRepoFilter(repoFilter, r))
  addLog(
    `[${label}] Filtered repos by "${repoFilter}": keeping ${filtered.length} repo(s): ${filtered.map((r) => r.replace(/^github\//, '')).join(', ')}`
  )
  if (filtered.length === 0) {
    addLog(`[${label}] No matching repos found. Nothing to do.`)
    return null
  }
  return filtered
}

// =============================================================================
// Prompt Builder
// =============================================================================

function createRoleConfig(icon, name, role, codeLabel) {
  return { icon, name, role, codeLabel }
}

const SECURITY_CONFIG = createRoleConfig(
  '[SECURITY]',
  'Security Vulnerability Fix',
  'security-focused',
  'Vulnerable Code'
)
const PERFORMANCE_CONFIG = createRoleConfig(
  '[PERF]',
  'Performance Optimization',
  'performance-focused',
  'Inefficient Code'
)
const CLEANUP_CONFIG = createRoleConfig('[CLEANUP]', 'Code Cleanup', 'code-quality-focused', 'Code to Clean')
const TESTING_CONFIG = createRoleConfig('[TEST]', 'Test Coverage', 'testing-focused', 'Untested Code')

const CATEGORY_CONFIG = {
  'input-validation': SECURITY_CONFIG,
  'insecure-config': SECURITY_CONFIG,
  injection: SECURITY_CONFIG,
  'async-io': PERFORMANCE_CONFIG,
  'loop-optimization': PERFORMANCE_CONFIG,
  'data-structure': PERFORMANCE_CONFIG,
  'dead-code': CLEANUP_CONFIG,
  other: CLEANUP_CONFIG,
  'untested-function': TESTING_CONFIG,
  'missing-error-test': TESTING_CONFIG,
  'missing-edge-case': TESTING_CONFIG,
  'missing-test-file': TESTING_CONFIG
}

const DEFAULT_CATEGORY = createRoleConfig('[FIX]', 'Code Improvement', 'engineering-focused', 'Code')

function buildSuggestionPrompt(suggestion) {
  const cat = CATEGORY_CONFIG[suggestion.categorySlug] || DEFAULT_CATEGORY

  return `# ${cat.icon} ${cat.name} Task

You are a ${cat.role} agent. Your mission is to analyze and fix the following issue.

## Task Details

**File:** \`${suggestion.filePath}:${suggestion.line}\`
**Issue:** ${suggestion.title}

**Language:** ${suggestion.language}

**${cat.codeLabel}:**
\`\`\`${suggestion.language}
${suggestion.codeSnippet}
\`\`\`

**Rationale:** ${suggestion.rationale}

## Your Process

### 1. UNDERSTAND - Analyze the Issue
* Review the surrounding code and understand the context
* Identify the specific problem and its potential impact

### 2. IMPLEMENT - Fix the Issue
* Write a fix that addresses the root cause
* Follow best practices for this type of issue
* Ensure the fix doesn't introduce new problems
* Preserve existing functionality

### 3. VERIFY - Validate the Fix
- Run format and lint checks
- Run the full test suite
- Ensure no functionality is broken
- For non-trivial fixes, write simple tests that validate your fix

### 4. DOCUMENT - Create a PR
Create a PR with:
- Title: "${cat.icon} ${suggestion.title}"
- Description explaining what was fixed and why
`
}

// =============================================================================
// StartSuggestion RPC
// =============================================================================

const DEFAULT_FEATURE_FLAGS = [
  ['enable_bash_session_tool', 1],
  ['enable_thinking', 1],
  ['use_gemini_api', 1],
  ['use_simple_agent_context', 1],
  ['enable_memory', 1],
  ['enable_jules_cheatsheet', 1],
  ['enable_messages_every_turn', 1]
]

function buildModelConfig(modelId, featureFlags) {
  const config = new Array(11).fill(null)
  config[MCONFIG.MODEL_ID] = modelId
  config[MCONFIG.FEATURE_FLAGS] = featureFlags
  // Schema defaults
  config[3] = []
  config[4] = 1
  config[9] = [360]
  return config
}

function buildSuggestionMetadata(suggestionId, experimentIds) {
  const meta = new Array(12).fill(null)
  meta[0] = 9
  meta[SMETA.EXPERIMENT_IDS] = experimentIds
  meta[SMETA.STATUS_FLAGS] = [null, [1, 1]]
  meta[SMETA.SUGGESTION_ID_WRAPPER] = [null, suggestionId]
  return meta
}

// "Add a message" on Suggestions goes at the end of every prompt.
// The user's message goes after whatever text the extension sends (a
// suggestion prompt, the default reply or retry), never in place of it.
function appendMessage(prompt, message) {
  return message ? `${prompt.trimEnd()}\n\n## Additional instructions\n\n${message}\n` : prompt
}

function buildStartPayload(suggestion, repo, config, startConfig, message) {
  const prompt = appendMessage(buildSuggestionPrompt(suggestion), message)
  return buildRja83dPayload(prompt, suggestion.id, repo, config, startConfig)
}

function buildRja83dPayload(prompt, suggestionId, repo, config, startConfig) {
  const modelId = config.modelId || startConfig?.modelConfig?.[1] || null
  const featureFlags = startConfig?.featureFlags || DEFAULT_FEATURE_FLAGS
  const experimentIds = startConfig?.experimentIds || []

  const payload = new Array(15).fill(null)
  payload[RJA83D.PROMPT] = prompt
  payload[RJA83D.MODEL_CONFIG] = buildModelConfig(modelId, featureFlags)
  payload[RJA83D.REPO] = repo
  payload[RJA83D.METADATA] = buildSuggestionMetadata(suggestionId, experimentIds)
  payload[RJA83D.START_FLAG] = 1
  return payload
}

async function startSuggestion(suggestion, repo, config, startConfig, message) {
  const payload = buildStartPayload(suggestion, repo, config, startConfig, message)
  return callBatchExecute(rpc('CreateTask'), payload, config)
}

async function getStartConfig() {
  const { startConfig } = await chrome.storage.session.get('startConfig')
  return startConfig || null
}

// =============================================================================
// Suggestions Orchestrator
// =============================================================================

async function processSuggestionsForTab(tab, options) {
  const prepared = await prepareTab(tab)
  if (!prepared) return 0
  const { label, config } = prepared
  if (options._remainingStarts <= 0) {
    addLog(`[${label}] Skipped: scheduled tick's suggestion cap already spent`)
    return 0
  }

  const startConfig = await getStartConfig()
  if (!startConfig) {
    addLog(`[${label}] No StartSuggestion config cached. Using defaults.`)
    addLog(`[${label}] Tip: Click Start on any suggestion in Jules UI to capture config.`)
  }

  // ⚡ Bolt Optimization: Fetch quota before network discovery. If the limit is
  // already reached, short-circuit to avoid O(N) wasteful batchexecute API calls.
  let quota = null
  try {
    quota = await getDailySessionQuota(config)
    if (quota) {
      addLog(`[${label}] Daily sessions: ${quota.used}/${quota.limit} used, ${quota.remaining} remaining`)
      if (quota.remaining === 0) {
        addLog(`[${label}] Daily limit reached. Skipping suggestion discovery.`)
        return 0
      }
    }
  } catch (e) {
    addLog(`[${label}] WARNING: Could not fetch daily quota: ${e.message}`)
  }

  // Only repos whose Jules Suggestions toggle is ON. Enumerating every connected
  // source instead caused the extension to start suggestions on repos the user
  // never enabled (and blow past the daily session limit).
  addLog(`[${label}] Fetching Suggestions-enabled repos...`)
  const repos = await safeListSources(label, config)
  if (!repos) return 0

  addLog(
    `[${label}] ${repos.length} repo(s) with Suggestions enabled: ${repos.map((r) => r.replace(/^github\//, '')).join(', ')}`
  )

  const targetRepos = filterReposByRepoFilter(label, repos, options.repoFilter)
  if (!targetRepos) return 0

  addLog(`\n[${label}] Fetching suggestions for ${targetRepos.length} repos concurrently...`)
  let totalDiscovered = 0
  const allSuggestions = await runInPool(targetRepos, settings.perAccountParallel, (repo) => {
    // ⚡ Bolt Optimization: Short-circuit network discovery if we've already
    // found enough suggestions to satisfy the daily quota limit. This prevents
    // dozens of wasteful `listSuggestions` batchexecute API calls.
    if (quota && totalDiscovered >= quota.remaining) {
      return Promise.resolve({ repo, suggestions: [], skipped: true })
    }
    return listSuggestions(repo, config)
      .then((suggestions) => {
        totalDiscovered += suggestions.length
        return { repo, suggestions }
      })
      .catch((e) => ({ repo, error: e.message }))
  })

  // Flatten (repo, suggestion) pairs across all repos so the pool stays
  // saturated instead of draining one repo at a time.
  const work = []
  const discoveryLogs = []
  let skippedCount = 0
  for (const { repo, suggestions, error, skipped } of allSuggestions) {
    if (skipped) {
      skippedCount++
      continue
    }
    if (error) {
      discoveryLogs.push(`\n[${label}] ERROR fetching suggestions for ${repo}: ${error}`)
      continue
    }
    if (suggestions.length === 0) {
      discoveryLogs.push(`\n[${label}] ${repo}: No suggestions found`)
      continue
    }
    discoveryLogs.push(`\n[${label}] ${repo}: Found ${suggestions.length} suggestions`)
    for (const s of suggestions) work.push({ repo, s })
  }
  if (skippedCount > 0) {
    discoveryLogs.push(`\n[${label}] Skipped discovering suggestions for ${skippedCount} repo(s) (quota met)`)
  }
  if (discoveryLogs.length > 0) addLog(discoveryLogs.join(''))

  if (work.length === 0) {
    addLog(`\n[${label}] TOTAL: 0 suggestions started`)
    return 0
  }

  // Respect Jules' daily session limit: never start more suggestions than the
  // account's remaining quota. Each started suggestion consumes one session.
  // Scheduled runs may also cap suggestion-starts across the whole tick
  // (options._remainingStarts). Take the tighter of the two limits; decrement
  // the shared budget per item taken so parallel accounts cannot overspend.
  let toStart = work
  if (quota && toStart.length > quota.remaining) {
    addLog(`[${label}] Capping ${toStart.length} suggestions to ${quota.remaining} (daily limit)`)
    toStart = toStart.slice(0, quota.remaining)
  }
  if (options._remainingStarts !== undefined && toStart.length > options._remainingStarts) {
    addLog(`[${label}] Capping ${toStart.length} suggestions to ${options._remainingStarts} (per-tick cap)`)
    toStart = toStart.slice(0, Math.max(0, options._remainingStarts))
  }
  toStart = takeRunBudget(label, toStart, 'suggestion(s) to start')
  if (options._remainingStarts !== undefined) {
    options._remainingStarts -= toStart.length
  }

  if (!options.dryRun) {
    state.progress.total += toStart.length
    updateState({})
  }

  let totalStarted = 0
  let lastUpdate = 0
  await runInPool(toStart, settings.perAccountParallel, async ({ repo, s }) => {
    if (state.status === 'cancelled') return

    if (options.dryRun) {
      addLog(`  [DRY] Would start [${label}] ${s.title} (${s.categorySlug})`)
      return
    }

    const now = Date.now()
    if (now - lastUpdate > 500) {
      updateState({ currentRepo: repo.replace(/^github\//, '') })
      lastUpdate = now
    }
    try {
      await startSuggestion(s, repo, config, startConfig, options.message)
      totalStarted++
      state.progress.archived += 1
      if (Date.now() - lastUpdate > 500) {
        updateState({})
        lastUpdate = Date.now()
      }
      addLog(`  Started [${label}] ${s.title}`)
    } catch (err) {
      addLog(`  [!] Failed to start "${s.title}": ${err.message}`)
    }
  })

  addLog(`\n[${label}] TOTAL: ${totalStarted} suggestions started`)
  return totalStarted
}

// =============================================================================
// Remove Suggestions Orchestrator
// =============================================================================

async function processRemoveSuggestionsForTab(tab, options) {
  const prepared = await prepareTab(tab)
  if (!prepared) return 0
  const { label, config } = prepared

  addLog(`[${label}] Fetching Suggestions-enabled repos...`)
  const repos = await safeListSources(label, config)
  if (!repos) return 0

  addLog(
    `[${label}] ${repos.length} repo(s) with Suggestions enabled: ${repos.map((r) => r.replace(/^github\//, '')).join(', ')}`
  )

  const targetRepos = filterReposByRepoFilter(label, repos, options.repoFilter)
  if (!targetRepos) return 0

  addLog(`\n[${label}] Fetching suggestions for ${targetRepos.length} repos concurrently...`)
  const allSuggestions = await runInPool(targetRepos, settings.perAccountParallel, (repo) =>
    listSuggestions(repo, config)
      .then((suggestions) => ({ repo, suggestions }))
      .catch((e) => ({ repo, error: e.message }))
  )

  const work = []
  const discoveryLogs = []
  for (const { repo, suggestions, error } of allSuggestions) {
    if (error) {
      discoveryLogs.push(`\n[${label}] ERROR fetching suggestions for ${repo}: ${error}`)
      continue
    }
    if (suggestions.length === 0) {
      discoveryLogs.push(`\n[${label}] ${repo}: No suggestions found`)
      continue
    }
    discoveryLogs.push(`\n[${label}] ${repo}: Found ${suggestions.length} suggestions`)
    for (const s of suggestions) work.push({ repo, s })
  }
  if (discoveryLogs.length > 0) addLog(discoveryLogs.join(''))

  if (work.length === 0) {
    addLog(`\n[${label}] TOTAL: 0 suggestions removed`)
    return 0
  }

  const toRemove = takeRunBudget(label, work, 'suggestion(s) to remove')
  if (options.dryRun) {
    addLog(`[${label}] DRY RUN - would remove ${toRemove.length} suggestions`)
    for (const { s } of toRemove) {
      addLog(`  [DRY] Would remove [${label}] ${s.title} (${s.categorySlug})`)
    }
    return 0
  }

  state.progress.total += toRemove.length
  updateState({})

  let totalRemoved = 0
  let lastUpdate = 0
  await runInPool(toRemove, settings.perAccountParallel, async ({ repo, s }) => {
    if (state.status === 'cancelled') return
    const now = Date.now()
    if (now - lastUpdate > 500) {
      updateState({ currentRepo: repo.replace(/^github\//, '') })
      lastUpdate = now
    }
    try {
      await dismissSuggestionWithRetry(s.id, config)
      totalRemoved++
      state.progress.archived++
      if (Date.now() - lastUpdate > 500) {
        updateState({})
        lastUpdate = Date.now()
      }
      addLog(`  Removed [${label}] ${s.title}`)
    } catch (err) {
      addLog(`  [!] Failed to remove suggestion "${s.title}": ${err.message}`)
    }
  })

  addLog(`\n[${label}] TOTAL: ${totalRemoved} suggestions removed`)
  return totalRemoved
}

// =============================================================================
// Proceed Orchestrator
// =============================================================================

// Interact (SLmX6) carries the client's experiment flags; these are the ones
// the Jules UI sent with its own replies on 2026-10-19.
const INTERACT_EXPERIMENT_IDS = [
  98286823, 105606311, 105629939, 105705437, 105631223, 105732819, 105732273, 105732245, 105754330, 105703357,
  105754824, 105739042, 105762189, 105800437
]

const PROCEED_VERBS = {
  reply: { dry: 'reply to', done: 'Replied to' },
  approve: { dry: 'approve the plan of', done: 'Approved the plan of' },
  resume: { dry: 'resume', done: 'Resumed' },
  retry: { dry: 'retry', done: 'Retried' },
  followUp: { dry: 'send a follow-up to', done: 'Sent a follow-up to' }
}

// Proceed works through tasks in this order, so whatever daily quota is left
// goes to the most useful work first.
const PROCEED_ORDER = { feedback: 0, plan: 1, paused: 2, running: 3, unknown: 3, error: 4, completed: 5 }

function taskKind(task) {
  return taskStateFor(task)?.kind || 'unknown'
}

// What Proceed does with one task: { action, message, usesQuota } or
// { skip: reason }. A retry or a follow-up starts a new run, so it counts
// against the daily session quota; replying to a live session does not
// (measured 2026-10-19 at 100/100: 13 replies went through, every retry got
// RPC error code [8]).
function planProceed(task, item, options = {}) {
  const message = normalizeMessage(options.message)
  const kind = taskKind(task)
  switch (kind) {
    case 'feedback':
      return {
        action: 'reply',
        message: appendMessage(normalizeMessage(options.defaultReply) || DEFAULT_CONTINUE_MESSAGE, message)
      }
    case 'plan':
      return task.planId ? { action: 'approve' } : { skip: 'no plan to approve' }
    case 'paused':
      return { action: 'resume' }
    case 'error':
      return {
        action: 'retry',
        message: appendMessage(normalizeMessage(options.defaultRetry) || DEFAULT_ERROR_CONTINUE_MESSAGE, message),
        usesQuota: true
      }
    case 'completed':
      if (item?.id === ITEM_ALL && !options.force)
        return { skip: 'completed (Proceed on All skips them unless Force is on)' }
      if (!message) return { skip: 'completed (a follow-up needs a message)' }
      return { action: 'followUp', message, usesQuota: true }
    default:
      if (message) return { action: 'reply', message }
      return { skip: kind === 'running' ? 'already running (add a message to send one)' : 'unknown state' }
  }
}

// Planned work in PROCEED_ORDER, plus a count of skipped tasks per reason.
function planProceedWork(tasks, item, options) {
  const work = []
  const skipped = new Map()
  for (const task of tasks) {
    const plan = planProceed(task, item, options)
    if (plan.skip) skipped.set(plan.skip, (skipped.get(plan.skip) || 0) + 1)
    else work.push({ task, plan, rank: PROCEED_ORDER[taskKind(task)] })
  }
  work.sort((a, b) => a.rank - b.rank)
  return { work, skipped }
}

// GetTask view 3 includes the activity log. The UI threads every reply onto
// the newest activity, so this does the same.
async function getLastActivityId(taskId, config) {
  const result = await callBatchExecute(rpc('GetTask'), [taskId, 3], config)
  const activities = result?.[0]?.[3]
  if (!Array.isArray(activities) || activities.length === 0) return null
  return activities[activities.length - 1]?.[0] || null
}

// [taskId, interaction, null, [experimentIds]] where interaction is
// [_, [planId] to approve the plan, [text, null, clientMessageId] to reply,
// lastActivityId]. Captured from the Jules UI and its plan-approval code.
function buildInteractPayload(task, plan, activityId) {
  const interaction = new Array(4).fill(null)
  if (plan.action === 'approve') {
    interaction[1] = [task.planId]
  } else {
    interaction[2] = [plan.message, null, crypto.randomUUID().toUpperCase()]
  }
  interaction[3] = activityId
  return [task.id, interaction, null, [INTERACT_EXPERIMENT_IDS]]
}

// Returns false when the task was skipped. The send is not retried: a 5xx may
// still have delivered the reply, and a re-run only finds tasks still waiting.
async function proceedTask(label, task, plan, config) {
  if (plan.action === 'resume') {
    await callBatchExecute(rpc('ResumeTask'), [task.id], config)
    return true
  }
  const activityId = await withRetry(() => getLastActivityId(task.id, config))
  if (!activityId) {
    addLog(`  SKIP [${label}] [${task.id}] ${task.title} (no activity to reply to)`)
    return false
  }
  await callBatchExecute(rpc('Interact'), buildInteractPayload(task, plan, activityId), config)
  return true
}

// Drops the work that would start a new run beyond the remaining daily quota.
// The work is already ordered, so failed sessions go before completed ones.
async function capToQuota(label, work, config) {
  const quotaWork = work.filter((w) => w.plan.usesQuota)
  if (quotaWork.length === 0) return work
  let quota = null
  try {
    quota = await getDailySessionQuota(config)
  } catch (e) {
    addLog(`[${label}] WARNING: Could not fetch daily quota: ${e.message}`)
    return work
  }
  if (!quota || quota.remaining >= quotaWork.length) return work
  const kept = new Set(quotaWork.slice(0, quota.remaining))
  if (quota.remaining === 0) {
    addLog(
      `[${label}] Daily session limit reached (${quota.used}/${quota.limit}): skipping ${quotaWork.length} task(s) that would start a new run.`
    )
  } else {
    addLog(
      `[${label}] Daily sessions: ${quota.remaining} left, so only ${quota.remaining} of ${quotaWork.length} task(s) that start a new run will go.`
    )
  }
  return work.filter((w) => !w.plan.usesQuota || kept.has(w))
}

// "12 Waiting on You (12), 3 Error (4)" for the log.
function describeStates(tasks) {
  const counts = new Map()
  for (const t of tasks) {
    const s = taskStateFor(t)
    const key = s ? `${s.name} (${s.code})` : `state ${taskStateCode(t)}`
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return [...counts].map(([key, n]) => `${n} ${key}`).join(', ')
}

// The tasks of the chosen item (and repository), logged with a count per state.
function selectTasks(label, tasks, item, repoFilter) {
  let selected = tasks.filter((t) => itemIncludesTask(item, t))
  if (repoFilter) selected = selected.filter((t) => matchesRepoFilter(repoFilter, t.source, t.repo))
  const where = repoFilter ? ` in ${repoFilter}` : ''
  const breakdown = selected.length > 0 ? `: ${describeStates(selected)}` : ''
  addLog(`[${label}] ${tasks.length} tasks, ${selected.length} match "${item.label}"${where}${breakdown}`)
  return selected
}

async function processProceedForTab(tab, options) {
  const { item } = options
  if (!item) throw new Error('Proceed needs an item')
  const prepared = await prepareTab(tab)
  if (!prepared) return 0
  const { label, config } = prepared

  addLog(`[${label}] Fetching tasks via API...`)
  const tasks = await safeListTasks(label, config)
  if (!tasks) return 0

  const selected = selectTasks(label, tasks, item, options.repoFilter)
  const { work, skipped } = planProceedWork(selected, item, options)
  for (const [reason, n] of skipped) addLog(`[${label}] Skipping ${n} task(s): ${reason}`)
  if (work.length === 0) {
    addLog(`[${label}] Nothing to proceed with.`)
    return 0
  }
  if (
    normalizeMessage(options.message) &&
    work.some((w) => w.plan.action === 'approve' || w.plan.action === 'resume')
  ) {
    addLog(`[${label}] Plan approvals and resumes don't take a message; those tasks go without it.`)
  }

  const toProceed = takeRunBudget(label, await capToQuota(label, work, config), 'task(s) to proceed')
  if (options.dryRun) {
    for (const { task, plan } of toProceed) {
      addLog(`  [DRY] Would ${PROCEED_VERBS[plan.action].dry} [${label}] [${task.id}] ${task.title}`)
    }
    return 0
  }
  if (toProceed.length === 0) {
    addLog(`\n[${label}] TOTAL: 0 tasks proceeded`)
    return 0
  }

  state.progress.total += toProceed.length
  updateState({})

  let proceeded = 0
  await runInPool(toProceed, settings.perAccountParallel, async ({ task, plan }) => {
    try {
      const sent = await proceedTask(label, task, plan, config)
      if (sent) {
        proceeded++
        state.progress.archived++
        addLog(`  ${PROCEED_VERBS[plan.action].done} [${label}] [${task.id}] ${task.title}`)
      } else {
        state.progress.skipped++
      }
    } catch (e) {
      state.progress.skipped++
      const hint = /error code \[8\]/.test(e.message) ? ' (daily session limit reached)' : ''
      addLog(`  ERROR [${label}] proceeding with [${task.id}] ${task.title}: ${e.message}${hint}`)
    }
    updateState({})
  })

  addLog(`\n[${label}] TOTAL: ${proceeded} tasks proceeded`)
  return proceeded
}

// =============================================================================
// Batch Agent + Export Orchestrators
// =============================================================================

// A typed "owner/repo" may not be among the listed sources (e.g. its
// Suggestions toggle is off). Export and Batch Agent then query it directly.
// Anything that isn't a plain owner/repo pair is rejected before it reaches an
// RPC payload.
const EXPLICIT_REPO_REGEX = /^(?:github\/)?[\w.-]+\/[\w.-]+$/

function resolveTargetRepos(label, repos, repoFilter) {
  if (!repoFilter) {
    addLog(`[${label}] Checking all ${repos.length} connected repositories...`)
    return repos
  }
  const filtered = repos.filter((r) => matchesRepoFilter(repoFilter, r))
  if (filtered.length > 0) {
    addLog(`[${label}] Selected repository: ${repoFilter}`)
    return filtered
  }
  const trimmed = repoFilter.trim()
  if (!EXPLICIT_REPO_REGEX.test(trimmed)) {
    addLog(`[${label}] Invalid repository "${repoFilter}" (expected owner/repo). Nothing to do.`)
    return null
  }
  const explicitRepo = trimmed.startsWith('github/') ? trimmed : `github/${trimmed}`
  addLog(`[${label}] Using specified repository directly: ${explicitRepo}`)
  return [explicitRepo]
}

function notify(title, message) {
  if (!chrome.notifications) return
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message })
}

function buildBatchAgentPrompt(suggestions, repo) {
  const repoName = repo.replace(/^github\//, '')
  let body = `# Code Review & Health Remediation Plan for ${repoName}\n\n`
  body += `You are an elite principal engineer and code review agent (like CodeRabbit). `
  body += `You have been provided with an audited list of ${suggestions.length} suggestions identified across this codebase.\n\n`
  body += `## CRITICAL OPERATING INSTRUCTIONS:\n`
  body += `1. **AWARENESS OF CODE CHANGES**: The code in the repository may have evolved since these suggestions were generated. `
  body += `Before making any modifications, inspect the current state of each targeted file and line. If a suggestion is already resolved, obsolete, or invalid given recent refactorings, skip it and clearly state why in your notes.\n`
  body += `2. **SYSTEMATIC SEQUENTIAL EXECUTION**: Work through the items sequentially, one by one. Do not rush or batch untested changes across unrelated files.\n`
  body += `3. **PRESERVE ARCHITECTURAL INTEGRITY**: Maintain type safety, multiplatform boundaries (if applicable), and ensure no behavioral regressions are introduced.\n`
  body += `4. **VERIFICATION**: Run this repository's own build, lint and test commands (see its README, package scripts, Makefile or CI config) to verify each fix before moving on to the next item.\n\n`
  body += `## AUDITED SUGGESTIONS CHECKLIST (${suggestions.length} items):\n\n`

  suggestions.forEach((s, idx) => {
    body += `### Item ${idx + 1}: [${s.categorySlug || 'FIX'}] ${s.title}\n`
    body += `- **Location:** \`${s.filePath}:${s.line}\`\n`
    if (s.description) body += `- **Description:** ${s.description}\n`
    if (s.rationale && s.rationale !== 'N/A') body += `- **Rationale:** ${s.rationale}\n`
    if (s.codeSnippet) {
      body += `\n\`\`\`${s.language || 'text'}\n${s.codeSnippet.trim()}\n\`\`\`\n`
    }
    body += `\n---\n\n`
  })

  body += `\nBegin by examining Item 1. Review the file, make the surgical fix, run verification, and proceed through the list.`
  return body
}

// One Rja83d session per repo carrying every suggestion in a single prompt,
// instead of one session per suggestion.
async function processBatchAgentForTab(tab, options) {
  const prepared = await prepareTab(tab)
  if (!prepared) return 0
  const { label, config } = prepared

  const startConfig = await getStartConfig()

  // Each launch is one Jules session, so the daily session quota applies
  // exactly as it does to Start Suggestions.
  let remaining = Number.POSITIVE_INFINITY
  try {
    const quota = await getDailySessionQuota(config)
    if (quota) {
      addLog(`[${label}] Daily sessions: ${quota.used}/${quota.limit} used, ${quota.remaining} remaining`)
      if (quota.remaining === 0) {
        addLog(`[${label}] Daily limit reached. Skipping Batch Agent.`)
        return 0
      }
      remaining = quota.remaining
    }
  } catch (e) {
    addLog(`[${label}] WARNING: Could not fetch daily quota: ${e.message}`)
  }

  // "All repositories" means the Suggestions-enabled ones, same as Start
  // Suggestions; only an explicitly chosen repo may bypass the toggle.
  addLog(`[${label}] Discovering target repositories for Batch Agent...`)
  let targetRepos
  if (options.repoFilter) {
    const repos = await safeListSources(label, config, true)
    if (!repos) return 0
    targetRepos = resolveTargetRepos(label, repos, options.repoFilter)
  } else {
    targetRepos = await safeListSources(label, config)
  }
  if (!targetRepos) return 0

  addLog(`[${label}] Querying suggestions across ${targetRepos.length} repo(s)...`)
  let totalTasksLaunched = 0

  for (const repo of targetRepos) {
    if (state.status === 'cancelled') break
    if (remaining <= 0) {
      addLog(`[${label}] Daily limit reached. Not launching on the remaining repos.`)
      break
    }
    const suggestions = await listSuggestions(repo, config)
    if (!suggestions || suggestions.length === 0) {
      addLog(`[${label}] ${repo}: 0 suggestions. Skipping agent launch.`)
      continue
    }
    if (takeRunBudget(label, [repo], 'agent launch(es)').length === 0) break

    addLog(`[${label}] ${repo}: Assembling ${suggestions.length} suggestions into 1 Unified Master Agent task...`)
    const batchPrompt = appendMessage(buildBatchAgentPrompt(suggestions, repo), options.message)

    // Budget is spent before the call: a failed launch may still have
    // consumed a session server-side.
    remaining--

    if (options.dryRun) {
      addLog(`  [DRY] Would launch 1 Master Agent on ${repo} handling all ${suggestions.length} items.`)
      continue
    }

    state.progress.total++
    updateState({ currentRepo: repo.replace(/^github\//, '') })
    const payload = buildRja83dPayload(batchPrompt, suggestions[0].id, repo, config, startConfig)
    try {
      await callBatchExecute(rpc('CreateTask'), payload, config)
      totalTasksLaunched++
      state.progress.archived++
      updateState({})
      addLog(`  Launched Unified Agent for ${repo} with all ${suggestions.length} suggestions`)
      notify(
        'Jules Master Agent Dispatched',
        `Dispatched single agent covering ${suggestions.length} suggestions on ${repo.replace(/^github\//, '')}`
      )
    } catch (err) {
      addLog(`  [!] Failed to launch batch agent on ${repo}: ${err.message}`)
    }
  }

  return totalTasksLaunched
}

async function processExportSuggestionsForTab(tab, options) {
  const prepared = await prepareTab(tab)
  if (!prepared) return 0
  const { label, config } = prepared

  // Read-only, so every connected repo is fair game — not just the
  // Suggestions-enabled ones.
  addLog(`[${label}] Discovering all connected repositories...`)
  const repos = await safeListSources(label, config, true)
  if (!repos) return 0

  const targetRepos = resolveTargetRepos(label, repos, options.repoFilter)
  if (!targetRepos) return 0

  addLog(`[${label}] Querying suggestions for ${targetRepos.length} repo(s)...`)
  const allSuggestions = await runInPool(targetRepos, settings.perAccountParallel, (repo) =>
    listSuggestions(repo, config)
      .then((suggestions) => ({ repo, suggestions }))
      .catch((e) => ({ repo, error: e.message }))
  )

  const exportResults = []
  let totalFound = 0
  for (const { repo, suggestions, error } of allSuggestions) {
    if (error) {
      addLog(`[${label}] ERROR fetching suggestions for ${repo}: ${error}`)
      continue
    }
    if (suggestions && suggestions.length > 0) {
      addLog(`[${label}] ${repo}: Found ${suggestions.length} suggestions`)
      totalFound += suggestions.length
      exportResults.push({ repo, suggestions })
    } else {
      addLog(`[${label}] ${repo}: 0 suggestions`)
    }
  }

  const exportPayload = {
    exportedAt: new Date().toISOString(),
    account: label,
    totalSuggestions: totalFound,
    repositories: exportResults
  }

  // Accounts export in parallel; fold each one into the popup's re-download
  // instead of letting the last account overwrite the others.
  const prev = state.exportData
  updateState({
    exportData: prev
      ? {
          exportedAt: exportPayload.exportedAt,
          totalSuggestions: prev.totalSuggestions + totalFound,
          accounts: [...(prev.accounts || [prev]), exportPayload]
        }
      : exportPayload
  })
  persistNow()
  downloadExport(label, exportPayload)

  addLog(`\n[${label}] TOTAL: Successfully extracted ${totalFound} suggestions across ${exportResults.length} repo(s)!`)
  return totalFound
}

// Single download trigger from the service worker, so the file is saved even
// if the popup closes mid-run. The popup's Download button re-saves it.
function downloadExport(label, exportPayload) {
  if (typeof chrome.downloads?.download !== 'function') return
  try {
    const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(exportPayload, null, 2))}`
    const filename = `jules-suggestions-${new Date().toISOString().slice(0, 10)}.json`
    chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) return
      addLog(`[${label}] Export saved: ${filename}`)
      notify(
        'Jules Suggestions Exported',
        `Successfully saved ${exportPayload.totalSuggestions} suggestions to ${filename}`
      )
    })
  } catch (err) {
    console.error('Background download error:', err)
  }
}

// =============================================================================
// GitHub PR Check — task-level matching
// =============================================================================

const prCache = new Map()
// GitHub requests in flight. One sent while others are out waits the same
// random burst delay as Jules requests do.
let githubActive = 0

function getOpenPRs(owner, repo, token) {
  const key = `${owner}/${repo}`
  if (prCache.has(key)) return prCache.get(key)

  // ⚡ Bolt Optimization: Cache the Promise of the fetch operation instead of the resolved data
  // (Request Coalescing). This prevents the "thundering herd" problem where multiple parallel
  // background tabs processing the same repo all trigger simultaneous GitHub API requests.
  // Subsequent concurrent calls will now await this same in-flight Promise.
  const fetchPromise = (async () => {
    try {
      if (typeof owner !== 'string' || typeof repo !== 'string') {
        throw new Error('Owner and repo must be strings')
      }

      const url = new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`)
      url.searchParams.set('state', 'open')
      url.searchParams.set('per_page', '100')

      const burst = githubActive > 0
      githubActive++
      let res
      try {
        if (burst) await pause(burstDelayMs())
        res = await fetchOpenPRs(key, url.toString(), token)
      } finally {
        githubActive--
      }
      const prs = await res.json()
      return prs.map((pr) => ({
        title: pr.title || '',
        titleLower: (pr.title || '').toLowerCase(),
        branch: pr.head?.ref || ''
      }))
    } catch (e) {
      // null, not []: "no open PRs" would let every task through.
      addLog(`  WARNING: Could not check PRs for ${key}: ${e.message}`)
      return null
    }
  })()

  prCache.set(key, fetchPromise)
  return fetchPromise
}

// GitHub answers 404 for a repo the token can't see as well as for a wrong
// name, which a second later is usually still true; one retry, after a random
// wait and with a second more to answer, rules out a passing hiccup.
async function fetchOpenPRs(key, url, token) {
  const request = (timeout) =>
    jFetch(url, { headers: { Accept: 'application/vnd.github+json' }, token, timeout, buffer: true })
  try {
    return await request()
  } catch (e) {
    if (e.status !== 404) throw e
    addLog(`  GitHub answered 404 for ${key}; trying once more`)
    await pause(burstDelayMs())
    return request(settings.requestTimeoutSec * 1000 + 1000)
  }
}

// ⚡ Bolt Optimization: Replace `.some()` with a standard for loop to avoid
// closure allocation overhead in this hot path called for every task.
function taskHasOpenPR(task, openPRs) {
  if (openPRs.length === 0) return false
  const taskTitle = (task.title || '').toLowerCase()
  if (!taskTitle || taskTitle === '(untitled)') return false

  for (let i = 0; i < openPRs.length; i++) {
    const pr = openPRs[i]
    if (pr.titleLower.includes(taskTitle) || taskTitle.includes(pr.titleLower)) {
      return true
    }
  }
  return false
}

// =============================================================================
// State Management (unchanged from v1)
// =============================================================================

const DEFAULT_STATE = {
  status: 'idle',
  currentTab: '',
  currentRepo: '',
  progress: { archived: 0, skipped: 0, total: 0 },
  results: [],
  log: [],
  error: null
}

// A bulk run can emit thousands of log lines (one per task across several
// accounts). Cap the retained log so each persisted snapshot and popup render
// stays bounded — otherwise the array grows without limit and every write
// re-serializes the whole thing.
const MAX_LOG_LINES = 2000
const LOG_BUFFER = 500

let state = { ...DEFAULT_STATE }
let pendingFlush = null

function trimLog() {
  // ⚡ Bolt Optimization: Use a high-water mark buffer to batch array cleanup.
  // This prevents O(N^2) overhead from shifting elements on every log line insert.
  if (state.log.length > MAX_LOG_LINES + LOG_BUFFER) {
    state.log.splice(0, state.log.length - MAX_LOG_LINES)
  }
}

// Persisting on every addLog/updateState writes the whole (growing) state to
// chrome.storage.session per line — O(n^2) writes over a bulk run, plus an
// onChanged event (and full popup re-render) each time, which froze both the
// service worker and the popup. Coalesce rapid updates into one deferred write;
// flush status transitions immediately so the popup always sees the terminal
// state without waiting.
function persistNow() {
  if (pendingFlush) {
    clearTimeout(pendingFlush)
    pendingFlush = null
  }
  chrome.storage.session.set({ archiveState: state })
}

function persistSoon() {
  if (pendingFlush) return
  pendingFlush = setTimeout(() => {
    pendingFlush = null
    chrome.storage.session.set({ archiveState: state })
  }, 150)
}

function updateState(patch) {
  Object.assign(state, patch)
  // Status milestones (running/done/error/idle) are user-visible — flush right
  // away; progress ticks and log spam coalesce into the deferred write.
  if ('status' in patch) {
    persistNow()
  } else {
    persistSoon()
  }
}

function addLog(message) {
  state.log.push(message)
  trimLog()
  persistSoon()
}

const stateReadyPromise = chrome.storage.session.get('archiveState').then((data) => {
  if (data.archiveState) {
    state = data.archiveState
    if (!Array.isArray(state.log)) state.log = []
    // A previous (pre-cap) run may have persisted a huge log that freezes the
    // popup on open; bound it defensively on load.
    trimLog()
    if (state.status === 'running') {
      state.status = 'error'
      state.error = 'Operation interrupted (browser killed service worker)'
      state.log.push('\n[!] Service worker was terminated during operation.')
      persistNow()
    }
  }
})

// =============================================================================
// KeepAlive (unchanged from v1)
// =============================================================================

let keepAliveInterval = null

function startKeepAlive() {
  if (keepAliveInterval) return
  keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo()
  }, 25000)
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval)
    keepAliveInterval = null
  }
}

// =============================================================================
// Tab Management
// =============================================================================

async function getJulesTabs() {
  const tabs = await chrome.tabs.query({ url: `${JULES_ORIGIN}/*` })

  // ⚡ Bolt Optimization: Replace `.filter().map().sort().map()` chain with
  // standard loops to avoid multiple intermediate array allocations and passes.
  const parsed = []
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i]
    if (!t.url.includes('accounts.google')) {
      parsed.push({ t, n: parseInt(extractAccountNum(t.url), 10) })
    }
  }

  parsed.sort((a, b) => a.n - b.n)

  const len = parsed.length
  const result = new Array(len)
  for (let i = 0; i < len; i++) {
    result[i] = parsed[i].t
  }

  return result
}

function getTabLabel(tab) {
  const num = extractAccountNum(tab.url)
  return num !== '0' ? `u/${num}` : 'default'
}

async function prepareTab(tab) {
  const label = getTabLabel(tab)
  updateState({ currentTab: label })
  addLog(`\n${'='.repeat(50)}`)
  addLog(`${label}: ${tab.url}`)
  addLog(`${'='.repeat(50)}`)

  try {
    const config = await getTabConfig(tab.id)
    addLog(`[${label}] Config extracted (bl: ${config.bl.split('_').pop()})`)
    return { label, config }
  } catch (e) {
    addLog(`[${label}] ERROR: ${e.message}`)
    return null
  }
}

async function ensureContentScript(tabId) {
  const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 })
  if (!frame?.url) {
    throw new Error('Security Error: Cannot verify tab origin')
  }

  try {
    const url = new URL(frame.url)
    if (url.origin !== JULES_ORIGIN) {
      throw new Error('Security Error: Cannot inject script into non-Jules tab')
    }
  } catch {
    throw new Error('Security Error: Cannot inject script into non-Jules tab')
  }

  const documentId = frame.documentId
  const target = { tabId, documentIds: [documentId] }

  try {
    await chrome.tabs.sendMessage(tabId, { action: 'PING' }, { documentId })
  } catch {
    await chrome.scripting.executeScript({
      target,
      files: ['content.js']
    })

    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      try {
        await new Promise((r) => setTimeout(r, 100))
        await chrome.tabs.sendMessage(tabId, { action: 'PING' }, { documentId })
        break
      } catch {
        // Keep waiting
      }
    }
    if (Date.now() >= deadline) {
      throw new Error('Content script failed to initialize within 3s')
    }
  }
  return documentId
}

// `fresh` reads WIZ_global_data again instead of the content script's cached
// copy (sign-in renewal). The tab id rides along so a stale token can be
// renewed from the tab later in the run.
async function getTabConfig(tabId, { fresh = false } = {}) {
  const documentId = await ensureContentScript(tabId)
  const response = await chrome.tabs.sendMessage(tabId, { action: 'GET_CONFIG', fresh }, { documentId })
  if (!response?.config?.at) {
    throw new Error('Could not extract page config (XSRF token missing). Try refreshing the Jules tab.')
  }
  // Validate accountNum to prevent path traversal
  const accountNum = String(response.accountNum || '0')
  if (!/^\d+$/.test(accountNum)) {
    throw new Error('Security Error: Invalid account number format')
  }
  return {
    ...response.config,
    accountNum,
    tabId
  }
}

// =============================================================================
// Orchestrator
// =============================================================================

// The Items dropdown picks which states to archive; Force only skips the
// open-PR check.
async function filterArchivableTasks(label, tasks, options) {
  if (options.force) {
    addLog(`[${label}] FORCE: archiving all ${tasks.length} tasks without the open-PR check`)
    return { toArchive: [...tasks], toSkip: [] }
  }

  const byRepo = groupTasksByRepo(tasks)
  addLog(`\n[${label}] Checking open PRs per task...`)
  const { ghOwner } = await chrome.storage.sync.get(['ghOwner'])
  const { ghToken } = await chrome.storage.local.get(['ghToken'])

  const repoEntries = [...byRepo.entries()]
  const allPRs = await runInPool(repoEntries, API_CONCURRENCY, ([_repo, repoTasks]) => {
    const owner = repoTasks[0]?.owner || ghOwner || ''
    const repoName = repoTasks[0]?.repoName || ''
    return owner && repoName ? getOpenPRs(owner, repoName, ghToken) : Promise.resolve([])
  })

  const toArchive = []
  const toSkip = []
  const prLogs = []
  for (let i = 0; i < repoEntries.length; i++) {
    const [repo, repoTasks] = repoEntries[i]
    const openPRs = allPRs[i]
    if (openPRs === null) {
      // Unknown is not "none": without Force, these wait for a check that works.
      prLogs.push(`  ${repo}: ${repoTasks.length} tasks, open PRs unknown`)
      for (const task of repoTasks) {
        toSkip.push(task)
        prLogs.push(`    SKIP [${task.id}] ${task.title} (couldn't check its open PRs)`)
      }
      continue
    }
    prLogs.push(`  ${repo}: ${repoTasks.length} tasks, ${openPRs.length} open PRs`)

    for (const task of repoTasks) {
      if (taskHasOpenPR(task, openPRs)) {
        toSkip.push(task)
        prLogs.push(`    SKIP [${task.id}] ${task.title} (matching open PR)`)
      } else {
        toArchive.push(task)
      }
    }
  }
  if (prLogs.length > 0) addLog(prLogs.join('\n'))

  return { toArchive, toSkip }
}

function logDryRun(label, toArchive) {
  const totalTasks = toArchive.length
  addLog(`[${label}] DRY RUN - would archive ${totalTasks} tasks`)
  const archiveByRepo = groupTasksByRepo(toArchive)
  const dryRunLogs = []
  for (const [repo, repoTasks] of archiveByRepo) {
    dryRunLogs.push(`  ${repo}: ${repoTasks.length} tasks`)
    for (const t of repoTasks) {
      dryRunLogs.push(`    [${t.id}] ${t.title} (state=${t.state})`)
    }
  }
  if (dryRunLogs.length > 0) addLog(dryRunLogs.join('\n'))
}

function getTaskIds(tasks) {
  const len = tasks.length
  const taskIds = new Array(len)
  for (let i = 0; i < len; i++) {
    taskIds[i] = tasks[i].id
  }
  return taskIds
}

// Returns the tasks that were archived. HTTP-level failures (auth, network)
// are not split: every chunk would fail the same way.
// The split is read once: Settings may change it while a batch is going.
async function archiveBatchWithSplit(label, batch, config, unarchive = false) {
  const split = julesApi.archiveSplit
  try {
    await archiveTasksWithRetry(getTaskIds(batch), config, unarchive)
    return batch
  } catch (e) {
    if (batch.length <= split || !RPC_ERROR_CODE_REGEX.test(e.message)) {
      addLog(`  ERROR [${label}] ${unarchive ? 'unarchiving' : 'archiving'} batch: ${e.message}`)
      return []
    }
    addLog(`  [${label}] Batch of ${batch.length} rejected (${e.message}); retrying in chunks of ${split}`)
  }
  const archived = []
  for (let i = 0; i < batch.length; i += split) {
    const chunk = batch.slice(i, i + split)
    try {
      await archiveTasksWithRetry(getTaskIds(chunk), config, unarchive)
      archived.push(...chunk)
    } catch (e) {
      addLog(`  ERROR [${label}] ${unarchive ? 'unarchiving' : 'archiving'} batch: ${e.message}`)
    }
  }
  return archived
}

async function executeArchive(label, toArchive, config) {
  let grandTotal = 0
  let lastUpdate = 0

  const batches = []
  for (let i = 0; i < toArchive.length; i += julesApi.archiveBatch) {
    batches.push(toArchive.slice(i, i + julesApi.archiveBatch))
  }

  await runInPool(batches, settings.perAccountParallel, async (batch) => {
    const now = Date.now()
    if (now - lastUpdate > 500) {
      updateState({ currentRepo: batch[0].repo || '(no repo)' })
      lastUpdate = now
    }
    const archived = await archiveBatchWithSplit(label, batch, config)
    if (archived.length === 0) return
    grandTotal += archived.length
    state.progress.archived += archived.length
    if (Date.now() - lastUpdate > 500) {
      updateState({})
      lastUpdate = Date.now()
    }
    for (const task of archived) {
      addLog(`  Archived [${label}] [${task.id}] ${task.title}`)
    }
  })
  return grandTotal
}

async function processTab(tab, options) {
  const { item } = options
  if (!item) throw new Error('Archive needs an item')
  const prepared = await prepareTab(tab)
  if (!prepared) return 0
  const { label, config } = prepared

  addLog(`[${label}] Fetching tasks via API...`)
  const tasks = await safeListTasks(label, config)
  if (!tasks) return 0

  const selected = selectTasks(label, tasks, item, options.repoFilter)
  if (selected.length === 0) {
    addLog(`[${label}] Nothing to archive.`)
    return 0
  }

  const filtered = await filterArchivableTasks(label, selected, options)
  const { toSkip } = filtered

  if (toSkip.length > 0) {
    addLog(`\n[${label}] ${toSkip.length} tasks skipped by the open-PR check`)
  }

  if (filtered.toArchive.length === 0) {
    addLog(`[${label}] Nothing to archive: every task was skipped by the open-PR check.`)
    return 0
  }
  const toArchive = takeRunBudget(label, filtered.toArchive, 'task(s) to archive')

  const totalTasks = toArchive.length
  addLog(`\n[${label}] Archiving ${totalTasks} tasks`)

  if (options.dryRun) {
    logDryRun(label, toArchive)
    return 0
  }

  state.progress.total += totalTasks
  updateState({})

  const grandTotal = await executeArchive(label, toArchive, config)

  addLog(`\n[${label}] TOTAL: ${grandTotal} archived`)
  return grandTotal
}

const OP_MODE_HEADERS = {
  suggestions: '=== SUGGESTIONS MODE ===',
  agent_batch: '=== BATCH AGENT MODE ===',
  remove_suggestions: '=== REMOVE SUGGESTIONS MODE ===',
  export_suggestions: '=== EXPORT SUGGESTIONS JSON MODE ===',
  proceed: '=== PROCEED MODE ==='
}

const RUN_ACTIONS = new Set(['proceed', 'archive', 'export'])

// Set while a START waits for the settings, so a second START (or a
// scheduled tick) can't slip in before the first run marks itself running.
let startPending = false

// Why a START message from the popup can't run, or null. A popup newer than
// this worker must not have its options read the old way.
function startMessageProblem(msg) {
  const reload = 'Reload the extension at chrome://extensions, then open the popup again.'
  if (msg.protocol !== RUN_PROTOCOL) return `The popup and the background are different versions. ${reload}`
  const options = msg.options
  if (!options || typeof options !== 'object' || Array.isArray(options)) return 'The run has no options.'
  const unknown = Object.keys(options).filter((key) => !START_OPTION_KEYS.includes(key))
  if (unknown.length) return `Unknown option ${unknown.join(', ')}. ${reload}`
  return null
}

// The popup and the CLI send { action, items }; this resolves the ids into the
// phases the run works through, tasks first then Suggestions, and keeps
// opMode/item mirroring the first phase so single-phase callers see the shape
// they always did. `items` stays the verbatim strings the popup sent. Throws on
// a missing or unknown action or item; nothing ever silently becomes All.
function resolveRunOptions(options) {
  if (!RUN_ACTIONS.has(options.action)) throw new Error(`Unknown action "${options.action}"`)
  const resolved = { ...options, message: normalizeMessage(options.message) }
  if (options.action === 'export') {
    resolved.opMode = 'export_suggestions'
    return resolved
  }
  if (!Array.isArray(options.items) || options.items.length === 0) throw new Error('Choose at least one item')
  const maxItems = listItems().length // a rediscovered table can hold up to 40 states
  if (options.items.length > maxItems) throw new Error(`Too many items (at most ${maxItems})`)
  const itemObjects = []
  for (const entry of options.items) {
    if (typeof entry !== 'string') throw new Error('Every item must be a string')
    const item = resolveItem(entry)
    if (!item) throw new Error(`Unknown item "${entry}"`)
    itemObjects.push(item)
  }
  const combined = combineItems(itemObjects) // refuses All beside a task state
  const phases = []
  if (combined.tasks) {
    phases.push({ opMode: options.action === 'archive' ? 'archive' : 'proceed', item: combined.tasks })
  }
  if (combined.suggestions) {
    phases.push({
      opMode: options.action === 'archive' ? 'remove_suggestions' : options.oneSession ? 'agent_batch' : 'suggestions',
      item: combined.suggestions
    })
  }
  resolved.phases = phases
  resolved.opMode = phases[0].opMode
  resolved.item = phases[0].item
  return resolved
}

function initOperationState(options) {
  prCache.clear()
  if (options.repoFilter === '__ALL__') {
    options.repoFilter = ''
  }
  const randomArray = new Uint32Array(1)
  crypto.getRandomValues(randomArray)
  reqCounter = (randomArray[0] % 900000) + 100000
  startKeepAlive()
  updateState({
    status: 'running',
    currentTab: '',
    currentRepo: '',
    progress: { archived: 0, skipped: 0, total: 0 },
    results: [],
    log: [],
    error: null,
    exportData: null,
    options: { ...options }
  })

  const isSuggestions = options.opMode === 'suggestions'
  // A run with several phases logs each phase's own headers in startOperation,
  // so they are not printed twice here.
  const singlePhase = !Array.isArray(options.phases) || options.phases.length <= 1
  if (singlePhase) {
    addLog(options.dryRun ? '=== DRY RUN MODE ===' : OP_MODE_HEADERS[options.opMode] || '=== ARCHIVE MODE ===')
    if (options.item?.label) addLog(`=== ITEM: ${options.item.label} ===`)
  }
  if (options.action === 'archive' && options.message) addLog("Archive doesn't use the message; it is ignored.")
  if (options.scheduled) addLog('=== SCHEDULED (chrome.alarms) ===')
  if (options.force) addLog('=== FORCE MODE (skip PR check) ===')
  addLog('=== v2: batchexecute API ===')
  // Global per-run cap on suggestion-starts, used by scheduled ticks to bound
  // API fan-out across ALL accounts. Object state is required because accounts
  // run in parallel — a plain integer snapshot per tab would let every tab
  // spend the full cap. Decremented once per suggestion before the RPC; even
  // failed starts consume budget (the API call still happened).
  // A run's Suggestions phase can follow its tasks phase.
  const startsSuggestions = Array.isArray(options.phases)
    ? options.phases.some((p) => p.opMode === 'suggestions')
    : isSuggestions
  if (startsSuggestions && Number.isFinite(options.maxSuggestions)) {
    options._remainingStarts = Math.max(0, Math.floor(options.maxSuggestions))
  }
  return isSuggestions
}

// Tabs are processed in parallel. Two tabs on one account would each read
// the same remaining daily quota (and repeat the same archive/dismiss calls),
// so only the first tab per account is used.
function keepFirstTabPerAccount(tabs) {
  const seenAccounts = new Set()
  const uniqueTabs = []
  for (const t of tabs) {
    const num = extractAccountNum(t.url)
    if (seenAccounts.has(num)) continue
    seenAccounts.add(num)
    uniqueTabs.push(t)
  }
  return uniqueTabs
}

async function discoverTabs(options) {
  let tabs = await getJulesTabs()

  if (options.scope === 'current' && options.activeTabId) {
    tabs = tabs.filter((t) => t.id === options.activeTabId)
  }

  const uniqueTabs = keepFirstTabPerAccount(tabs)
  if (uniqueTabs.length < tabs.length) {
    addLog(`Skipping ${tabs.length - uniqueTabs.length} duplicate tab(s) for an already-listed account`)
  }
  tabs = uniqueTabs

  if (tabs.length === 0) {
    addLog('No Jules tabs found. Open jules.google.com first.')
    updateState({ status: 'error', error: 'No Jules tabs found' })
    return null
  }

  addLog(`Found ${tabs.length} Jules tab(s)\n`)
  return tabs
}

// opMode -> per-tab orchestrator. Anything unknown falls back to archive.
function getTabProcessor(opMode) {
  switch (opMode) {
    case 'suggestions':
      return processSuggestionsForTab
    case 'remove_suggestions':
      return processRemoveSuggestionsForTab
    case 'export_suggestions':
      return processExportSuggestionsForTab
    case 'agent_batch':
      return processBatchAgentForTab
    case 'proceed':
      return processProceedForTab
    default:
      return processTab
  }
}

async function processAllTabs(tabs, options, isSuggestions) {
  // Legacy boolean callers predate opMode dispatch; keep them on the same path.
  const opMode = options.opMode || (isSuggestions ? 'suggestions' : 'archive')
  // Process accounts in parallel. Per-account pools and the shared global
  // limiter keep total in-flight requests bounded; results preserve tab order.
  return Promise.all(
    tabs.map(async (tab) => {
      const label = getTabLabel(tab)
      try {
        const count = await getTabProcessor(opMode)(tab, options)
        return { label, count }
      } catch (e) {
        addLog(`ERROR [${label}]: ${e.message}`)
        return { label, count: 0, err: e.message }
      }
    })
  )
}

const OP_MODE_SUMMARY = {
  suggestions: { verb: 'started', itemLabel: 'suggestions' },
  remove_suggestions: { verb: 'removed', itemLabel: 'suggestions' },
  export_suggestions: { verb: 'exported', itemLabel: 'suggestions' },
  agent_batch: { verb: 'launched', itemLabel: 'master agent sessions' },
  proceed: { verb: 'proceeded', itemLabel: 'tasks' },
  more: { verb: 'processed', itemLabel: 'items' }
}

// Accepts the run's options (opMode) or the legacy isSuggestions boolean.
// Only the SUMMARY block; the run's single terminal updateState lives in
// startOperation, so a several-phase run is not flipped to done after phase 1.
function logSummary(results, optionsOrIsSuggestions) {
  let verb = 'archived'
  let itemLabel = 'tasks'
  if (typeof optionsOrIsSuggestions === 'object' && optionsOrIsSuggestions !== null) {
    const summary = OP_MODE_SUMMARY[optionsOrIsSuggestions.opMode]
    if (summary) ({ verb, itemLabel } = summary)
  } else if (optionsOrIsSuggestions) {
    verb = 'started'
  }
  addLog(`\n${'='.repeat(50)}`)
  addLog('SUMMARY')
  addLog(`${'='.repeat(50)}`)
  let grand = 0
  results.forEach((r) => {
    grand += r.count
    addLog(`  ${r.label}: ${r.err ? `ERROR: ${r.err}` : `${r.count} ${verb}`}`)
  })
  addLog(`\n  GRAND TOTAL: ${grand} ${itemLabel} ${verb}`)
}

function finalizeOperation(results, optionsOrIsSuggestions) {
  logSummary(results, optionsOrIsSuggestions)
  updateState({ status: 'done', results })
}

// What a run tracks across its accounts: the Run up to N budget, and the
// accounts paused, stopped or counting 429s.
function resetRunLimits() {
  runBudget = settings.runLimit > 0 ? settings.runLimit : Number.POSITIVE_INFINITY
  accountPauses.clear()
  stoppedAccounts.clear()
  accountRateLimits.clear()
}

function handleOperationError(e) {
  const msg = e?.message || String(e) || 'Unknown error'
  addLog(`FATAL ERROR: ${msg}`)
  updateState({ status: 'error', error: msg })
}

// Raised by every run and every Reset. A Reset doesn't stop the phase in
// flight, and a new run may start meanwhile, so the old run checks this
// before each phase and before it ends, and never writes over the new one.
let operationRun = 0

async function startOperation(rawOptions) {
  let options
  try {
    options = resolveRunOptions(rawOptions)
  } catch (e) {
    handleOperationError(e)
    return
  }
  const isSuggestions = initOperationState(options)
  const run = ++operationRun
  const current = () => run === operationRun && state.status === 'running'

  try {
    // A run that may change Jules leaves no cached load behind; Export reads only.
    if (options.dryRun !== true && options.opMode !== 'export_suggestions') await clearMoreCache()
    // After initOperationState, so a second START already sees the run going.
    await settingsReadyPromise
    options.defaultReply = settings.defaultReply
    options.defaultRetry = settings.defaultRetry
    // runScheduledTick resets once for both of its steps.
    if (!options.tickStep) resetRunLimits()
    if (settings.runLimit > 0) addLog(`Settings: run up to ${settings.runLimit} item(s)`)

    const tabs = await discoverTabs(options)
    if (!tabs) return

    // One run, several phases: tasks first, then Suggestions (resolveRunOptions).
    // The per-phase options are built once per phase so per-run counters such
    // as _remainingStarts stay object state shared by the phase's accounts.
    const phases = options.phases || [{ opMode: options.opMode, item: options.item }]
    const multiPhase = phases.length > 1
    let results = state.results
    for (const phase of phases) {
      if (!current()) break // a Reset, or a newer run, between phases
      const phaseOptions = { ...options, opMode: phase.opMode, item: phase.item }
      if (multiPhase) {
        addLog(
          phaseOptions.dryRun ? '=== DRY RUN MODE ===' : OP_MODE_HEADERS[phaseOptions.opMode] || '=== ARCHIVE MODE ==='
        )
        addLog(`=== ITEM: ${phaseOptions.item.label} ===`)
      }
      const phaseResults = await processAllTabs(tabs, phaseOptions, isSuggestions)
      if (run !== operationRun) break // replaced meanwhile: its summary would land in another log
      if (multiPhase) {
        // The popup's summary keeps the phases apart, so each row says whose
        // phase it came from.
        const phaseName = phaseOptions.item.type === 'suggestions' ? 'Suggestions' : 'Tasks'
        for (const r of phaseResults) {
          r.label = `${r.label} · ${phaseName}`
          r.phase = phaseName
        }
      }
      logSummary(phaseResults, phaseOptions)
      results = results.concat(phaseResults)
    }
    // A Reset during the run (status idle) is never overwritten with done.
    if (current()) updateState({ status: 'done', results })
  } catch (e) {
    if (run === operationRun) handleOperationError(e)
  } finally {
    // A newer run keeps its own keep-alive.
    if (run === operationRun) stopKeepAlive()
    applyPendingJulesApi()
  }
}

// =============================================================================
// More Actions
// =============================================================================

// The last load: an id for each Load, its repo ('' = every repo) and its items
// keyed by account + kind + id. Actions only touch items of this load.
let moreItems = new Map()
let moreLoadId = null
let moreLoadRepo = ''
// The load whose archived tasks are listing or listed: once per load, so a
// second, older answer can't bring back an item an action already used.
let moreArchivedFor = null
let moreArchivedDone = false
let moreItemsError = null
const moreItemsReadyPromise = chrome.storage.session
  .get('moreItems')
  .then((data) => {
    const saved = data.moreItems
    moreLoadId = typeof saved?.id === 'string' ? saved.id : null
    moreLoadRepo = typeof saved?.repo === 'string' ? saved.repo : ''
    moreArchivedDone = saved?.archived === true
    moreArchivedFor = moreArchivedDone ? moreLoadId : null
    moreItems = new Map((Array.isArray(saved?.items) ? saved.items : []).map((item) => [moreItemKey(item), item]))
  })
  .catch((e) => {
    moreItemsError = e.message
  })

// Saves what is in memory now. Every change to the load is made in memory
// before its save starts, and Chrome writes in order, so the last save always
// holds the newest load.
function saveMoreLoad() {
  return chrome.storage.session.set({
    moreItems: { id: moreLoadId, repo: moreLoadRepo, archived: moreArchivedDone, items: [...moreItems.values()] }
  })
}

// A load Chrome can't save (over the 10 MB session storage quota, say) still
// answers from memory, with a note. The older saved load is dropped, so a
// restarted worker acts on no load rather than on that one.
async function saveMoreLoadOrNote(notes) {
  try {
    await saveMoreLoad()
  } catch (e) {
    notes.push(
      `Chrome could not keep this list (${e.message}): it is lost if the extension restarts, so act on it now or load again.`
    )
    await chrome.storage.session.set({ moreItems: null }).catch(() => {})
  }
}

// =============================================================================
// More Actions view
// =============================================================================

// The popup-safe view of the load (chrome.storage.session, key `moreView`):
// what the popup shows of the last load. The worker owns it, so a Load that
// goes on while the popup is closed is still there when the popup opens
// again. It never holds the Google account of an item.
const MORE_VIEW_KEY = 'moreView'
const MORE_VIEW_VERSION = 1
// What the popup says when Chrome could not keep the view.
const MORE_VIEW_TOO_LARGE = 'The list is too large to keep while the popup is closed. Load again.'

let moreView = null
const moreViewReadyPromise = chrome.storage.session
  .get(MORE_VIEW_KEY)
  .then((data) => {
    moreView = validMoreView(data?.[MORE_VIEW_KEY]) ? data[MORE_VIEW_KEY] : null
  })
  .catch(() => {
    moreView = null
  })

// A view of another version, or one without items, is not used.
function validMoreView(view) {
  return view?.version === MORE_VIEW_VERSION && Array.isArray(view.items) && Array.isArray(view.notes)
}

// The view as it is now, as a copy to change. A writer takes it once the
// saved view is read (`moreViewReadyPromise`), so a woken worker changes the
// saved view, never an empty one; and nothing waits between the copy and its
// write, so no change made meanwhile is lost.
function moreViewNow() {
  return moreView ? { ...moreView } : emptyMoreView()
}

function emptyMoreView() {
  return {
    version: MORE_VIEW_VERSION,
    loadId: null,
    category: null,
    repo: '',
    items: [],
    notes: [],
    cachedAt: null,
    archived: 'none',
    loading: null,
    error: null,
    outdated: false,
    rev: 0,
    updatedAt: Date.now()
  }
}

// The rev rises when the items or the notes change, so the popup can skip a
// re-render of the list.
function moreViewRev(view, items, notes) {
  const changed =
    JSON.stringify(view.items ?? []) !== JSON.stringify(items) ||
    JSON.stringify(view.notes ?? []) !== JSON.stringify(notes)
  return changed ? (view.rev ?? 0) + 1 : (view.rev ?? 0)
}

// Writes the view the popup reads. A write Chrome refuses (its quota) saves a
// small view without the items (`partial`) and the error: the worker still
// holds them (`unsaved`) and answers them to an open popup (GET_MORE_VIEW); a
// worker that restarted holds the small view only.
async function writeMoreView(view) {
  const { partial: _partial, unsaved: _unsaved, ...rest } = view
  // Dated after the last write, so the popup can tell the newer of two views.
  const updatedAt = Math.max(Date.now(), (moreView?.updatedAt ?? 0) + 1)
  const written = { ...rest, version: MORE_VIEW_VERSION, updatedAt }
  moreView = written
  try {
    await chrome.storage.session.set({ [MORE_VIEW_KEY]: written })
  } catch {
    // A newer write is on its way and saves its own view.
    if (moreView !== written) return written
    moreView = { ...written, unsaved: true }
    const small = { ...written, items: [], partial: true, error: MORE_VIEW_TOO_LARGE }
    await chrome.storage.session.set({ [MORE_VIEW_KEY]: small }).catch(() => {})
  }
  return moreView
}

// A Load starts: its id is minted before the listing, and the items shown
// stay until the answer.
async function moreViewLoading(id, category, repo) {
  await moreViewReadyPromise
  const view = moreViewNow()
  view.loading = { id, category, repo, startedAt: Date.now() }
  // This Load is the one that brings the list up to date.
  view.error = null
  view.outdated = false
  return writeMoreView(view)
}

// The Load answered: its items, notes and age are the ones shown.
async function moreViewAnswered(id, category, repo, items, notes, cachedAt) {
  await moreViewReadyPromise
  const view = moreViewNow()
  // An older Load's answer never overwrites a newer one's view.
  if (view.loading?.id !== id) return null
  view.rev = moreViewRev(view, items, notes)
  view.loadId = id
  view.category = category
  view.repo = repo
  view.items = items
  view.notes = notes
  view.cachedAt = cachedAt
  view.archived = category === 'archive' ? 'loading' : 'none'
  view.loading = null
  view.error = null
  view.outdated = false
  return writeMoreView(view)
}

// The Load failed: the items shown stay, and the reason is shown with them.
async function moreViewFailed(id, message) {
  await moreViewReadyPromise
  const view = moreViewNow()
  if (view.loading?.id !== id) return null
  view.loading = null
  view.error = message
  return writeMoreView(view)
}

// The archived listing ended: its tasks join the items shown.
async function moreViewArchived(loadId, items, notes, cachedAt) {
  await moreViewReadyPromise
  const view = moreViewNow()
  // A newer Load replaced this one: its tasks are not shown.
  if (view.loadId !== loadId) return null
  const all = [...view.items, ...items]
  const allNotes = [...view.notes, ...notes]
  view.rev = moreViewRev(view, all, allNotes)
  view.items = all
  view.notes = allNotes
  view.archived = 'done'
  view.cachedAt = oldestMoreCachedAt(view.cachedAt, cachedAt)
  return writeMoreView(view)
}

// The archived listing failed: the items shown stay, with the reason.
async function moreViewArchivedFailed(loadId, message) {
  await moreViewReadyPromise
  const view = moreViewNow()
  if (view.loadId !== loadId) return null
  view.archived = 'failed'
  // Said once, as the error: a new Load clears it.
  view.error = `Could not list the archived tasks: ${message}`
  return writeMoreView(view)
}

// An action that changed an item takes it out of the view too.
async function moreViewDropped(keys) {
  await moreViewReadyPromise
  const view = moreViewNow()
  const items = view.items.filter((item) => !keys.has(moreItemKey(item)))
  if (items.length === view.items.length) return null
  view.rev = moreViewRev(view, items, view.notes)
  view.items = items
  return writeMoreView(view)
}

// A run that may change Jules leaves the list shown out of date.
async function moreViewOutdated() {
  await moreViewReadyPromise
  const view = moreViewNow()
  if (view.outdated) return null
  view.outdated = true
  return writeMoreView(view)
}

// The age of the oldest part of a load: null when all of it is live.
function oldestMoreCachedAt(first, second) {
  const dates = [first, second].filter((at) => Number.isFinite(at))
  return dates.length ? Math.min(...dates) : null
}

// The items of a load as the popup sees them: without the Google account.
function morePopupItems(items) {
  return items.map(({ user: _user, ...item }) => item)
}

// The notes of a load as the popup shows them: the load's own and each
// account's.
function moreLoadNotes(accounts, notes = []) {
  return [...notes, ...accounts.flatMap((account) => account.notes || [])]
}

// `fresh` is Refresh: list again past the cache (see cachedMoreRead).
const MORE_MESSAGE_KEYS = {
  LOAD_ITEMS: ['action', 'protocol', 'repo', 'category', 'fresh'],
  LOAD_ARCHIVED: ['action', 'protocol', 'loadId', 'fresh'],
  APPLY_ACTION: ['action', 'protocol', 'operation', 'dryRun', 'force', 'items'],
  GET_MORE_VIEW: ['action', 'protocol']
}

function moreMessageProblem(msg) {
  if (msg.protocol !== RUN_PROTOCOL) {
    return 'The popup and the background are different versions. Reload the extension at chrome://extensions.'
  }
  const keys = MORE_MESSAGE_KEYS[msg.action]
  const unknown = Object.keys(msg).filter((key) => !keys.includes(key))
  if (unknown.length) return `Unknown option ${unknown.join(', ')}. Reload the extension.`
  if ('fresh' in msg && typeof msg.fresh !== 'boolean') return 'Invalid fresh option.'
  if (msg.action === 'LOAD_ITEMS') {
    if (typeof msg.repo !== 'string' || (msg.repo !== '' && !/^[\w.-]+\/[\w.-]+$/.test(msg.repo))) {
      return 'Enter a repo in org/repo format.'
    }
    if (!Object.hasOwn(MORE_LOAD_CATEGORIES, msg.category)) return `Unknown load category "${msg.category}".`
  } else if (msg.action === 'LOAD_ARCHIVED') {
    if (typeof msg.loadId !== 'string') return 'Invalid load id.'
  } else if (msg.action === 'APPLY_ACTION') {
    if (!Object.hasOwn(MORE_ACTIONS, msg.operation)) return `Unknown action "${msg.operation}"`
    if (MORE_ACTIONS[msg.operation].local) return `${MORE_ACTIONS[msg.operation].label} runs in the popup.`
    if (typeof msg.dryRun !== 'boolean' || typeof msg.force !== 'boolean' || !Array.isArray(msg.items)) {
      return 'Invalid action options.'
    }
    if (
      msg.items.some(
        (item) =>
          !item ||
          typeof item !== 'object' ||
          Object.keys(item).some((key) => !['account', 'kind', 'id'].includes(key)) ||
          ['account', 'kind', 'id'].some((key) => typeof item[key] !== 'string')
      )
    )
      return 'Invalid selected items.'
  }
  return null
}

function moreTaskItem(task) {
  return {
    id: task.id,
    title: task.title,
    state: taskStateCode(task),
    repo: task.repo,
    awaitingReview: task.awaitingReview
  }
}

function moreScheduleItem(row) {
  return {
    id: row[0],
    title: firstLine(row[3]?.[0]) || '(untitled)',
    state: row[6],
    repo: String(row[1] || '').replace(/^github\//, ''),
    cron: row[2]?.[7]?.[3] || '',
    timeZone: row[2]?.[7]?.[4] || ''
  }
}

// A load's task or schedule with the source Jules gave it, as the cache keeps
// it: a load for one repo picks its items by source.
function moreTaskEntry(task) {
  return { ...moreTaskItem(task), source: task.source }
}

function moreScheduleEntry(row) {
  return { ...moreScheduleItem(row), source: String(row[1] || '') }
}

function moreItemOfEntry(entry) {
  const { source: _source, ...item } = entry
  return item
}

// =============================================================================
// More Actions cache
// =============================================================================

// What a Load read, so a Load within ttlMs answers at once: an account's
// tasks (of every repo or of one source), its schedules, each repo's archived
// tasks and its repo list. Kept in chrome.storage.local per Google account
// (WIZ_global_data S06Grb, content.js's `user`): u/N can be another account
// after a sign-in change, and an account without the id is not cached. Only
// Loads read it; the checks behind actions (Delete permanently's, the
// Unarchive check, open PRs) list live.
const MORE_CACHE_KEY = 'moreCache'
const MORE_CACHE_VERSION = 1
// maxBytes counts UTF-8 bytes, as Chrome's storage quota does.
const MORE_CACHE = { ttlMs: 30 * 60 * 1000, maxItems: 20000, maxBytes: 4 * 1024 * 1024 }

// The entries, oldest first: a read that is kept goes to the end. null when
// chrome.storage.local could not be read; the next call tries again.
let moreCachePromise = null

// The reads still waiting for Jules, as { user, list, source, dropped }. An
// action that changes their list marks them dropped: what they bring back
// may be from before it, so it is not kept.
const moreCacheReads = new Set()

function moreCacheKey(user, list, source) {
  return JSON.stringify([user, list, source])
}

function validMoreCacheEntry(entry) {
  return (
    typeof entry?.user === 'string' &&
    entry.user !== '' &&
    typeof entry.list === 'string' &&
    typeof entry.source === 'string' &&
    Number.isFinite(entry.at) &&
    Array.isArray(entry.items)
  )
}

function moreCacheEntries() {
  moreCachePromise ??= chrome.storage.local.get(MORE_CACHE_KEY).then(
    (data) => {
      const cache = data?.[MORE_CACHE_KEY]
      const saved = cache?.version === MORE_CACHE_VERSION ? cache.entries : null
      const entries = (Array.isArray(saved) ? saved : []).filter(validMoreCacheEntry).sort((a, b) => a.at - b.at)
      return new Map(entries.map((entry) => [moreCacheKey(entry.user, entry.list, entry.source), entry]))
    },
    () => {
      // Unread, the cache can't be used, and a save would write over every
      // other account's entries.
      moreCachePromise = null
      return null
    }
  )
  return moreCachePromise
}

function freshMoreCacheEntry(entry) {
  const age = Date.now() - entry.at
  return age >= 0 && age < MORE_CACHE.ttlMs
}

// One read of a Load: the cached answer while it is fresh, else the read's
// own, which is kept, dated from when the read began. `cache.fresh`
// (Refresh) skips the cache and still keeps the answer; `cache.cachedAt`
// gets the date of the oldest answer used. A read that fails keeps nothing.
async function cachedMoreRead(cache, user, list, source, read) {
  if (typeof user !== 'string' || user === '') return read()
  const entries = await moreCacheEntries()
  if (!entries) return read()
  const key = moreCacheKey(user, list, source)
  const hit = entries.get(key)
  if (!cache.fresh && hit && freshMoreCacheEntry(hit)) {
    cache.cachedAt = Math.min(cache.cachedAt ?? hit.at, hit.at)
    return hit.items
  }
  const at = Date.now()
  const pending = { user, list, source, dropped: false }
  moreCacheReads.add(pending)
  let items
  try {
    items = await read()
  } finally {
    moreCacheReads.delete(pending)
  }
  if (pending.dropped) return items
  // A run that cleared the cache meanwhile left these entries behind.
  entries.delete(key)
  entries.set(key, { user, list, source, at, items })
  return items
}

// Saves the newest entries within MORE_CACHE's limits; expired ones go.
async function saveMoreCache() {
  const entries = await moreCacheEntries()
  if (!entries) return
  const utf8 = new TextEncoder()
  const sizes = new Map()
  let items = 0
  let bytes = 0
  for (const [key, entry] of entries) {
    if (!freshMoreCacheEntry(entry)) {
      entries.delete(key)
      continue
    }
    sizes.set(key, utf8.encode(JSON.stringify(entry)).length)
    items += entry.items.length
    bytes += sizes.get(key)
  }
  for (const [key, entry] of entries) {
    if (items <= MORE_CACHE.maxItems && bytes <= MORE_CACHE.maxBytes) break
    entries.delete(key)
    items -= entry.items.length
    bytes -= sizes.get(key)
  }
  try {
    await chrome.storage.local.set({
      [MORE_CACHE_KEY]: { version: MORE_CACHE_VERSION, entries: [...entries.values()] }
    })
  } catch {
    // Chrome could not keep it (its quota, say): the next Load lists live.
    entries.clear()
    await chrome.storage.local.remove(MORE_CACHE_KEY).catch(() => {})
  }
}

// The lists of a load each action changes.
const MORE_ACTION_LISTS = {
  pauseTask: ['tasks'],
  resumeTask: ['tasks'],
  archive: ['tasks', 'archived'],
  unarchive: ['tasks', 'archived'],
  deleteTask: ['archived'],
  pauseSchedule: ['schedules'],
  resumeSchedule: ['schedules'],
  deleteSchedule: ['schedules']
}

// Before an action and after it: its account's entries of the lists it
// changes go, for its items' repos and for every repo, and so do the reads
// of them still waiting, so the next Load lists them live.
async function dropMoreCache(user, operation, items) {
  if (typeof user !== 'string' || user === '') return
  const lists = MORE_ACTION_LISTS[operation] || []
  const sources = new Set(items.map((item) => `github/${item.repo}`.toLowerCase()))
  const changes = (entry) =>
    entry.user === user &&
    lists.includes(entry.list) &&
    (entry.source === '' || sources.has(entry.source.toLowerCase()))
  for (const pending of moreCacheReads) if (changes(pending)) pending.dropped = true
  const entries = await moreCacheEntries()
  if (!entries) return clearMoreCache()
  let dropped = false
  for (const [key, entry] of entries) {
    if (!changes(entry)) continue
    entries.delete(key)
    dropped = true
  }
  if (dropped) await saveMoreCache()
}

// A run can change any list of any account.
async function clearMoreCache() {
  for (const pending of moreCacheReads) pending.dropped = true
  moreCachePromise = Promise.resolve(new Map())
  // The list the popup shows is from before that run.
  await moreViewOutdated()
  await chrome.storage.local.remove(MORE_CACHE_KEY).catch(() => {})
}

// Every archived task of the account, one repo at a time: Jules
// gives up (RPC error [4], after about 90 s) on a large account's whole
// archive, but lists one repo's in seconds. A repo it can't list goes into a
// note; the others still load. Once a newer Load replaces this one, no
// more repos are asked for.
async function listArchivedByRepo(config, { account, notes, progress, cache }) {
  const sources = await moreSources(config, cache)
  progress.add(sources.length)
  const failed = []
  const lists = await runInPool(sources, settings.perAccountParallel, async (source) => {
    if (progress.replaced()) return []
    try {
      return await withRetry(() => (progress.replaced() ? [] : moreArchivedOf(source, config, cache)))
    } catch (e) {
      failed.push(`${source.replace(/^github\//, '')} (${e.message})`)
      return []
    } finally {
      progress.done()
    }
  })
  if (failed.length) {
    const named =
      failed.length > 3 ? `${failed.slice(0, 3).join(', ')} and ${failed.length - 3} more` : failed.join(', ')
    notes.push(
      `Jules could not list the archived tasks of ${failed.length} of ${sources.length} repos of ${account}: ` +
        `${named}.`
    )
  }
  return lists.flat()
}

// One repo's archived tasks, as entries.
function moreArchivedOf(source, config, cache) {
  return cachedMoreRead(cache, config.user, 'archived', source, async () =>
    (await listTasks(`source_id=${source} AND is_archived=true`, config)).map(moreTaskEntry)
  )
}

// The account's repos, the disconnected ones too (see listEverySource).
function moreSources(config, cache) {
  return cachedMoreRead(cache, config.user, 'sources', '', () => listEverySource(config))
}

// What each list of a load reads, as entries, and the kind its items get.
// With a repo, Jules is asked for that repo's source only.
const MORE_LISTS = {
  tasks: {
    kind: 'task',
    label: 'tasks',
    read: (config, source, { cache }) =>
      cachedMoreRead(cache, config.user, 'tasks', source, async () =>
        (await listTasks(source ? `source_id=${source} AND is_archived=false` : '', config)).map(moreTaskEntry)
      )
  },
  schedules: {
    kind: 'schedule',
    label: 'schedules',
    read: (config, _source, { cache }) =>
      cachedMoreRead(cache, config.user, 'schedules', '', async () =>
        ((await callBatchExecute(rpc('ListScheduledTasks'), [], config))?.[0] || []).map(moreScheduleEntry)
      )
  },
  archived: {
    kind: 'archived',
    label: 'archived tasks',
    read: (config, source, context) =>
      source ? moreArchivedOf(source, config, context.cache) : listArchivedByRepo(config, context)
  }
}

// The "N of M repos" the popup shows while every repo's archived tasks list.
// Saved at most twice a second, and once more at the end.
function moreArchivedProgress(loadId) {
  const counts = { loadId, done: 0, total: 0 }
  let timer = null
  const save = () => {
    clearTimeout(timer)
    timer = null
    // A newer load's count is the one to keep.
    // Dated, so a reopened popup tells a listing that goes on from one that stopped.
    if (moreLoadId === loadId) {
      chrome.storage.session.set({ moreArchivedProgress: { ...counts, updatedAt: Date.now() } })
    }
  }
  const soon = () => {
    timer ??= setTimeout(save, 500)
  }
  return {
    add(n) {
      counts.total += n
      soon()
    },
    done() {
      counts.done++
      soon()
    },
    finish() {
      if (counts.total) save()
      else clearTimeout(timer)
    },
    replaced: () => moreLoadId !== loadId
  }
}

const NO_PROGRESS = { add() {}, done() {}, finish() {}, replaced: () => false }

// The repo's source id as the account's repos spell it (a disconnected one
// too): Jules matches source_id by exact case. null when the account
// doesn't have it.
async function moreRepoSource(repo, config, { account, notes, cache }) {
  const wanted = `github/${repo}`
  try {
    const source = (await moreSources(config, cache)).find((s) => s.toLowerCase() === wanted.toLowerCase())
    if (!source) notes.push(`${account} has no repo ${repo}.`)
    return source || null
  } catch (e) {
    notes.push(`Could not read the repos of ${account}, so ${repo} is used as typed: ${e.message}`)
    return wanted
  }
}

// What Load lists for each choice of its dropdown. Jules has no filter for
// Completed, so those are picked here. The archived tasks come only with
// LOAD_ARCHIVED: for all repos they take a few minutes on a large account.
const MORE_LOAD_CATEGORIES = {
  all: { lists: ['tasks', 'schedules'] },
  scheduled: { lists: ['schedules'] },
  complete: { lists: ['tasks'], keep: isCompletedTask },
  archive: { lists: [] }
}

// Every signed-in account's `lists`, for one repo or all of them. A list
// Jules can't give becomes a note for that account; the rest still load.
// `cache` is { fresh, cachedAt } (see cachedMoreRead).
async function listMoreItems(repo, lists, keep = () => true, progress = NO_PROGRESS, cache = { fresh: false }) {
  const tabs = keepFirstTabPerAccount(await getJulesTabs())
  if (!tabs.length) throw new Error('No Jules tabs found. Open jules.google.com first.')
  const matches = (source) => !repo || String(source).toLowerCase() === `github/${repo}`.toLowerCase()
  return Promise.all(
    tabs.map(async (tab) => {
      const account = `u/${extractAccountNum(tab.url)}`
      const result = { account, notes: [] }
      for (const list of lists) result[list] = []
      const prepared = await prepareTab(tab)
      if (!prepared) {
        result.notes.push(`Could not prepare ${account}. Open that Jules tab, check you are signed in.`)
        return result
      }
      // The Google account the items belong to; the worker keeps it, the popup doesn't get it.
      result.user = prepared.config.user ?? null
      const context = { account, notes: result.notes, progress, cache }
      // Schedules are filtered here; only the task lists need the source id.
      const source =
        repo && lists.some((list) => list !== 'schedules') ? await moreRepoSource(repo, prepared.config, context) : ''
      const reads = await Promise.allSettled(
        lists.map((list) =>
          list !== 'schedules' && source === null ? [] : MORE_LISTS[list].read(prepared.config, source, context)
        )
      )
      for (const [index, list] of lists.entries()) {
        const read = reads[index]
        if (read.status === 'rejected') {
          result.notes.push(`Jules could not list the ${MORE_LISTS[list].label} of ${account}: ${read.reason.message}.`)
        } else if (list === 'schedules') {
          result.schedules = read.value.filter((entry) => matches(entry.source)).map(moreItemOfEntry)
        } else {
          result[list] = read.value.filter((entry) => matches(entry.source) && keep(entry)).map(moreItemOfEntry)
        }
      }
      return result
    })
  )
}

function popupMoreAccount({ user: _user, ...account }) {
  return account
}

function moreItemsOf(accounts, lists) {
  return accounts.flatMap((account) =>
    lists.flatMap((list) =>
      account[list].map((item) => ({
        ...item,
        account: account.account,
        user: account.user ?? null,
        kind: MORE_LISTS[list].kind
      }))
    )
  )
}

// A load answers with the lists of its category; the archived tasks of an
// Archived load come later, listed by the worker itself. `cachedAt` dates the
// oldest cached list it used (null: all live).
async function loadMoreItems(repo, category, fresh = false) {
  startKeepAlive()
  resetRunLimits()
  // The id is minted before the listing, so the view can name the Load that
  // is going while the items shown are still the old load's.
  const id = crypto.randomUUID()
  await moreViewLoading(id, category, repo)
  try {
    const { lists, keep } = MORE_LOAD_CATEGORIES[category]
    const cache = { fresh, cachedAt: null }
    const accounts = await listMoreItems(repo, lists, keep, NO_PROGRESS, cache)
    await saveMoreCache()
    // The new load replaces the old one before its save starts: an older
    // load's archived answer arriving meanwhile is then stale.
    moreLoadId = id
    moreLoadRepo = repo
    moreArchivedFor = null
    moreArchivedDone = false
    const items = moreItemsOf(accounts, lists)
    moreItems = new Map(items.map((item) => [moreItemKey(item), item]))
    moreItemsError = null
    const notes = []
    await saveMoreLoadOrNote(notes)
    await moreViewAnswered(id, category, repo, morePopupItems(items), moreLoadNotes(accounts, notes), cache.cachedAt)
    return { loadId: id, accounts: accounts.map(popupMoreAccount), notes, cachedAt: cache.cachedAt }
  } catch (e) {
    // The view shows the reason, so the popup need not say it again.
    const shown = await moreViewFailed(id, e.message)
    throw Object.assign(new Error(e.message), shown ? { inView: true } : {})
  } finally {
    stopKeepAlive()
  }
}

// Read-only, so a run may start meanwhile. It keeps the worker alive on its
// own: the run's keep-alive stops when the run ends, and this must not stop it.
async function loadMoreArchived(loadId, fresh = false) {
  const replaced = () => new Error('A newer load replaced this one. Load again.')
  if (loadId !== moreLoadId) throw replaced()
  if (moreArchivedFor === loadId) throw new Error('The archived tasks of this load are already listed. Load again.')
  moreArchivedFor = loadId
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 25000)
  const progress = moreArchivedProgress(loadId)
  try {
    const cache = { fresh, cachedAt: null }
    const accounts = await listMoreItems(moreLoadRepo, ['archived'], undefined, progress, cache)
    // What was listed is kept even when a newer load replaced this one.
    await saveMoreCache()
    if (loadId !== moreLoadId) throw replaced()
    const items = moreItemsOf(accounts, ['archived'])
    for (const item of items) moreItems.set(moreItemKey(item), item)
    moreArchivedDone = true
    const notes = []
    await saveMoreLoadOrNote(notes)
    await moreViewArchived(loadId, morePopupItems(items), moreLoadNotes(accounts, notes), cache.cachedAt)
    return { loadId, accounts: accounts.map(popupMoreAccount), notes, cachedAt: cache.cachedAt }
  } catch (e) {
    // Nothing was listed (no Jules tab, say): the same load may try again.
    if (moreArchivedFor === loadId && !moreArchivedDone) moreArchivedFor = null
    await moreViewArchivedFailed(loadId, e.message)
    throw e
  } finally {
    progress.finish()
    clearInterval(keepAlive)
  }
}

async function executeMoreBatches(label, items, config, unarchive) {
  const acted = []
  for (let i = 0; i < items.length; i += julesApi.archiveBatch) {
    acted.push(...(await archiveBatchWithSplit(label, items.slice(i, i + julesApi.archiveBatch), config, unarchive)))
  }
  if (!unarchive || !acted.length) return acted
  // A batch can answer [] and still skip an id. The ids Jules doesn't list
  // again are sent once more; any still missing after that are not counted.
  // If the first check can't be read, the replies are trusted; the retried
  // ids were already skipped once, so they count only when Jules lists them.
  const missing = await stillArchived(label, acted, config)
  if (!missing?.length) return acted
  addLog(`[${label}] Unarchive check: retrying ${missing.length} missing item(s) once`)
  const retried = []
  for (let i = 0; i < missing.length; i += julesApi.archiveBatch) {
    retried.push(...(await archiveBatchWithSplit(label, missing.slice(i, i + julesApi.archiveBatch), config, true)))
  }
  const failed = new Set(missing.filter((item) => !retried.includes(item)))
  const after = await stillArchived(label, retried, config)
  for (const item of after || retried) {
    addLog(
      `  [${label}] [${item.id}] ${item.title}: ${after ? 'still archived after a retry' : 'retried, not confirmed'}`
    )
    failed.add(item)
  }
  return acted.filter((item) => !failed.has(item))
}

// DeleteTasks takes a list of ids; Jules' own Delete permanently sends one.
// The other per-item RPCs take the id alone.
function moreActionPayload(operation, item) {
  return operation === 'deleteTask' ? [[item.id]] : [item.id]
}

// The selected tasks Jules still lists as archived, read live: a load (a
// cached one, say) may be older than a task's unarchiving in Jules, and
// Delete permanently must not reach a task that is no longer archived. A
// repo whose archive can't be read deletes nothing.
async function stillArchivedInJules(label, items, config) {
  const byRepo = new Map()
  for (const item of items) byRepo.set(item.repo, [...(byRepo.get(item.repo) || []), item])
  const archived = new Set()
  const unread = new Set()
  await runInPool([...byRepo], settings.perAccountParallel, async ([repo, group]) => {
    try {
      if (!repo) throw new Error('Jules gave no repo for them')
      const listed = await withRetry(() => listTasks(`source_id=github/${repo} AND is_archived=true`, config))
      for (const task of listed) archived.add(task.id)
    } catch (e) {
      unread.add(repo)
      addLog(
        `  [${label}] Could not check the archived tasks of ${repo || '(no repo)'}, so none of its ` +
          `${group.length} task(s) are deleted: ${e.message}`
      )
    }
  })
  return items.filter((item) => {
    if (unread.has(item.repo)) return false
    if (archived.has(item.id)) return true
    addLog(`  [${label}] [${item.id}] ${item.title}: Jules no longer lists it as archived; not deleted`)
    return false
  })
}

// The items Jules doesn't list among the non-archived tasks, or null when
// the list can't be read.
async function stillArchived(label, items, config) {
  if (!items.length) return []
  try {
    const visible = new Set((await listTasks('', config)).map((task) => task.id))
    return items.filter((item) => !visible.has(item.id))
  } catch (e) {
    addLog(`  [${label}] Could not check the unarchived tasks: ${e.message}`)
    return null
  }
}

// Archive checks the open PRs like the main Archive does; Force skips that
// check and means nothing to the other actions.
async function startMoreOperation(msg) {
  const force = msg.operation === 'archive' && msg.force
  const options = { action: 'more', opMode: 'more', moreAction: msg.operation, dryRun: msg.dryRun, force }
  initOperationState(options)
  resetRunLimits()
  addLog(`=== MORE ACTIONS: ${MORE_ACTIONS[msg.operation].label} ===`)
  updateState({ progress: { archived: 0, skipped: 0, total: msg.items.length } })
  try {
    if (moreItemsError) throw new Error(`Could not restore the last load: ${moreItemsError}. Load items again.`)
    const groups = new Map()
    const seen = new Set()
    // The items an action changed leave the view the popup shows, too.
    const dropped = new Set()
    for (const selection of msg.items) {
      const key = moreItemKey(selection)
      const item = moreItems.get(key)
      if (!moreActionFits(msg.operation, item) || seen.has(key)) {
        addLog(
          `Skipped [${selection.account}] [${selection.id}]: missing from last load, duplicate, or action does not fit`
        )
        state.progress.skipped++
        continue
      }
      seen.add(key)
      const group = groups.get(item.account) || []
      group.push(item)
      groups.set(item.account, group)
    }
    const tabs = keepFirstTabPerAccount(await getJulesTabs())
    const results = await Promise.all(
      [...groups].map(async ([account, selected]) => {
        let count = 0
        let work = null
        try {
          let candidates = selected
          if (msg.operation === 'archive') {
            const tasks = selected.map((item) => {
              const [owner = '', repoName = ''] = (item.repo || '').split('/')
              return { ...item, owner, repoName }
            })
            candidates = (await filterArchivableTasks(account, tasks, { force })).toArchive
            state.progress.skipped += selected.length - candidates.length
          }
          work = takeRunBudget(account, candidates, 'selected item(s)')
          state.progress.skipped += candidates.length - work.length
          if (!work.length) return { label: account, count }
          let acted
          if (msg.dryRun) acted = work
          else {
            const tab = tabs.find((t) => `u/${extractAccountNum(t.url)}` === account)
            const prepared = tab && (await prepareTab(tab))
            if (!prepared) throw new Error('Open that Jules tab, check you are signed in, then load again.')
            // After a sign-in change u/N is another account, whose credentials must not act on the load;
            // one that no longer names its account can't be checked, so it doesn't act either.
            const user = prepared.config.user ?? null
            if (work.some((item) => item.user && item.user !== user)) {
              throw new Error(
                user
                  ? `${account} is another Google account now than when it was loaded. Load again.`
                  : `${account} no longer says which Google account it is, so the load can't be checked. Load again.`
              )
            }
            await dropMoreCache(user, msg.operation, work)
            try {
              if (msg.operation === 'archive' || msg.operation === 'unarchive') {
                acted = await executeMoreBatches(account, work, prepared.config, msg.operation === 'unarchive')
              } else {
                const targets =
                  msg.operation === 'deleteTask' ? await stillArchivedInJules(account, work, prepared.config) : work
                acted = []
                for (const item of targets) {
                  try {
                    await callBatchExecute(
                      rpc(MORE_ACTIONS[msg.operation].method),
                      moreActionPayload(msg.operation, item),
                      prepared.config
                    )
                    acted.push(item)
                  } catch (e) {
                    addLog(`ERROR [${account}] [${item.id}]: ${e.message}`)
                  }
                }
              }
            } finally {
              // An older Load still listing may have read these lists while the action ran.
              await dropMoreCache(user, msg.operation, work)
            }
          }
          for (const item of acted) {
            addLog(
              `${msg.dryRun ? 'DRY RUN - would ' : ''}${MORE_ACTIONS[msg.operation].label} [${account}] [${item.id}] ${item.title}`
            )
            if (!msg.dryRun) {
              moreItems.delete(moreItemKey(item))
              dropped.add(moreItemKey(item))
            }
          }
          count = acted.length
          state.progress.archived += count
          state.progress.skipped += work.length - count
          updateState({})
          return { label: account, count }
        } catch (e) {
          addLog(`ERROR [${account}]: ${e.message}`)
          // Before the budget is taken, every selected item is still waiting.
          state.progress.skipped += work ? work.length - count : selected.length
          return { label: account, count, err: e.message }
        }
      })
    )
    if (!msg.dryRun) {
      // The actions are done: a load Chrome can't keep doesn't make them fail.
      const notes = []
      await saveMoreLoadOrNote(notes)
      for (const note of notes) addLog(`WARNING: ${note}`)
      await moreViewDropped(dropped)
    }
    finalizeOperation(results, options)
  } catch (e) {
    handleOperationError(e)
  } finally {
    stopKeepAlive()
    applyPendingJulesApi()
  }
}

// =============================================================================
// Message Handlers
// =============================================================================

// =============================================================================
// Jules API rediscovery
// =============================================================================

// Reads the RPC ids and the task-state map from the Jules web app's scripts,
// from Settings > "Rediscover from Jules" and once a day. Changes apply at
// once and go to a short log (JULES_API_LOG_KEY).
const API_REDISCOVER_ALARM = 'jta-api-rediscover'

// Runs inside the Jules tab (isolated world), so it must stand alone. Fetches
// only https scripts on jules.google.com or *.gstatic.com and returns parsed
// values, never the script text.
async function readJulesBundle() {
  const urls = new Set()
  for (const el of document.scripts) if (el.src) urls.add(el.src)
  for (const entry of performance.getEntriesByType('resource')) {
    if (entry.initiatorType === 'script') urls.add(entry.name)
  }
  const allowed = [...urls].filter((u) => {
    try {
      const { protocol, hostname } = new URL(u)
      return protocol === 'https:' && (hostname === 'jules.google.com' || hostname.endsWith('.gstatic.com'))
    } catch {
      return false
    }
  })
  const rpc = []
  const stateMaps = []
  const rpcPattern = /\{S:"([A-Za-z0-9]{5,6})",V:"\/([\w.]+)"/g
  const mapStart = 'new Map([[0,"Unknown"]'
  for (const url of allowed.slice(0, 40)) {
    // A script that stops arriving is skipped, not waited on forever.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20 * 1000)
    let text
    try {
      text = await (await fetch(url, { signal: controller.signal })).text()
    } catch {
      continue
    } finally {
      clearTimeout(timer)
    }
    for (const m of text.matchAll(rpcPattern)) rpc.push([m[1], m[2]])
    for (let at = text.indexOf(mapStart); at !== -1; at = text.indexOf(mapStart, at + 1)) {
      const open = at + 'new Map('.length
      let depth = 0
      let end = -1
      for (let i = open; i < text.length && i < open + 4000; i++) {
        if (text[i] === '"') i = text.indexOf('"', i + 1)
        else if (text[i] === '[') depth++
        else if (text[i] === ']' && --depth === 0) {
          end = i + 1
          break
        }
        if (i === -1) break
      }
      if (end === -1) continue
      try {
        stateMaps.push(JSON.parse(text.slice(open, end)))
      } catch {
        /* not a plain literal */
      }
    }
  }
  return { rpc, stateMaps, scripts: allowed.length }
}

// One check at a time: a second request (the popup's button while the daily
// alarm runs) gets the same answer.
let rediscovery = null

// A check stuck in the tab must not hold every later one.
const REDISCOVER_DEADLINE_MS = 2 * 60 * 1000

// Each check gets a number; only the latest one, within its deadline, may save
// what it found. A check that ran out of time and ends later is dropped, so it
// can't roll back a newer check's values.
let rediscoveryGeneration = 0

function rediscoverJulesApi() {
  if (rediscovery) return rediscovery
  const generation = ++rediscoveryGeneration
  let timer
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      if (rediscoveryGeneration === generation) rediscoveryGeneration++
      reject(new Error('The Jules check took too long. Reload the Jules tab and try again.'))
    }, REDISCOVER_DEADLINE_MS)
  })
  const current = () => rediscoveryGeneration === generation
  rediscovery = Promise.race([discoverJulesApi(current), deadline]).finally(() => {
    clearTimeout(timer)
    rediscovery = null
  })
  return rediscovery
}

async function discoverJulesApi(current = () => true) {
  const [tab] = await getJulesTabs()
  if (!tab) throw new Error('Open a Jules tab first.')
  const frame = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 })
  if (!frame?.url || new URL(frame.url).origin !== JULES_ORIGIN) throw new Error('The Jules tab is not on Jules.')
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, documentIds: [frame.documentId] },
    func: readJulesBundle
  })
  const found = injection?.result
  if (!found?.scripts)
    throw new Error("Could not read the Jules web app's scripts. Reload the Jules tab and try again.")

  if (!current()) throw new Error('A newer Jules check replaced this one.')
  const stored = await chrome.storage.local.get([JULES_API_KEY, JULES_API_LOG_KEY])
  const { api, changes, problems } = applyDiscovery(stored[JULES_API_KEY], found, TASK_STATES)
  api.checkedAt = Date.now()
  const pastLog = Array.isArray(stored[JULES_API_LOG_KEY]) ? stored[JULES_API_LOG_KEY] : []
  const log = [{ at: api.checkedAt, changes, problems }, ...pastLog].slice(0, JULES_API_LOG_MAX)
  if (!current()) throw new Error('A newer Jules check replaced this one.')
  await chrome.storage.local.set({ [JULES_API_KEY]: api, [JULES_API_LOG_KEY]: log })
  // The deadline can pass during the save. A newer check's save lands after
  // this one, so storage ends on its values; memory must not go back either.
  if (!current()) throw new Error('A newer Jules check replaced this one.')
  applyJulesApi(api)
  if (changes.length) console.info('[JTA] Jules API values changed:', changes.join('; '))
  return { api, changes, problems }
}

// Repo picker source for the popup: every connected repo of the first Jules
// tab's account, as sorted "owner/repo" display names.
// Union of every signed-in account's connected repos, one lookup per account.
// An account whose lookup fails is skipped; it only throws if all of them fail.
async function getAllSourceNames() {
  const tabs = keepFirstTabPerAccount(await getJulesTabs())
  if (!tabs.length) return []
  const settled = await Promise.allSettled(tabs.map(async (tab) => listAllSources(await getTabConfig(tab.id))))
  const names = new Set()
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    for (const repo of result.value) names.add(repo.replace(/^github\//, ''))
  }
  const failure = settled.find((result) => result.status === 'rejected')
  if (names.size === 0 && failure) throw failure.reason
  return [...names].sort()
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case 'LOAD_ITEMS':
    case 'LOAD_ARCHIVED':
    case 'APPLY_ACTION': {
      if (_sender.tab) {
        sendResponse({ error: 'Security Error: Unauthorized action from content script' })
        break
      }
      if (state.status === 'running' || startPending) {
        sendResponse({ error: 'A run is already going. Wait for it to finish.' })
        break
      }
      const problem = moreMessageProblem(msg)
      if (problem) {
        sendResponse({ error: problem })
        break
      }
      const ready = Promise.all([stateReadyPromise, settingsReadyPromise, moreItemsReadyPromise]).then(() => {
        if (settingsProblem()) throw new Error(settingsProblem())
      })
      // The archived listing is read-only and slow, so it holds nothing back.
      if (msg.action === 'LOAD_ARCHIVED') {
        ready
          .then(() => loadMoreArchived(msg.loadId, msg.fresh === true))
          .then(sendResponse, (e) => sendResponse({ error: e.message }))
        return true
      }
      startPending = true
      ready
        .then(async () => {
          if (state.status === 'running') throw new Error('A run is already going. Wait for it to finish.')
          if (msg.action === 'LOAD_ITEMS') return loadMoreItems(msg.repo, msg.category, msg.fresh === true)
          startMoreOperation(msg)
          return { ok: true }
        })
        .then(
          (response) => {
            startPending = false
            sendResponse(response)
            // The worker lists the archived tasks of an Archived load by
            // itself: the popup may be closed by then, and the listing takes
            // minutes on a large account.
            if (msg.action === 'LOAD_ITEMS' && msg.category === 'archive') {
              loadMoreArchived(response.loadId, msg.fresh === true).catch(() => {})
            }
          },
          (e) => {
            startPending = false
            sendResponse(e.inView ? { error: e.message, inView: true } : { error: e.message })
          }
        )
      return true
    }

    // The view as the worker holds it: an open popup asks for the items of a
    // view Chrome could not keep (`partial`). Read-only, so a run may go on.
    case 'GET_MORE_VIEW': {
      if (_sender.tab) {
        sendResponse({ error: 'Security Error: Unauthorized action from content script' })
        break
      }
      const problem = moreMessageProblem(msg)
      if (problem) {
        sendResponse({ error: problem })
        break
      }
      moreViewReadyPromise.then(() => sendResponse({ view: moreView }))
      return true
    }

    case 'REDISCOVER_API':
      if (_sender.tab) {
        sendResponse({ error: 'Security Error: Unauthorized action from content script' })
        break
      }
      // New RPC ids mid-run would mix two sets of values in one run.
      if (state.status === 'running') {
        sendResponse({ error: 'A run is going. Rediscover once it finishes.' })
        break
      }
      rediscoverJulesApi()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err.message }))
      return true

    case 'GET_ALL_SOURCES':
      if (_sender.tab) {
        sendResponse({ error: 'Security Error: Unauthorized action from content script' })
        break
      }
      getAllSourceNames()
        .then((repos) => sendResponse({ repos }))
        .catch((err) => {
          console.error('Failed to query all sources:', err)
          sendResponse({ repos: [], error: err.message })
        })
      return true

    case 'HELLO':
      if (_sender.tab) {
        sendResponse({ error: 'Security Error: Unauthorized action from content script' })
        break
      }
      sendResponse({ protocol: RUN_PROTOCOL })
      break

    case 'START': {
      if (_sender.tab) {
        sendResponse({ error: 'Security Error: Unauthorized action from content script' })
        break
      }
      // One run at a time: two runs would read the same daily quota and race
      // each other on the same tasks.
      if (state.status === 'running' || startPending) {
        sendResponse({ error: 'A run is already going. Wait for it to finish.' })
        break
      }
      const problem = startMessageProblem(msg)
      if (problem) {
        sendResponse({ error: problem })
        break
      }
      // Wait for the run state a woken worker restores (restoring it after
      // the run began would mark the run interrupted and let a second START
      // in) and for the task states saved by the last rediscovery, which the
      // item is resolved against.
      startPending = true
      Promise.all([stateReadyPromise, settingsReadyPromise])
        .then(() => {
          if (settingsProblem()) throw new Error(settingsProblem())
          resolveRunOptions(msg.options)
          if (state.status === 'running') throw new Error('A run is already going. Wait for it to finish.')
          startOperation(msg.options)
          sendResponse({ ok: true })
        })
        .catch((e) => sendResponse({ error: e.message }))
        .finally(() => {
          startPending = false
        })
      return true
    }

    case 'GET_STATE':
      if (_sender.tab) {
        sendResponse({ error: 'Security Error: Unauthorized action from content script' })
        break
      }
      stateReadyPromise.then(() => sendResponse(state))
      return true

    case 'CACHE_START_CONFIG':
      try {
        const payload = JSON.stringify(msg.config)
        if (payload.length > 51200) {
          sendResponse({ error: 'Security Error: Payload exceeds size limit' })
          break
        }
      } catch (_e) {
        sendResponse({ error: 'Security Error: Invalid payload' })
        break
      }
      chrome.storage.session.set({ startConfig: msg.config })
      sendResponse({ ok: true })
      break

    case 'RESET':
      if (_sender.tab) {
        sendResponse({ error: 'Security Error: Unauthorized action from content script' })
        break
      }
      prCache.clear()
      stopKeepAlive()
      operationRun++ // the run in flight, if any, stops at its next phase
      state = { ...DEFAULT_STATE }
      chrome.storage.session.set({ archiveState: state })
      sendResponse({ ok: true })
      break

    default:
      break
  }
})

// =============================================================================
// Scheduled Tick Wiring
// =============================================================================

// Optional chaining keeps the script loadable in non-extension contexts where
// these APIs may be absent (e.g. unit-test sandboxes with partial mocks).
chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === API_REDISCOVER_ALARM) {
    if (state.status === 'running' || startPending) return // tomorrow's check will do
    rediscoverJulesApi().catch((e) => console.warn('[JTA] Daily Jules API check skipped:', e.message))
    return
  }
  if (alarm.name !== SCHEDULE_ALARM_NAME) return
  // Fire-and-forget is fine here: a tick that throws still resolves cleanly —
  // startOperation captures failures into state.error for the popup to show.
  runScheduledTick().catch((e) => console.error('[JTA] Scheduled tick failed:', e))
})

// The popup writes schedule settings straight to chrome.storage.sync; the SW
// reacts to those changes here so no message round-trip is needed and the
// alarm stays correct even if the popup is closed mid-change.
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== 'sync') return
  for (const key of Object.keys(DEFAULT_SCHEDULE)) {
    if (key in changes) {
      syncScheduleAlarm().catch((e) => console.error('[JTA] Alarm sync failed:', e))
      return
    }
  }
})

// Reconcile alarm vs config on every SW startup (alarms outlive the worker).
syncScheduleAlarm().catch((e) => console.error('[JTA] Alarm sync failed:', e))

// The daily Jules API check; created once, kept across worker restarts.
Promise.resolve(chrome.alarms?.get?.(API_REDISCOVER_ALARM))
  .then((alarm) => alarm || chrome.alarms?.create?.(API_REDISCOVER_ALARM, { periodInMinutes: 24 * 60 }))
  .catch((e) => console.error('[JTA] Could not schedule the daily Jules API check:', e))
