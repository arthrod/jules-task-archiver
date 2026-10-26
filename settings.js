/**
 * Jules Task Archiver — Settings
 *
 * Shared by background.js, popup.js and the Node tests: the version of the
 * messages between the popup and the background, the Settings panel's values
 * and their limits, and the Jules API values Google can change (RPC ids,
 * archive batch sizes, task states) with the parser that rediscovers them
 * from the Jules web bundle.
 */

// Chrome reads the popup's files from disk each time it opens, but keeps the
// service worker it started until the extension is reloaded. On 2026-10-19 an
// old worker read a new popup's "Proceed: Waiting on You" as "archive every
// task" and archived 65 of them. So the popup asks the background for its
// RUN_PROTOCOL before every run, and the background refuses a START with
// another protocol or an option it doesn't know. Bump RUN_PROTOCOL whenever a
// message between the two changes meaning.
const RUN_PROTOCOL = 8
// What the popup says when a More Actions list Chrome could not keep in its
// session storage (background.js `moreView`, `partial`) can't be given back.
const MORE_VIEW_TOO_LARGE = 'Chrome could not keep a list this large. Load again.'
// Every option the popup may put in a START message.
const START_OPTION_KEYS = [
  'action',
  'items',
  'dryRun',
  'force',
  'message',
  'oneSession',
  'scope',
  'activeTabId',
  'repoFilter'
]

const SETTINGS_KEY = 'settings' // chrome.storage.sync
// chrome.storage.sync allows 8 KB per item, which two 2,000-character
// messages can pass once JSON-escaped, so each message has its own key.
const SETTINGS_TEXT_FIELDS = ['defaultReply', 'defaultRetry']
// The old popup's two reply boxes; read until the popup saves the settings.
const LEGACY_MESSAGE_KEYS = { defaultReply: 'continueMessage', defaultRetry: 'continueErrorMessage' }
const SETTINGS_SYNC_KEYS = [SETTINGS_KEY, ...SETTINGS_TEXT_FIELDS, ...Object.values(LEGACY_MESSAGE_KEYS)]
const JULES_API_KEY = 'julesApi' // chrome.storage.local
const JULES_API_LOG_KEY = 'julesApiLog' // chrome.storage.local
const JULES_API_LOG_MAX = 20

const DEFAULT_CONTINUE_MESSAGE =
  'Please continue. Use your best judgment on any open questions and keep going without waiting for me.'
const DEFAULT_ERROR_CONTINUE_MESSAGE =
  'Your previous run stopped with an error before the task was finished. Please pick it back up: find the step ' +
  'that failed and retry it. If it keeps failing, work around it (for example, carry on without a broken optional ' +
  'dependency or git submodule) and note what you skipped. Then finish the original task.'
const MAX_MESSAGE_LEN = 2000

// Requests sent many at once (a burst) each wait a random delay in this range
// first, so they don't reach Jules in lockstep. Built in, not a setting.
const BURST_JITTER_MIN_MS = 500
const BURST_JITTER_MAX_MS = 2000

// [min, max, default] for each number in the Settings panel.
const SETTING_LIMITS = {
  requestTimeoutSec: [5, 600, 30],
  listTimeoutSec: [30, 1800, 300],
  extraJitterMaxSec: [1, 300, 10],
  perAccountParallel: [1, 20, 6],
  totalParallel: [1, 50, 12],
  runLimit: [0, 100000, 0] // 0 = no limit
}

const DEFAULT_SETTINGS = {
  requestTimeoutSec: 30,
  listTimeoutSec: 300,
  extraJitter: false,
  extraJitterMaxSec: 10,
  perAccountParallel: 6,
  totalParallel: 12,
  runLimit: 0,
  defaultReply: '',
  defaultRetry: '',
  reloadTabOnSignIn: true
}

function normalizeMessage(value) {
  const message = typeof value === 'string' ? value.trim() : ''
  return message.slice(0, MAX_MESSAGE_LEN)
}

// An empty field means "use the default"; anything else is rounded and
// clamped into its range.
function clampSetting(value, [min, max, fallback]) {
  if (value === '' || value === null || value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const [key, limits] of Object.entries(SETTING_LIMITS)) out[key] = clampSetting(src[key], limits)
  out.extraJitter = src.extraJitter === true
  out.reloadTabOnSignIn = src.reloadTabOnSignIn !== false
  out.defaultReply = normalizeMessage(src.defaultReply)
  out.defaultRetry = normalizeMessage(src.defaultRetry)
  return out
}

