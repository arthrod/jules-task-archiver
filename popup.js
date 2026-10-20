// Modified by tommyzed: Added repository selector and suggestions
/**
 * Jules Task Archiver — Popup Script
 *
 * The Items dropdown with Proceed and Archive, settings persistence and
 * progress display. items.js (loaded first) provides the dropdown entries and
 * settings.js the Settings panel's defaults and limits.
 */

const $ = (sel) => document.querySelector(sel)

// Match the HTML `maxlength` bounds on #ghOwner / #ghToken (popup.html) so
// storage writes stay bounded even if `.value` is set programmatically
// (devtools, extension context) and bypasses the input's typing limit.
const MAX_OWNER_LEN = 39
const MAX_TOKEN_LEN = 255
const JULES_TABS_URL = 'https://jules.google.com/*'
const SCHEDULE_ALARM_NAME = 'jta-scheduled-tick'

// --- DOM refs ---
const itemsBtn = $('#itemsBtn')
const itemsBtnText = $('#itemsBtnText')
const itemsMenu = $('#itemsMenu')
const dryRunInput = $('#dryRun')
const forceInput = $('#force')
const addMessageInput = $('#addMessage')
const messageInput = $('#message')
const messageHint = $('#messageHint')
const oneSessionRow = $('#oneSessionRow')
const oneSessionInput = $('#oneSession')
const proceedBtn = $('#proceedBtn')
const archiveBtn = $('#archiveBtn')
const exportBtn = $('#exportBtn')
const ghOwnerInput = $('#ghOwner')
const ghTokenInput = $('#ghToken')
const repoFilterInput = $('#repoFilter')
const customRepoInput = $('#customRepoInput')
const resetBtn = $('#resetBtn')
const downloadBtn = $('#downloadBtn')
const logStatus = $('#logStatus')
const idleText = $('#idleText')
const currentInfo = $('#currentInfo')
const progressFill = $('#progressFill')
const logPre = $('#log')
const summarySection = $('#summarySection')
const summaryDiv = $('#summary')
const tabStatus = $('#tabStatus')
const tabStatusText = $('#tabStatusText')
const settingsToggle = $('#settingsToggle')
const scheduleToggle = $('#scheduleToggle')
const settingsPanel = $('#settingsPanel')
const schedulePanel = $('#schedulePanel')
const moreToggle = $('#moreToggle')
const morePanel = $('#morePanel')
const moreAll = $('#moreAll')
const moreRepoScope = $('#moreRepoScope')
const moreRepo = $('#moreRepo')
const moreCategorySelect = $('#moreCategory')
const moreLoad = $('#moreLoad')
const moreRefresh = $('#moreRefresh')
const moreStatus = $('#moreStatus')
const moreChips = $('#moreChips')
const moreList = $('#moreList')
const moreSelectAll = $('#moreSelectAll')
const moreDryRun = $('#moreDryRun')
const moreForce = $('#moreForce')
const moreAction = $('#moreAction')
const moreConfirm = $('#moreConfirm')
const mainView = $('#mainView')
const staleBanner = $('#staleBanner')

// --- Schedule settings (read by background.js's chrome.alarms tick) ---
const schedEnabledInput = $('#schedEnabled')
const schedIntervalInput = $('#schedInterval')
const schedSuggestionsInput = $('#schedSuggestions')
const schedMaxStartsInput = $('#schedMaxStarts')
const schedNext = $('#schedNext')

// Run state. Declared up front: Chrome calls the storage callbacks below
// asynchronously, but nothing guarantees it.
let runningAction = null
let lastExportData = null
// The background runs other code than this popup; nothing may start.
let backgroundStale = false
// The worker answered HELLO with this popup's protocol. The schedule waits
// for it: an old worker would act on a schedule change with its own rules.
let backgroundOk = false
let moreLoading = false
let loadedMoreItems = []
let selectedMoreItems = new Set()
let moreCategory = 'all'
// What the last Load listed: 'all', 'scheduled', 'complete' or 'archive'.
let moreLoadedCategory = null
// The worker's id for the last Load; the archived tasks come in a second
// answer, which a newer Load makes stale. moreArchived: 'none', 'loading',
// 'done' or 'failed'.
let moreLoadId = null
let moreArchived = 'none'
// How many repos the worker's All-repos archived listing has done: { done, total }.
let moreArchivedRepos = null
let moreNotes = []
// When the oldest cached list of the shown load was read; null when all of it is live.
let moreCachedAt = null
// Delete permanently and Delete schedule can't be undone, so their Confirm
// takes a second click, at least 0.5 s after the first (a double-click is one
// gesture) and at most 10 s after it. A held key's repeats never press
// Confirm, and a change of action, selection or Dry run takes the first
// click back.
const DELETE_CONFIRM_MIN_MS = 500
const DELETE_CONFIRM_MAX_MS = 10000
let moreDeleteArmedAt = null
let moreDeleteTimer = null

// Storage-side bounds match background.js; the background re-validates anyway,
// these just keep obviously-bad values out of sync storage.
function readClampedNumber(input, min, max, fallback) {
  const n = Number.parseInt(input?.value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

// =============================================================================
// Items dropdown
// =============================================================================

let ITEMS = listItems()
let selectedItemId = ITEM_ALL
// A saved item the current task states don't have: a rediscovered state
// whose table hasn't loaded yet, or one Jules dropped. Nothing is selected
// meanwhile, because falling back to All would widen the next run.
let missingItemId = null
let activeOptionIndex = -1
let optionEls = []

function getSelectedItem() {
  return ITEMS.find((i) => i.id === selectedItemId) || null
}

function itemKind(item) {
  if (item.type === 'suggestions') return 'suggestions'
  if (item.codes === null) return 'all'
  return getTaskStates().find((s) => s.code === item.code)?.kind || 'unknown'
}

// What the message does for the chosen item, shown under the message box.
// The message is always added after the text the extension sends itself, or
// sent on its own where the extension sends nothing.
const MESSAGE_HINTS = {
  all: 'Added after the default reply and retry prompt, and sent on its own to running sessions.',
  feedback: 'Added after the default reply.',
  plan: "Plans are approved; an approval can't carry a message.",
  paused: "Paused sessions are resumed; a resume can't carry a message.",
  running: 'Sent to each running session. Without a message, running sessions are left alone.',
  error: 'Added after the default retry prompt. A retry starts a new run and uses daily quota.',
  completed: 'Sent as a follow-up. Each one starts a new run and uses daily quota.',
  unknown: 'Sent to each session. Without a message, these are left alone.',
  suggestions: "Added after each suggestion's prompt."
}

function optionDomId(item) {
  return `item-${item.id.replace(/[^a-z0-9]/gi, '-')}`
}

function renderItemsMenu() {
  itemsMenu.textContent = ''
  optionEls = []
  let groupEl = null
  let groupName = null
  for (const item of ITEMS) {
    if (item.group !== groupName) {
      groupName = item.group
      groupEl = document.createElement('div')
      groupEl.setAttribute('role', 'group')
      const heading = document.createElement('div')
      heading.className = 'grp'
      heading.id = `items-group-${groupName.toLowerCase()}`
      heading.setAttribute('role', 'presentation')
      heading.textContent = groupName
      groupEl.setAttribute('aria-labelledby', heading.id)
      groupEl.appendChild(heading)
      itemsMenu.appendChild(groupEl)
    }
    const opt = document.createElement('div')
    opt.className = 'opt'
    opt.id = optionDomId(item)
    opt.setAttribute('role', 'option')
    opt.setAttribute('aria-label', item.label)
    opt.setAttribute('aria-selected', String(item.id === selectedItemId))
    opt.dataset.id = item.id
    const name = document.createElement('span')
    name.textContent = item.name || item.label
    opt.appendChild(name)
    if (item.code !== undefined) {
      const code = document.createElement('span')
      code.className = 'n'
      code.setAttribute('aria-hidden', 'true')
      code.textContent = String(item.code)
      opt.appendChild(code)
    }
    opt.addEventListener('click', () => {
      selectItem(item.id)
      closeItemsMenu(true)
    })
    groupEl.appendChild(opt)
    optionEls.push(opt)
  }
}

function selectItem(id, { save = true } = {}) {
  if (!ITEMS.some((i) => i.id === id)) return
  missingItemId = null
  selectedItemId = id
  showSelectedItem()
  if (save) chrome.storage.sync.set({ item: id })
}

// Selects a saved item, or nothing while the task states lack it.
function restoreItem(id) {
  if (ITEMS.some((i) => i.id === id)) {
    selectItem(id, { save: false })
    return
  }
  missingItemId = id
  selectedItemId = null
  showSelectedItem()
}

function showSelectedItem() {
  const item = getSelectedItem()
  itemsBtnText.textContent = item ? item.label : 'Choose an item'
  for (const opt of optionEls) {
    const selected = opt.dataset.id === selectedItemId
    opt.setAttribute('aria-selected', String(selected))
    opt.classList.toggle('cur', selected)
  }
  updateItemUI()
  updateRunButtons()
}

function updateItemUI() {
  const item = getSelectedItem()
  oneSessionRow.classList.toggle('hidden', item?.type !== 'suggestions')
  messageHint.textContent = item ? MESSAGE_HINTS[itemKind(item)] : ''
}

function setActiveOption(index) {
  if (optionEls.length === 0) return
  activeOptionIndex = (index + optionEls.length) % optionEls.length
  optionEls.forEach((opt, i) => {
    opt.classList.toggle('active', i === activeOptionIndex)
  })
  const active = optionEls[activeOptionIndex]
  itemsMenu.setAttribute('aria-activedescendant', active.id)
  active.scrollIntoView?.({ block: 'nearest' })
}

// The menu must end inside the popup (past its bottom edge the popup would
// grow or scroll), so a list longer than the room scrolls inside the menu.
function fitMenuToPopup() {
  const bottom = document.body?.getBoundingClientRect?.().bottom
  const top = itemsBtn.getBoundingClientRect?.().bottom
  if (!itemsMenu.style || !Number.isFinite(bottom) || !Number.isFinite(top)) return
  itemsMenu.style.maxHeight = `${Math.max(160, Math.floor(bottom - top - 8))}px`
}

function openItemsMenu() {
  fitMenuToPopup()
  itemsBtn.setAttribute('aria-expanded', 'true')
  itemsBtn.classList.add('open')
  itemsMenu.classList.add('open')
  setActiveOption(
    Math.max(
      0,
      ITEMS.findIndex((i) => i.id === selectedItemId)
    )
  )
  itemsMenu.focus()
}

function closeItemsMenu(returnFocus) {
  itemsBtn.setAttribute('aria-expanded', 'false')
  itemsBtn.classList.remove('open')
  itemsMenu.classList.remove('open')
  itemsMenu.removeAttribute('aria-activedescendant')
  if (returnFocus) itemsBtn.focus()
}

function isItemsMenuOpen() {
  return itemsBtn.getAttribute('aria-expanded') === 'true'
}

itemsBtn.addEventListener('click', () => {
  if (isItemsMenuOpen()) closeItemsMenu(true)
  else openItemsMenu()
})

itemsBtn.addEventListener('keydown', (e) => {
  if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
    e.preventDefault()
    openItemsMenu()
  }
})

itemsMenu.addEventListener('keydown', (e) => {
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      setActiveOption(activeOptionIndex + 1)
      break
    case 'ArrowUp':
      e.preventDefault()
      setActiveOption(activeOptionIndex - 1)
      break
    case 'Home':
      e.preventDefault()
      setActiveOption(0)
      break
    case 'End':
      e.preventDefault()
      setActiveOption(optionEls.length - 1)
      break
    case 'Enter':
    case ' ':
      e.preventDefault()
      selectItem(optionEls[activeOptionIndex].dataset.id)
      closeItemsMenu(true)
      break
    case 'Escape':
      e.preventDefault()
      closeItemsMenu(true)
      break
    case 'Tab':
      closeItemsMenu(false)
      break
    default:
      break
  }
})

document.addEventListener?.('click', (e) => {
  if (isItemsMenuOpen() && !itemsBtn.contains(e.target) && !itemsMenu.contains(e.target)) closeItemsMenu(false)
})

renderItemsMenu()

// Rebuilds the dropdown when the Jules API values bring a new state table.
function applyTaskStates(states) {
  setTaskStates(states)
  ITEMS = listItems()
  renderItemsMenu()
  restoreItem(missingItemId ?? selectedItemId)
}
selectItem(ITEM_ALL, { save: false })

// =============================================================================
// Message box
// =============================================================================

function updateMessageBox() {
  messageInput.disabled = !addMessageInput.checked
}

addMessageInput.addEventListener('change', () => {
  updateMessageBox()
  if (addMessageInput.checked) messageInput.focus()
})

// Saved shortly after typing stops (sync storage limits writes per minute), and
// at once on change, so closing the popup mid-sentence keeps the text.
let messageSaveTimer = null
function saveMessage() {
  clearTimeout(messageSaveTimer)
  chrome.storage.sync.set({ message: messageInput.value.trim().slice(0, MAX_MESSAGE_LEN) })
}
messageInput.addEventListener('input', () => {
  clearTimeout(messageSaveTimer)
  messageSaveTimer = setTimeout(saveMessage, 400)
})
messageInput.addEventListener('change', saveMessage)

// --- Settings / Schedule: side-by-side toggles in the header. An open panel
// takes the place of the controls and log, one panel at a time, so the popup
// never needs to scroll. ---
const PANELS = [
  [settingsToggle, settingsPanel],
  [scheduleToggle, schedulePanel],
  [moreToggle, morePanel]
]
function togglePanel(toggle) {
  let anyOpen = false
  for (const [btn, panel] of PANELS) {
    const open = btn === toggle && btn.getAttribute('aria-expanded') !== 'true'
    btn.setAttribute('aria-expanded', String(open))
    panel.classList.toggle('hidden', !open)
    anyOpen ||= open
  }
  mainView.classList.toggle('hidden', anyOpen)
}
for (const [btn] of PANELS) btn.addEventListener('click', () => togglePanel(btn))