// The settings from chrome.storage.sync (the SETTINGS_SYNC_KEYS values).
function settingsFromSync(data) {
  const src = data && typeof data === 'object' ? data : {}
  const raw = src[SETTINGS_KEY] && typeof src[SETTINGS_KEY] === 'object' ? { ...src[SETTINGS_KEY] } : {}
  for (const field of SETTINGS_TEXT_FIELDS) {
    if (typeof src[field] === 'string') raw[field] = src[field]
    if (!normalizeMessage(raw[field])) raw[field] = src[LEGACY_MESSAGE_KEYS[field]]
  }
  return normalizeSettings(raw)
}

// What to write to chrome.storage.sync for these settings.
function settingsToSync(values) {
  const normalized = normalizeSettings(values)
  const out = { [SETTINGS_KEY]: { ...normalized } }
  for (const field of SETTINGS_TEXT_FIELDS) {
    delete out[SETTINGS_KEY][field]
    out[field] = normalized[field]
  }
  return out
}

// =============================================================================
// Jules API values
// =============================================================================

const JULES_SERVICE = 'SweBotService'

// Method -> RPC id, as read from the Jules bundle on 2026-10-19.
const JULES_RPC_DEFAULTS = {
  ListTasks: 'p1Takd',
  ArchiveTasks: 'Tjmm5c',
  ResumeTask: 'wk4vKd',
  PauseTask: 'tqq5v',
  ListScheduledTasks: 'hvmRxc',
  PauseScheduledTask: 'gBUOb',
  ResumeScheduledTask: 'XuzQWe',
  DeleteScheduledTask: 'sL8twb',
  DeleteTasks: 'rist8',
  GetTask: 'n74qPd',
  Interact: 'SLmX6',
  GetTaskUsage: 'KQOO7',
  CreateTask: 'Rja83d',
  ListSources: 'YqkSHd',
  ListProactiveSuggestions: 'hQP40d',
  UpdateProactiveSuggestionStatus: 'sc1vFf'
}

const RPC_ID_REGEX = /^[A-Za-z0-9]{5,6}$/

// The first two methods sharing an id, as [earlier, later, id], or null. A shared
// id sends one method's request for the other: Delete permanently would archive,
// or Archive would delete.
function rpcCollision(rpc) {
  const owner = new Map()
  for (const name of Object.keys(JULES_RPC_DEFAULTS)) {
    const id = rpc[name]
    if (owner.has(id)) return [owner.get(id), name, id]
    owner.set(id, name)
  }
  return null
}

// Every id more than one method has, as [id, [methods]] in JULES_RPC_DEFAULTS order.
function rpcSharedIds(rpc) {
  const byId = new Map()
  for (const name of Object.keys(JULES_RPC_DEFAULTS)) byId.set(rpc[name], [...(byId.get(rpc[name]) || []), name])
  return [...byId].filter(([, methods]) => methods.length > 1)
}