// --- Tooltips: Escape hides an open one until the pointer or focus leaves ---
const tips = document.querySelectorAll('.tip')
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') for (const tip of tips) tip.classList.add('tip-off')
})
for (const tip of tips) {
  tip.addEventListener('mouseleave', () => tip.classList.remove('tip-off'))
  tip.addEventListener('focusout', () => tip.classList.remove('tip-off'))
}

dryRunInput.addEventListener('change', () => {
  if (!isRunning()) showIdle()
})

// =============================================================================
// Settings panel (settings.js holds the defaults and limits)
// =============================================================================

const SETTING_NUMBERS = Object.keys(SETTING_LIMITS)
const SETTING_CHECKS = ['extraJitter', 'reloadTabOnSignIn']
const SETTING_TEXTS = ['defaultReply', 'defaultRetry']
const settingInputs = Object.fromEntries(
  [...SETTING_NUMBERS, ...SETTING_CHECKS, ...SETTING_TEXTS].map((key) => [key, $(`#${key}`)])
)
$('#defaultReply').placeholder = DEFAULT_CONTINUE_MESSAGE
$('#defaultRetry').placeholder = DEFAULT_ERROR_CONTINUE_MESSAGE

function fillSettings(values) {
  for (const key of SETTING_NUMBERS) settingInputs[key].value = String(values[key])
  for (const key of SETTING_CHECKS) settingInputs[key].checked = values[key]
  for (const key of SETTING_TEXTS) {
    if (document.activeElement !== settingInputs[key]) settingInputs[key].value = values[key]
  }
  settingInputs.extraJitterMaxSec.disabled = !values.extraJitter
}

function readSettings() {
  const raw = {}
  for (const key of SETTING_NUMBERS) raw[key] = settingInputs[key].value.trim()
  for (const key of SETTING_CHECKS) raw[key] = settingInputs[key].checked
  for (const key of SETTING_TEXTS) raw[key] = settingInputs[key].value
  return normalizeSettings(raw)
}

const settingsStatus = $('#settingsStatus')
let settingsSaveTimer = null
// The old popup's reply boxes are still in sync storage until a save lands.
let legacyMessagesStored = false

function writeSettings(values) {
  chrome.storage.sync.set(settingsToSync(values), () => {
    const error = chrome.runtime.lastError
    settingsStatus.textContent = error ? `Settings not saved: ${error.message}` : ''
    settingsStatus.classList.toggle('hidden', !error)
    if (error || !legacyMessagesStored) return
    legacyMessagesStored = false
    chrome.storage.sync.remove(Object.values(LEGACY_MESSAGE_KEYS))
  })
}

function saveSettings() {
  clearTimeout(settingsSaveTimer)
  const values = readSettings()
  fillSettings(values)
  writeSettings(values)
}

// The old popup kept its two reply boxes under their own keys; they become
// the default reply and retry (settingsFromSync), saved under the new keys.
function loadSettings(syncData) {
  const values = settingsFromSync(syncData)
  fillSettings(values)
  legacyMessagesStored = Object.values(LEGACY_MESSAGE_KEYS).some((key) => syncData[key] !== undefined)
  if (legacyMessagesStored) writeSettings(values)
}

for (const key of [...SETTING_NUMBERS, ...SETTING_CHECKS]) settingInputs[key].addEventListener('change', saveSettings)
for (const key of SETTING_TEXTS) {
  // Saved shortly after typing stops, like the message box.
  settingInputs[key].addEventListener('input', () => {
    clearTimeout(settingsSaveTimer)
    settingsSaveTimer = setTimeout(saveSettings, 400)
  })
  settingInputs[key].addEventListener('change', saveSettings)
}

// --- Jules API values (chrome.storage.local) ---
// Short names for the methods, in the order of JULES_RPC_DEFAULTS.
const RPC_LABELS = {
  ListTasks: 'List tasks',
  ArchiveTasks: 'Archive',
  ResumeTask: 'Resume',
  PauseTask: 'Pause',
  ListScheduledTasks: 'List schedules',
  PauseScheduledTask: 'Pause schedule',
  ResumeScheduledTask: 'Resume schedule',
  DeleteScheduledTask: 'Delete schedule',
  DeleteTasks: 'Delete task',
  GetTask: 'Get task',
  Interact: 'Reply',
  GetTaskUsage: 'Daily quota',
  CreateTask: 'Start session',
  ListSources: 'List repos',
  ListProactiveSuggestions: 'Suggestions',
  UpdateProactiveSuggestionStatus: 'Dismiss'
}
const rpcInputsEl = $('#rpcInputs')
const archiveBatchInput = $('#archiveBatch')
const archiveSplitInput = $('#archiveSplit')
const apiStatesEl = $('#apiStates')
const apiStatusEl = $('#apiStatus')
const rediscoverBtn = $('#rediscoverBtn')
const resetApiBtn = $('#resetApiBtn')
const rpcInputs = {}
let julesApiValues = normalizeJulesApi()

for (const method of Object.keys(JULES_RPC_DEFAULTS)) {
  const label = document.createElement('label')
  const name = document.createElement('span')
  name.textContent = RPC_LABELS[method] || method
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'mono-in'
  input.maxLength = 6
  input.pattern = '[A-Za-z0-9]{5,6}'
  input.spellcheck = false
  input.autocomplete = 'off'
  input.title = `SweBotService.${method}`
  input.setAttribute('aria-label', `RPC id for ${method}`)
  input.addEventListener('change', saveJulesApi)
  label.appendChild(name)
  label.appendChild(input)
  rpcInputsEl.appendChild(label)
  rpcInputs[method] = input
}

function formatCheck(at) {
  return new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

function fillJulesApi(api, log) {
  julesApiValues = api
  for (const [method, input] of Object.entries(rpcInputs)) input.value = api.rpc[method]
  archiveBatchInput.value = String(api.archiveBatch)
  archiveSplitInput.value = String(api.archiveSplit)
  const states = api.states ? `from Jules, ${api.states.length} codes` : `built-in, ${TASK_STATES.length} codes`
  const checked = api.checkedAt ? `last checked ${formatCheck(api.checkedAt)}` : 'not checked yet'
  apiStatesEl.textContent = `Task states: ${states} · ${checked}`
  const last = Array.isArray(log) ? log[0] : null
  if (last && !apiStatusEl.dataset.busy) showDiscovery(last)
  applyTaskStates(api.states)
}

function setApiStatus(text, details = '') {
  apiStatusEl.textContent = text
  apiStatusEl.title = details
}

// A short summary in the panel (clamped to three lines), the full report in
// the tooltip: a reshaped bundle can report a dozen changes and problems.
function showDiscovery({ changes = [], problems = [] }) {
  const parts = []
  if (!changes.length) parts.push('No changes.')
  else if (changes.length <= 2) parts.push(`Changed: ${changes.join('; ')}.`)
  else parts.push(`Changed: ${changes.slice(0, 2).join('; ')} and ${changes.length - 2} more.`)
  if (problems.length === 1) parts.push(problems[0])
  if (problems.length > 1) parts.push(`${problems.length} problems; hover for details.`)
  const full = [changes.length ? `Changed: ${changes.join('; ')}` : 'No changes.', ...problems].join('\n')
  setApiStatus(parts.join(' '), full)
}

function saveJulesApi() {
  const rpc = {}
  for (const [method, input] of Object.entries(rpcInputs)) {
    const id = input.value.trim()
    if (!RPC_ID_REGEX.test(id)) {
      input.value = julesApiValues.rpc[method]
      setApiStatus('An RPC id is 5 or 6 letters or digits.')
      return
    }
    rpc[method] = id
  }
  const collision = rpcCollision(rpc)
  if (collision) {
    const [first, second, id] = collision
    // The method typed in last is the one whose old id goes back.
    const owner = julesApiValues.rpc[first] === id ? first : second
    fillJulesApi(julesApiValues)
    setApiStatus(`${owner} already uses ${id}.`)
    return
  }
  const api = normalizeJulesApi({
    ...julesApiValues,
    rpc,
    archiveBatch: archiveBatchInput.value.trim(),
    archiveSplit: archiveSplitInput.value.trim()
  })
  fillJulesApi(api)
  chrome.storage.local.set({ [JULES_API_KEY]: api })
}
archiveBatchInput.addEventListener('change', saveJulesApi)
archiveSplitInput.addEventListener('change', saveJulesApi)

chrome.storage.local.get([JULES_API_KEY, JULES_API_LOG_KEY], (data) => {
  fillJulesApi(normalizeJulesApi(data?.[JULES_API_KEY]), data?.[JULES_API_LOG_KEY])
})

rediscoverBtn.addEventListener('click', () => {
  rediscoverBtn.disabled = true
  rediscoverBtn.setAttribute('aria-busy', 'true')
  apiStatusEl.dataset.busy = '1'
  setApiStatus('Reading the Jules web app…')
  chrome.runtime.sendMessage({ action: 'REDISCOVER_API' }, (resp) => {
    rediscoverBtn.disabled = false
    rediscoverBtn.removeAttribute('aria-busy')
    delete apiStatusEl.dataset.busy
    if (chrome.runtime.lastError || !resp) {
      setApiStatus('Could not reach the extension. Try again.')
      return
    }
    if (resp.error) {
      setApiStatus(resp.error)
      return
    }
    fillJulesApi(normalizeJulesApi(resp.api))
    showDiscovery(resp)
  })
})

resetApiBtn.addEventListener('click', () => {
  chrome.storage.local.remove(JULES_API_KEY, () => {
    fillJulesApi(normalizeJulesApi())
    setApiStatus('Back to the built-in values.')
  })
})

chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'sync' && SETTINGS_SYNC_KEYS.some((key) => key in changes)) {
    chrome.storage.sync.get(SETTINGS_SYNC_KEYS, (data) => fillSettings(settingsFromSync(data)))
  }
  if (area === 'local' && changes[JULES_API_KEY]) {
    fillJulesApi(normalizeJulesApi(changes[JULES_API_KEY].newValue), changes[JULES_API_LOG_KEY]?.newValue)
  }
})

// =============================================================================
// Load saved settings & cleanup insecure storage
// =============================================================================

chrome.storage.sync.get(
  [
    'ghOwner',
    'item',
    'message',
    'ghToken',
    'schedEnabled',
    'schedIntervalMin',
    'schedStartSuggestions',
    'schedMaxStarts',
    ...SETTINGS_SYNC_KEYS
  ],
  (syncData) => {
    loadSettings(syncData)
    if (typeof syncData.item === 'string' && !isRunning()) restoreItem(syncData.item)
    if (typeof syncData.message === 'string') messageInput.value = syncData.message
    schedEnabledInput.checked = syncData.schedEnabled === true
    if (syncData.schedIntervalMin !== undefined) schedIntervalInput.value = String(syncData.schedIntervalMin)
    schedSuggestionsInput.checked = syncData.schedStartSuggestions === true
    if (syncData.schedMaxStarts !== undefined) schedMaxStartsInput.value = String(syncData.schedMaxStarts)
    if (syncData.ghOwner) ghOwnerInput.value = syncData.ghOwner
    showNextScheduledRun()

    // Cleanup legacy insecure storage of token in sync
    if (syncData.ghToken) {
      const ghToken = syncData.ghToken.slice(0, MAX_TOKEN_LEN)
      chrome.storage.local.set({ ghToken }, () => {
        chrome.storage.sync.remove('ghToken')
      })
      ghTokenInput.value = ghToken
    }

    chrome.storage.local.get(['ghToken'], (localData) => {
      if (localData.ghToken) ghTokenInput.value = localData.ghToken
    })
  }
)

// --- Save settings on change ---
ghOwnerInput.addEventListener('change', () => {
  chrome.storage.sync.set({ ghOwner: ghOwnerInput.value.trim().slice(0, MAX_OWNER_LEN) })
})
ghTokenInput.addEventListener('change', () => {
  chrome.storage.local.set({ ghToken: ghTokenInput.value.trim().slice(0, MAX_TOKEN_LEN) })
})

// Schedule settings persist on change; background.js's storage.onChanged
// listener reconciles the chrome.alarms schedule — no message needed.
const SCHEDULE_INPUTS = [schedEnabledInput, schedIntervalInput, schedSuggestionsInput, schedMaxStartsInput]
function lockSchedule(locked) {
  for (const input of SCHEDULE_INPUTS) input.disabled = locked
}
lockSchedule(true)

schedEnabledInput.addEventListener('change', () => {
  if (!backgroundOk) return
  chrome.storage.sync.set({ schedEnabled: schedEnabledInput.checked === true })
  // The background re-creates the alarm after the write lands.
  setTimeout(showNextScheduledRun, 300)
})
schedIntervalInput.addEventListener('change', () => {
  if (!backgroundOk) return
  const minutes = readClampedNumber(schedIntervalInput, 1, 1440, 60)
  schedIntervalInput.value = String(minutes)
  chrome.storage.sync.set({ schedIntervalMin: minutes })
  setTimeout(showNextScheduledRun, 300)
})
schedSuggestionsInput.addEventListener('change', () => {
  if (!backgroundOk) return
  chrome.storage.sync.set({ schedStartSuggestions: schedSuggestionsInput.checked === true })
})
schedMaxStartsInput.addEventListener('change', () => {
  if (!backgroundOk) return
  const maxStarts = readClampedNumber(schedMaxStartsInput, 1, 500, 20)
  schedMaxStartsInput.value = String(maxStarts)
  chrome.storage.sync.set({ schedMaxStarts: maxStarts })
})