// 'A and B', 'A, B and C'.
function joinNames(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

// ArchiveTasks takes this many ids per call; a rejected batch is retried in
// chunks of archiveSplit (see background.js executeArchive).
const ARCHIVE_LIMITS = {
  archiveBatch: [1, 200, 50],
  archiveSplit: [1, 200, 10]
}

const STATE_KINDS = new Set(['feedback', 'plan', 'error', 'paused', 'running', 'completed', 'unknown'])

// `states: null` means the built-in TASK_STATES (items.js). `inDoubt` names the
// methods a rediscovery found sharing an id; background.js sends none of them.
const JULES_API_DEFAULTS = {
  rpc: JULES_RPC_DEFAULTS,
  archiveBatch: 50,
  archiveSplit: 10,
  states: null,
  checkedAt: null,
  inDoubt: []
}

function validStates(states) {
  if (!Array.isArray(states) || states.length === 0 || states.length > 40) return false
  const codes = new Set()
  for (const s of states) {
    if (!s || !Number.isInteger(s.code) || s.code < 0 || s.code > 999 || codes.has(s.code)) return false
    if (typeof s.name !== 'string' || !s.name || s.name.length > 40 || !STATE_KINDS.has(s.kind)) return false
    codes.add(s.code)
  }
  return true
}

function normalizeJulesApi(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const rpc = {}
  for (const [method, fallback] of Object.entries(JULES_RPC_DEFAULTS)) {
    const id = src.rpc?.[method]
    rpc[method] = typeof id === 'string' && RPC_ID_REGEX.test(id) ? id : fallback
  }
  const archiveBatch = clampSetting(src.archiveBatch, ARCHIVE_LIMITS.archiveBatch)
  const archiveSplit = Math.min(archiveBatch, clampSetting(src.archiveSplit, ARCHIVE_LIMITS.archiveSplit))
  return {
    rpc: rpcCollision(rpc) ? { ...JULES_RPC_DEFAULTS } : rpc,
    archiveBatch,
    archiveSplit,
    states: validStates(src.states) ? src.states.map((s) => ({ code: s.code, name: s.name, kind: s.kind })) : null,
    checkedAt: Number.isFinite(src.checkedAt) ? src.checkedAt : null,
    inDoubt: Array.isArray(src.inDoubt)
      ? [...new Set(src.inDoubt.filter((m) => typeof m === 'string' && Object.hasOwn(JULES_RPC_DEFAULTS, m)))]
      : []
  }
}

// The bundle's labels for ListTasks row[5], mapped to the dropdown's names and
// to what Proceed does with the state.
const BUNDLE_STATE_LABELS = {
  'awaiting user feedback': { name: 'Waiting on You', kind: 'feedback' },
  'awaiting plan approval': { name: 'Awaiting Plan Approval', kind: 'plan' },
  error: { name: 'Error', kind: 'error' },
  paused: { name: 'Paused', kind: 'paused' },
  'in progress': { name: 'In Progress', kind: 'running' },
  planning: { name: 'Planning', kind: 'running' },
  queued: { name: 'Queued', kind: 'running' },
  'queued restart': { name: 'Queued Restart', kind: 'running' },
  completed: { name: 'Completed', kind: 'completed' },
  unknown: { name: 'Unknown', kind: 'unknown' }
}

const KIND_ORDER = ['feedback', 'plan', 'error', 'paused', 'running', 'completed', 'unknown']
const RUNNING_ORDER = ['In Progress', 'Planning', 'Queued', 'Queued Restart']

// Dropdown order: Waiting on You, Plan Approval, Error, Paused, the running
// states, Completed, then Unknown and anything Jules added that we don't know.
function sortStates(states) {
  const rank = (s) => {
    const running = RUNNING_ORDER.indexOf(s.name)
    return KIND_ORDER.indexOf(s.kind) * 100 + (running >= 0 ? running : 50)
  }
  return [...states].sort((a, b) => rank(a) - rank(b) || a.code - b.code)
}

function titleCase(label) {
  return label.replace(/\b\w/g, (c) => c.toUpperCase())
}

// The bundle holds several [[0,"Unknown"],...] maps. The row[5] one is the
// map with both "Awaiting user feedback" and "Planning" (the row[25] enum has
// no Planning).
function pickStateMap(stateMaps) {
  const candidates = (stateMaps || []).filter((entries) => {
    if (!Array.isArray(entries)) return false
    const labels = new Set(entries.map((e) => String(e?.[1]).toLowerCase()))
    return labels.has('awaiting user feedback') && labels.has('planning')
  })
  return candidates.length === 1 ? candidates[0] : null
}

function statesFromBundle(entries) {
  const states = []
  for (const [code, label] of entries) {
    if (!Number.isInteger(code) || typeof label !== 'string') continue
    const known = BUNDLE_STATE_LABELS[label.toLowerCase()]
    states.push(known ? { code, ...known } : { code, name: titleCase(label).slice(0, 40), kind: 'unknown' })
  }
  return sortStates(states)
}

function describeState(s) {
  return `${s.name} (${s.code})`
}

// Compares two state tables by code; returns readable changes.
function diffStates(before, after) {
  const changes = []
  const old = new Map(before.map((s) => [s.code, s]))
  const now = new Map(after.map((s) => [s.code, s]))
  for (const s of after) {
    const was = old.get(s.code)
    if (!was) changes.push(`state ${s.code} added: ${s.name}`)
    else if (was.name !== s.name || was.kind !== s.kind) changes.push(`state ${s.code}: ${was.name} → ${s.name}`)
  }
  for (const s of before) if (!now.has(s.code)) changes.push(`state removed: ${describeState(s)}`)
  return changes
}

function sameStates(a, b) {
  return a.length === b.length && diffStates(a, b).length === 0
}

/**
 * Merges what scanJulesBundle (background.js) found into the current values.
 * `found` = { rpc: [[rpcId, "Service.Method"], ...], stateMaps: [[[code, label], ...], ...] }.
 * `builtInStates` is items.js's TASK_STATES. Returns { api, changes, problems };
 * when the bundle doesn't look as expected, nothing changes.
 */
function applyDiscovery(current, found, builtInStates) {
  const api = normalizeJulesApi(current)
  const changes = []
  const problems = []

  const ids = new Map()
  const ambiguous = new Set()
  for (const pair of found?.rpc || []) {
    const [id, method] = Array.isArray(pair) ? pair : []
    if (typeof id !== 'string' || !RPC_ID_REGEX.test(id) || typeof method !== 'string') continue
    if (ids.has(method) && ids.get(method) !== id) ambiguous.add(method)
    ids.set(method, id)
  }

  const names = Object.keys(JULES_RPC_DEFAULTS)
  const rpc = { ...api.rpc }
  let matched = 0
  for (const name of names) {
    const method = `${JULES_SERVICE}.${name}`
    if (ambiguous.has(method)) {
      problems.push(`${name} has more than one id in the bundle; keeping ${rpc[name]}`)
      continue
    }
    const id = ids.get(method)
    if (!id) {
      problems.push(`${name} not found; keeping ${rpc[name]}`)
      continue
    }
    matched++
    if (id !== rpc[name]) {
      changes.push(`${name}: ${rpc[name]} → ${id}`)
      rpc[name] = id
    }
  }
  if (matched < Math.ceil(names.length / 2)) {
    return {
      api,
      changes: [],
      problems: [
        `The Jules bundle didn't look as expected (found ${matched} of ${names.length} RPCs); nothing changed.`
      ]
    }
  }
  // A method the bundle no longer names keeps its old id, which may now be another
  // method's. Which one Jules means is unknown, so none of them is sent. Every
  // shared id counts, and earlier doubts stay: nothing here settles them.
  const shared = rpcSharedIds(rpc)
  if (shared.length) {
    const doubted = new Set([...api.inDoubt, ...shared.flatMap(([, methods]) => methods)])
    return {
      api: { ...api, inDoubt: names.filter((name) => doubted.has(name)) },
      changes: [],
      problems: shared.map(
        ([id, methods]) =>
          `${joinNames(methods)} would share ${id}; nothing changed, and ${methods.length === 2 ? 'both' : 'all'} ` +
          'stay off until a rediscovery agrees or you reset the values.'
      )
    }
  }

  let states = api.states
  const entries = pickStateMap(found?.stateMaps)
  if (!entries) {
    problems.push('Task state map not found; keeping the current states.')
  } else {
    const discovered = statesFromBundle(entries)
    if (!validStates(discovered)) {
      problems.push("The bundle's task states didn't look as expected; keeping the current states.")
    } else {
      const before = api.states || builtInStates
      changes.push(...diffStates(before, discovered))
      for (const s of discovered) {
        if (s.kind === 'unknown' && s.name !== 'Unknown') {
          problems.push(`New state ${describeState(s)}: Proceed leaves it alone unless you add a message.`)
        }
      }
      // Back to the built-in table when Jules matches it again.
      states = sameStates(discovered, builtInStates) ? null : discovered
    }
  }

  return { api: { ...api, rpc, states, inDoubt: [] }, changes, problems }
}

if (typeof module !== 'undefined') {
  module.exports = {
    RUN_PROTOCOL,
    MORE_VIEW_TOO_LARGE,
    START_OPTION_KEYS,
    SETTINGS_KEY,
    SETTINGS_TEXT_FIELDS,
    LEGACY_MESSAGE_KEYS,
    SETTINGS_SYNC_KEYS,
    JULES_API_KEY,
    JULES_API_LOG_KEY,
    JULES_API_LOG_MAX,
    DEFAULT_CONTINUE_MESSAGE,
    DEFAULT_ERROR_CONTINUE_MESSAGE,
    MAX_MESSAGE_LEN,
    BURST_JITTER_MIN_MS,
    BURST_JITTER_MAX_MS,
    SETTING_LIMITS,
    DEFAULT_SETTINGS,
    JULES_RPC_DEFAULTS,
    JULES_API_DEFAULTS,
    normalizeMessage,
    clampSetting,
    normalizeSettings,
    settingsFromSync,
    settingsToSync,
    normalizeJulesApi,
    rpcCollision,
    validStates,
    statesFromBundle,
    pickStateMap,
    diffStates,
    applyDiscovery
  }
}