function showNextScheduledRun() {
  if (!schedNext || !chrome.alarms?.get) return
  if (!schedEnabledInput.checked) {
    schedNext.classList.add('hidden')
    return
  }
  Promise.resolve(chrome.alarms.get(SCHEDULE_ALARM_NAME)).then((alarm) => {
    if (!alarm?.scheduledTime) {
      schedNext.classList.add('hidden')
      return
    }
    const time = new Date(alarm.scheduledTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    schedNext.textContent = `next ${time}`
    schedNext.classList.remove('hidden')
  })
}

// =============================================================================
// Header: open Jules tabs
// =============================================================================

function showJulesTabs() {
  Promise.resolve(chrome.tabs.query({ url: JULES_TABS_URL })).then((tabs) => {
    const julesTabs = (tabs || []).filter((t) => t.url && !t.url.includes('accounts.google'))
    const accounts = new Set(julesTabs.map((t) => /\/u\/(\d+)(?:\/|$)/.exec(new URL(t.url).pathname)?.[1] || '0'))
    tabStatus.classList.toggle('off', julesTabs.length === 0)
    if (julesTabs.length === 0) {
      tabStatusText.textContent = 'No Jules tab open'
      return
    }
    const a = accounts.size
    const t = julesTabs.length
    tabStatusText.textContent = `${a} account${a === 1 ? '' : 's'} · ${t} tab${t === 1 ? '' : 's'}`
  })
}

showJulesTabs()

// =============================================================================
// Repository picker
// =============================================================================

// Option 0 ("All Repositories", value '') stays; connected repos follow it.
function applyCodebases(codebases) {
  const currentValue = repoFilterInput.value

  while (repoFilterInput.options.length > 1) {
    repoFilterInput.remove(1)
  }

  for (const cb of codebases) {
    const opt = document.createElement('option')
    opt.value = cb
    opt.textContent = cb
    repoFilterInput.appendChild(opt)
  }

  if (currentValue) {
    repoFilterInput.value = currentValue
  }
}

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1000

function populateCodebases(attempt = 0) {
  // Ask the background for every connected source via the Jules API first
  chrome.runtime.sendMessage({ action: 'GET_ALL_SOURCES' }, (bgResp) => {
    if (bgResp?.repos && bgResp.repos.length > 0) {
      applyCodebases(bgResp.repos)
      return
    }

    // Fallback: scrape the codebases list from the active Jules page
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab?.id) return
      chrome.tabs.sendMessage(tab.id, { action: 'GET_CODEBASES' }, (response) => {
        if (chrome.runtime.lastError || !response?.codebases?.length) {
          if (attempt < MAX_RETRIES) {
            setTimeout(() => populateCodebases(attempt + 1), RETRY_DELAY_MS)
          }
          return
        }
        applyCodebases(response.codebases)
      })
    })
  })
}

populateCodebases()

// The dropdown and the free-text owner/repo box are mutually exclusive.
repoFilterInput.addEventListener('change', () => {
  if (repoFilterInput.value) customRepoInput.value = ''
})
customRepoInput.addEventListener('input', () => {
  if (customRepoInput.value.trim()) repoFilterInput.value = ''
})

// =============================================================================
// Run: Proceed, Archive, Export
// =============================================================================

const RUN_BUTTONS = { proceed: proceedBtn, archive: archiveBtn, export: exportBtn, more: moreConfirm }
const RUN_BUTTON_TEXT = { proceed: 'Proceed', archive: 'Archive', export: '↓ Export', more: 'Confirm' }
const RUNNING_TEXT = {
  proceed: '⏳ Proceeding…',
  archive: '⏳ Archiving…',
  export: '⏳ Exporting…',
  more: '⏳ Applying…'
}

function isRunning() {
  return runningAction !== null
}

function setRunning(action, dryRun) {
  moreLoad.disabled = true
  runningAction = RUN_BUTTONS[action] ? action : 'proceed'
  for (const [name, btn] of Object.entries(RUN_BUTTONS)) {
    btn.disabled = true
    if (name === runningAction) {
      btn.setAttribute('aria-busy', 'true')
      btn.textContent = dryRun && name !== 'export' ? '⏳ Dry run…' : RUNNING_TEXT[name]
    }
  }
}

function setIdle() {
  runningAction = null
  for (const [name, btn] of Object.entries(RUN_BUTTONS)) {
    btn.removeAttribute('aria-busy')
    btn.textContent = RUN_BUTTON_TEXT[name]
  }
  updateRunButtons()
}

// Proceed and Archive need an item; nothing runs on a stale worker.
function updateRunButtons() {
  updateMoreControls()
  if (isRunning()) return
  const noItem = !getSelectedItem()
  proceedBtn.disabled = backgroundStale || noItem
  archiveBtn.disabled = backgroundStale || noItem
  exportBtn.disabled = backgroundStale
}

function showIdle() {
  logStatus.textContent = 'Idle'
  idleText.textContent = dryRunInput.checked
    ? 'Dry-run is on: Proceed and Archive only list what they would do.'
    : 'Dry-run is off: Proceed and Archive change your tasks.'
}

// --- Background version check (RUN_PROTOCOL in settings.js says why) ---
function checkBackground() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'HELLO' }, (resp) => {
      // A worker older than HELLO doesn't answer: the port closes empty.
      resolve(!chrome.runtime.lastError && resp?.protocol === RUN_PROTOCOL)
    })
  })
}

function showStaleBackground() {
  backgroundStale = true
  backgroundOk = false
  for (const btn of Object.values(RUN_BUTTONS)) btn.disabled = true
  updateMoreControls()
  lockSchedule(true)
  staleBanner.classList.remove('hidden')
}

// Live runs that can't be undone from the popup ask first.
function confirmLiveRun(action, item, force, message) {
  if (action === 'archive' && item.id === ITEM_ALL) {
    return window.confirm(
      '⚠️ Archive every task?\n\nThis includes running sessions and sessions waiting on you.' +
        (force ? '\n\nForce is on: tasks with a matching open pull request are archived too.' : '')
    )
  }
  if (action === 'archive' && force) {
    return window.confirm(
      '⚠️ Force archive?\n\nTasks with a matching open pull request will be archived too.\n\nContinue?'
    )
  }
  if (action === 'proceed' && force && item.id === ITEM_ALL && message) {
    return window.confirm(
      '⚠️ Force is on.\n\nCompleted tasks get your message as a follow-up, and each one starts a new run.\n\nContinue?'
    )
  }
  return true
}

async function startRun(action) {
  if (isRunning()) return
  const item = getSelectedItem()
  if (!item && action !== 'export') {
    currentInfo.textContent = 'Choose an item first.'
    return
  }
  const dryRun = action === 'export' ? false : dryRunInput.checked
  const force = forceInput.checked
  const message = addMessageInput.checked ? (messageInput.value || '').trim().slice(0, MAX_MESSAGE_LEN) : ''
  if (!dryRun && action !== 'export' && !confirmLiveRun(action, item, force, message)) return

  // Lock the buttons before the first await so a second click can't start a
  // second run while the current tab is looked up.
  setRunning(action, dryRun)
  togglePanel(null) // show the log
  resetBtn.classList.add('hidden')
  clearExportResult()
  summarySection.classList.add('hidden')
  idleText.classList.add('hidden')
  logStatus.textContent = dryRun ? 'Starting · dry-run' : 'Starting'
  currentInfo.textContent = 'Starting...'
  progressFill.style.width = '0%'
  progressFill.style.background = '' // Reset error color if present
  logPre.textContent = ''

  // Save settings first, ensuring token is only in local storage
  chrome.storage.sync.set({
    ghOwner: ghOwnerInput.value.trim().slice(0, MAX_OWNER_LEN)
  })
  chrome.storage.sync.remove('ghToken')
  chrome.storage.local.set({
    ghToken: ghTokenInput.value.trim().slice(0, MAX_TOKEN_LEN)
  })

  const scope = document.querySelector('input[name="scope"]:checked').value

  // Get active tab for "current" scope
  let activeTabId = null
  if (scope === 'current') {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    })
    activeTabId = tab?.id
  }

  const options = {
    action,
    item: item?.id ?? null,
    dryRun,
    force,
    message,
    oneSession: item?.type === 'suggestions' && oneSessionInput.checked,
    scope,
    activeTabId,
    repoFilter: (customRepoInput.value.trim() || repoFilterInput.value).trim()
  }

  // The worker can be replaced while the popup is open; ask right before.
  // The popup may have gone stale (an earlier check failing) while this one was out.
  if (!(await checkBackground()) || backgroundStale) {
    setIdle()
    showStaleBackground()
    logStatus.textContent = 'Error'
    currentInfo.textContent = 'Not started: reload the extension first.'
    return
  }

  // A worker that stops before it answers leaves no reply; the buttons must
  // not stay locked on "Starting" then.
  chrome.runtime.sendMessage({ action: 'START', protocol: RUN_PROTOCOL, options }, (response) => {
    const error = chrome.runtime.lastError?.message || response?.error || (!response?.ok && 'The run could not start.')
    if (error) {
      setIdle()
      currentInfo.textContent = `Error: ${error}`
      logStatus.textContent = 'Error'
    }
  })
}

proceedBtn.addEventListener('click', () => startRun('proceed'))
archiveBtn.addEventListener('click', () => startRun('archive'))
exportBtn.addEventListener('click', () => startRun('export'))

// =============================================================================
// More Actions
// =============================================================================

function shownMoreItems(category = moreCategory) {
  return loadedMoreItems.filter(
    (item) =>
      category === 'all' ||
      (category === 'scheduled' && item.kind === 'schedule') ||
      (category === 'completed' && item.kind === 'task' && isCompletedTask(item))
  )
}

function fittingMoreItems(action) {
  return loadedMoreItems.filter((item) => selectedMoreItems.has(moreItemKey(item)) && moreActionFits(action, item))
}

function disarmMoreDelete() {
  moreDeleteArmedAt = null
  clearTimeout(moreDeleteTimer)
  moreDeleteTimer = null
}

// The timer only redraws the button; a click checks the time itself.
function armMoreDelete() {
  disarmMoreDelete()
  moreDeleteArmedAt = Date.now()
  moreDeleteTimer = setTimeout(() => {
    disarmMoreDelete()
    updateMoreControls()
  }, DELETE_CONFIRM_MAX_MS)
}

function moreConfirmText() {
  const action = moreAction.value
  if (MORE_ACTIONS[action]?.local) return 'Copy'
  if (moreDryRun.checked) return 'Confirm (dry run)'
  if (MORE_ACTIONS[action]?.destructive && moreDeleteArmedAt !== null) {
    const count = fittingMoreItems(action).length
    return action === 'deleteTask'
      ? `Delete ${count} ${count === 1 ? 'task' : 'tasks'} permanently? Click again`
      : `Delete ${count} ${count === 1 ? 'schedule' : 'schedules'}? Click again`
  }
  return 'Confirm'
}

function updateMoreControls() {
  const locked = backgroundStale || !backgroundOk || isRunning() || moreLoading
  moreLoad.disabled = locked || (moreRepoScope.checked && !/^[\w.-]+\/[\w.-]+$/.test(moreRepo.value.trim()))
  moreRefresh.disabled = moreLoad.disabled
  moreRefresh.classList.toggle('hidden', moreCachedAt === null)
  moreConfirm.disabled = locked || fittingMoreItems(moreAction.value).length === 0
  // Force only skips Archive's open-PR check.
  moreForce.disabled = moreAction.value !== 'archive'
  if (!isRunning()) moreConfirm.textContent = moreConfirmText()
}

// Only the actions that fit a shown item are offered, as in Jules' menus;
// each counts the selected items it fits.
function renderMoreSelection() {
  disarmMoreDelete()
  const previous = moreAction.value
  moreAction.textContent = ''
  const choose = document.createElement('option')
  choose.value = ''
  choose.textContent = 'Choose an action'
  moreAction.appendChild(choose)
  const shownItems = shownMoreItems()
  for (const [action, details] of Object.entries(MORE_ACTIONS)) {
    if (!shownItems.some((item) => moreActionFits(action, item))) continue
    const count = fittingMoreItems(action).length
    const option = document.createElement('option')
    option.value = action
    option.textContent = `${details.label} (${count})`
    option.disabled = count === 0
    moreAction.appendChild(option)
  }
  moreAction.value = fittingMoreItems(previous).length ? previous : ''
  const shown = shownMoreItems()
  const checked = shown.filter((item) => selectedMoreItems.has(moreItemKey(item))).length
  moreSelectAll.checked = shown.length > 0 && checked === shown.length
  moreSelectAll.indeterminate = checked > 0 && checked < shown.length
  moreSelectAll.disabled = shown.length === 0
  updateMoreControls()
}

function renderMoreItems() {
  moreChips.textContent = ''
  // A load of one category needs no chips.
  const chips =
    moreLoadedCategory === 'all'
      ? [
          ['all', 'All'],
          ['scheduled', 'Scheduled'],
          ['completed', 'Completed']
        ]
      : []
  for (const [category, label] of chips) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'more-chip'
    chip.textContent = `${label} (${shownMoreItems(category).length})`
    chip.setAttribute('aria-pressed', String(category === moreCategory))
    chip.addEventListener('click', () => {
      moreCategory = category
      renderMoreItems()
    })
    moreChips.appendChild(chip)
  }
  moreList.textContent = ''
  const fragment = document.createDocumentFragment()
  for (const item of shownMoreItems()) {
    const row = document.createElement('label')
    row.className = 'more-row'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = selectedMoreItems.has(moreItemKey(item))
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedMoreItems.add(moreItemKey(item))
      else selectedMoreItems.delete(moreItemKey(item))
      renderMoreSelection()
    })
    const text = document.createElement('span')
    text.className = 'more-text'
    const title = document.createElement('span')
    title.className = 'more-title'
    title.textContent = item.title
    title.title = item.title
    const meta = document.createElement('span')
    meta.className = 'more-meta'
    const kind = item.kind === 'schedule' ? 'Scheduled' : item.kind === 'archived' ? 'Archived' : 'Task'
    const state =
      item.kind === 'schedule'
        ? item.state === 2
          ? 'Active'
          : item.state === 3
            ? 'Paused'
            : `State ${item.state}`
        : item.awaitingReview && isCompletedTask(item)
          ? 'Ready for review'
          : taskStateFor(item)?.name || `State ${item.state}`
    meta.textContent = `${kind} · ${state} · ${item.repo || '(no repo)'} · ${item.account}`
    text.appendChild(title)
    text.appendChild(meta)
    row.appendChild(checkbox)
    row.appendChild(text)
    fragment.appendChild(row)
  }
  moreList.appendChild(fragment)
  renderMoreSelection()
}

for (const input of [moreAll, moreRepoScope]) input.addEventListener('change', updateMoreControls)
moreRepo.addEventListener('input', () => {
  if (moreRepo.value.trim()) moreRepoScope.checked = true
  updateMoreControls()
})
for (const input of [moreAction, moreDryRun]) {
  input.addEventListener('change', () => {
    disarmMoreDelete()
    updateMoreControls()
  })
}
moreSelectAll.addEventListener('change', () => {
  for (const item of shownMoreItems()) {
    if (moreSelectAll.checked) selectedMoreItems.add(moreItemKey(item))
    else selectedMoreItems.delete(moreItemKey(item))
  }
  renderMoreItems()
})

const MORE_KINDS = { tasks: 'task', schedules: 'schedule', archived: 'archived' }

function moreItemsFrom(accounts) {
  return accounts.flatMap((account) =>
    Object.entries(MORE_KINDS).flatMap(([list, kind]) =>
      (account[list] || []).map((item) => ({ ...item, account: account.account, kind }))
    )
  )
}

function renderMoreStatus() {
  const count = (kind) => loadedMoreItems.filter((item) => item.kind === kind).length
  const archived = {
    loading: moreArchivedRepos
      ? `Listing the archived tasks… ${moreArchivedRepos.done} of ${moreArchivedRepos.total} repos`
      : 'Listing the archived tasks…',
    done: `${count('archived')} archived tasks`,
    failed: '',
    none: ''
  }[moreArchived]
  const counts = {
    all: `${count('task')} tasks, ${count('schedule')} schedules`,
    scheduled: `${count('schedule')} schedules`,
    complete: `${count('task')} completed tasks`,
    archive: archived
  }[moreLoadedCategory]
  moreStatus.textContent = [counts, moreCacheAge(), ...moreNotes].filter(Boolean).join(' · ')
}

// The worker keeps what a Load listed for 30 minutes (background.js MORE_CACHE).
function moreCacheAge() {
  if (moreCachedAt === null) return ''
  const minutes = Math.floor((Date.now() - moreCachedAt) / 60000)
  return `from the cache, ${minutes < 1 ? 'under a minute' : `${minutes} min`} old`
}

// The age of a cached load goes on counting while the popup stays open; the
// timer stops once a load is not from the cache.
let moreAgeTimer = null

function noteMoreCache(cachedAt) {
  if (!Number.isFinite(cachedAt)) return
  moreCachedAt = Math.min(moreCachedAt ?? cachedAt, cachedAt)
  moreAgeTimer ??= setInterval(() => {
    if (moreCachedAt !== null) return renderMoreStatus()
    clearInterval(moreAgeTimer)
    moreAgeTimer = null
  }, 30000)
}

function sendMore(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (reply) => {
      resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : reply)
    })
  })
}

// Jules can take about 90 s on a large archive (and then give up), so the
// list is usable before the archived tasks arrive.
async function loadMoreArchived(loadId, fresh) {
  const reply = await sendMore({ action: 'LOAD_ARCHIVED', protocol: RUN_PROTOCOL, loadId, fresh })
  if (loadId !== moreLoadId) return
  if (!reply?.accounts || reply.error) {
    moreArchived = 'failed'
    moreNotes.push(`Could not list the archived tasks: ${reply?.error || 'no answer'}`)
  } else {
    moreArchived = 'done'
    noteMoreCache(reply.cachedAt)
    loadedMoreItems.push(...moreItemsFrom(reply.accounts))
    moreNotes.push(...(reply.notes || []), ...reply.accounts.flatMap((account) => account.notes || []))
  }
  renderMoreStatus()
  renderMoreItems()
}

// Load answers from the worker's cache when it can; Refresh (`fresh`) lists live.
async function loadMore(fresh) {
  updateMoreControls()
  if (moreLoad.disabled) return
  moreLoading = true
  moreLoad.textContent = 'Loading…'
  moreLoad.setAttribute('aria-busy', 'true')
  updateMoreControls()
  try {
    if (!(await checkBackground()) || backgroundStale) {
      showStaleBackground()
      return
    }
    const category = moreCategorySelect.value
    const response = await sendMore({
      action: 'LOAD_ITEMS',
      protocol: RUN_PROTOCOL,
      repo: moreRepoScope.checked ? moreRepo.value.trim() : '',
      category,
      fresh
    })
    if (!response?.accounts || response.error) throw new Error(response?.error || 'Could not load items.')
    moreLoadId = response.loadId
    moreLoadedCategory = category
    moreArchived = category === 'archive' ? 'loading' : 'none'
    moreArchivedRepos = null
    moreCachedAt = null
    noteMoreCache(response.cachedAt)
    loadedMoreItems = moreItemsFrom(response.accounts)
    moreNotes = [...(response.notes || []), ...response.accounts.flatMap((account) => account.notes || [])]
    selectedMoreItems = new Set()
    moreCategory = 'all'
    renderMoreStatus()
    renderMoreItems()
    if (category === 'archive') loadMoreArchived(response.loadId, fresh)
  } catch (e) {
    moreLoadId = null
    moreLoadedCategory = null
    moreArchived = 'none'
    moreCachedAt = null
    loadedMoreItems = []
    selectedMoreItems.clear()
    renderMoreItems()
    moreStatus.textContent = e.message
  } finally {
    moreLoading = false
    moreLoad.textContent = 'Load'
    moreLoad.removeAttribute('aria-busy')
    updateMoreControls()
  }
}

moreLoad.addEventListener('click', () => loadMore(false))
moreRefresh.addEventListener('click', () => loadMore(true))

// The selected tasks' URLs, one per line, as Jules' Copy session URL gives one.
async function copyMoreSessionUrls() {
  const urls = fittingMoreItems('copyUrl').map(moreSessionUrl)
  try {
    await navigator.clipboard.writeText(urls.join('\n'))
    moreStatus.textContent = `Copied ${urls.length} session ${urls.length === 1 ? 'URL' : 'URLs'}.`
  } catch (e) {
    moreStatus.textContent = `Could not copy the URLs: ${e.message}`
  }
}

moreConfirm.addEventListener('keydown', (event) => {
  if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault()
})

moreConfirm.addEventListener('click', async (event) => {
  updateMoreControls()
  if (moreConfirm.disabled) return
  const operation = moreAction.value
  if (MORE_ACTIONS[operation].local) {
    await copyMoreSessionUrls()
    return
  }
  const dryRun = moreDryRun.checked
  if (MORE_ACTIONS[operation].destructive && !dryRun) {
    const since = moreDeleteArmedAt === null ? null : Date.now() - moreDeleteArmedAt
    if (since === null || since > DELETE_CONFIRM_MAX_MS) {
      armMoreDelete()
      updateMoreControls()
      return
    }
    // A double-click's second click (detail 2) can come after 0.5 s on a slow setting.
    if (since < DELETE_CONFIRM_MIN_MS || event.detail > 1) return
  }
  disarmMoreDelete()
  const items = fittingMoreItems(operation).map(({ account, kind, id }) => ({ account, kind, id }))
  const force = operation === 'archive' && moreForce.checked
  setRunning('more', dryRun)
  togglePanel(null)
  resetBtn.classList.add('hidden')
  downloadBtn.classList.add('hidden')
  lastExportData = null
  summarySection.classList.add('hidden')
  idleText.classList.add('hidden')
  logPre.textContent = ''
  logStatus.textContent = dryRun ? 'Starting · dry-run' : 'Starting'
  currentInfo.textContent = 'Starting...'
  progressFill.style.width = '0%'
  progressFill.style.background = ''
  if (!(await checkBackground()) || backgroundStale) {
    setIdle()
    showStaleBackground()
    currentInfo.textContent = 'Not started: reload the extension first.'
    logStatus.textContent = 'Error'
    return
  }
  chrome.runtime.sendMessage(
    { action: 'APPLY_ACTION', protocol: RUN_PROTOCOL, operation, dryRun, force, items },
    (response) => {
      const error = chrome.runtime.lastError?.message || response?.error || (!response?.ok && 'Could not start action.')
      if (error) {
        setIdle()
        currentInfo.textContent = `Error: ${error}`
        logStatus.textContent = 'Error'
      } else if (!dryRun) {
        for (const item of items) selectedMoreItems.delete(moreItemKey(item))
        renderMoreItems()
        moreStatus.textContent = 'Load again to refresh item states after this action.'
      }
    }
  )
})

renderMoreItems()

// --- Reset ---
resetBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'RESET' })
  setIdle()
  resetBtn.classList.add('hidden')
  downloadBtn.classList.add('hidden')
  summarySection.classList.add('hidden')
  logPre.classList.add('hidden')
  logPre.textContent = ''
  currentInfo.textContent = ''
  progressFill.style.width = '0%'
  idleText.classList.remove('hidden')
  showIdle()
  // Move focus back to the primary action so keyboard users are not stranded
  // on the now-hidden Reset button.
  proceedBtn.focus()
})

// The worker saves its count while it lists every repo's archived tasks.
chrome.storage.onChanged.addListener((changes, area) => {
  const progress = changes.moreArchivedProgress?.newValue
  if (area !== 'session' || !progress || progress.loadId !== moreLoadId || moreArchived !== 'loading') return
  moreArchivedRepos = { done: progress.done, total: progress.total }
  renderMoreStatus()
})

// --- Listen for state changes ---
chrome.storage.onChanged.addListener((changes) => {
  if (!changes.archiveState) return
  const state = changes.archiveState.newValue
  if (!state) return
  renderState(state)
})

// --- Render state ---
// A previous Export JSON result belongs to that run only.
function clearExportResult() {
  downloadBtn.classList.add('hidden')
  lastExportData = null
  if (runningAction !== 'export') exportBtn.textContent = RUN_BUTTON_TEXT.export
}

function renderState(state) {
  const dryRun = state.options?.dryRun === true
  // Log
  if (state.log?.length > 0) {
    logPre.textContent = state.log.join('\n')
    logPre.scrollTop = logPre.scrollHeight
    logPre.classList.remove('hidden')
    idleText.classList.add('hidden')
  }

  // Current info
  if (state.status === 'running') {
    clearExportResult() // a scheduled run starts without startRun
    if (!isRunning()) setRunning(state.options?.action || 'proceed', dryRun)
    const parts = []
    if (state.currentTab) parts.push(state.currentTab)
    if (state.currentRepo) parts.push(state.currentRepo)
    currentInfo.textContent = parts.join(' > ')
    logStatus.textContent = dryRun ? 'Running · dry-run' : 'Running'

    if (state.progress?.total > 0) {
      const done = state.progress.archived + state.progress.skipped
      const pct = Math.round((done / state.progress.total) * 100)
      progressFill.style.width = `${pct}%`
      progressFill.parentElement.setAttribute('aria-valuenow', String(pct))
      currentInfo.textContent += ` [${done}/${state.progress.total}]`
      logStatus.textContent = `${done} / ${state.progress.total}${dryRun ? ' · dry-run' : ''}`
    }
  }

  // Done or error
  if (state.status === 'done' || state.status === 'error') {
    setIdle()
    resetBtn.classList.remove('hidden')
    progressFill.style.width = '100%'
    progressFill.parentElement.setAttribute('aria-valuenow', '100')

    if (state.status === 'done') {
      currentInfo.textContent = 'Complete'
      logStatus.textContent = dryRun ? 'Done · dry-run' : 'Done'
      renderSummary(state.results)
      if (state.exportData) {
        lastExportData = state.exportData
        const found = state.exportData.totalSuggestions || 0
        // The header button says the export finished; the file waits below.
        exportBtn.textContent = `✓ ${found} exported`
        downloadBtn.classList.remove('hidden')
        downloadBtn.textContent = `⬇ Download suggestions JSON (${found} found)`
      }
    } else {
      currentInfo.textContent = `Error: ${state.error}`
      logStatus.textContent = 'Error'
      progressFill.style.background = '#f87171'
    }
  }
}

// --- Render summary (safe DOM methods, no innerHTML) ---
function renderSummary(results) {
  summarySection.classList.remove('hidden')
  summaryDiv.textContent = ''

  if (!results?.length) {
    const emptyDiv = document.createElement('div')
    emptyDiv.className = 'hint'
    emptyDiv.textContent = 'No items were processed. Try checking your scope or if tasks exist.'
    summaryDiv.appendChild(emptyDiv)
    return
  }

  // ⚡ Bolt Optimization: Use DocumentFragment to batch DOM insertions.
  // This prevents redundant browser reflows/repaints when processing large
  // numbers of repositories, improving performance during summary rendering.
  const fragment = document.createDocumentFragment()
  let grand = 0

  for (const r of results) {
    grand += r.count
    const div = document.createElement('div')
    if (r.err) {
      div.className = 'error'
      div.textContent = `${r.label}: ERROR - ${r.err}`
    } else {
      div.textContent = `${r.label}: ${r.count} processed`
    }
    fragment.appendChild(div)
  }

  const totalDiv = document.createElement('div')
  totalDiv.className = 'total'
  totalDiv.textContent = `TOTAL: ${grand} processed`
  fragment.appendChild(totalDiv)

  summaryDiv.appendChild(fragment)
}

// --- Check for existing state on popup open ---
showIdle()
checkBackground().then((ok) => {
  // A check before a run may have failed while this answer was on its way.
  if (!ok || backgroundStale) return showStaleBackground()
  backgroundOk = true
  updateMoreControls()
  lockSchedule(false)
})
chrome.runtime.sendMessage({ action: 'GET_STATE' }, (state) => {
  if (state && state.status !== 'idle') {
    // Rehydrate the item the run was started with.
    if (state.options?.item?.id) selectItem(state.options.item.id, { save: false })
    if (state.status === 'running') setRunning(state.options?.action || 'proceed', state.options?.dryRun === true)
    renderState(state)
    if (state.status !== 'running') resetBtn.classList.remove('hidden')
  }
})

// --- Export download (re-save; the background already saved one copy) ---

downloadBtn.addEventListener('click', () => {
  if (lastExportData) {
    downloadExportedSuggestions(lastExportData)
  }
})

function downloadExportedSuggestions(exportData) {
  try {
    const filename = `jules-suggestions-${new Date().toISOString().slice(0, 10)}.json`
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    setTimeout(() => {
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }, 1000)
  } catch (err) {
    console.error('Failed to trigger JSON download:', err)
  }
}
