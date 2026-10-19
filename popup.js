// Modified by tommyzed: Added repository selector and suggestions
/**
 * Jules Task Archiver — Popup Script
 *
 * The Items dropdown with Proceed and Archive, settings persistence and
 * progress display. items.js (loaded first) provides the dropdown entries.
 */

const $ = (sel) => document.querySelector(sel)

// Match the HTML `maxlength` bounds on #ghOwner / #ghToken (popup.html) so
// storage writes stay bounded even if `.value` is set programmatically
// (devtools, extension context) and bypasses the input's typing limit.
const MAX_OWNER_LEN = 39
const MAX_TOKEN_LEN = 255
// Matches #message's maxlength and the background's cap.
const MAX_MESSAGE_LEN = 2000
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
const mainView = $('#mainView')

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

const ITEMS = listItems()
let selectedItemId = ITEM_ALL
let activeOptionIndex = -1
let optionEls = []

function getSelectedItem() {
  return ITEMS.find((i) => i.id === selectedItemId) || ITEMS[0]
}

function itemKind(item) {
  if (item.type === 'suggestions') return 'suggestions'
  if (item.codes === null) return 'all'
  return TASK_STATES.find((s) => s.code === item.code)?.kind || 'unknown'
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
  selectedItemId = id
  const item = getSelectedItem()
  itemsBtnText.textContent = item.label
  for (const opt of optionEls) {
    const selected = opt.dataset.id === id
    opt.setAttribute('aria-selected', String(selected))
    opt.classList.toggle('cur', selected)
  }
  updateItemUI()
  if (save) chrome.storage.sync.set({ item: id })
}

function updateItemUI() {
  const item = getSelectedItem()
  oneSessionRow.classList.toggle('hidden', item.type !== 'suggestions')
  messageHint.textContent = MESSAGE_HINTS[itemKind(item)]
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

function openItemsMenu() {
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
  [scheduleToggle, schedulePanel]
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
    'schedMaxStarts'
  ],
  (syncData) => {
    if (typeof syncData.item === 'string' && !isRunning()) selectItem(syncData.item, { save: false })
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
schedEnabledInput.addEventListener('change', () => {
  chrome.storage.sync.set({ schedEnabled: schedEnabledInput.checked === true })
  // The background re-creates the alarm after the write lands.
  setTimeout(showNextScheduledRun, 300)
})
schedIntervalInput.addEventListener('change', () => {
  const minutes = readClampedNumber(schedIntervalInput, 1, 1440, 60)
  schedIntervalInput.value = String(minutes)
  chrome.storage.sync.set({ schedIntervalMin: minutes })
  setTimeout(showNextScheduledRun, 300)
})
schedSuggestionsInput.addEventListener('change', () => {
  chrome.storage.sync.set({ schedStartSuggestions: schedSuggestionsInput.checked === true })
})
schedMaxStartsInput.addEventListener('change', () => {
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

const RUN_BUTTONS = { proceed: proceedBtn, archive: archiveBtn, export: exportBtn }
const RUN_BUTTON_TEXT = { proceed: 'Proceed', archive: 'Archive', export: 'Export suggestions' }
const RUNNING_TEXT = { proceed: '⏳ Proceeding…', archive: '⏳ Archiving…', export: '⏳ Exporting…' }

function isRunning() {
  return runningAction !== null
}

function setRunning(action, dryRun) {
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
    btn.disabled = false
    btn.removeAttribute('aria-busy')
    btn.textContent = RUN_BUTTON_TEXT[name]
  }
}

function showIdle() {
  logStatus.textContent = 'Idle'
  idleText.textContent = dryRunInput.checked
    ? 'Dry-run is on: Proceed and Archive only list what they would do.'
    : 'Dry-run is off: Proceed and Archive change your tasks.'
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
  const dryRun = action === 'export' ? false : dryRunInput.checked
  const force = forceInput.checked
  const message = addMessageInput.checked ? (messageInput.value || '').trim().slice(0, MAX_MESSAGE_LEN) : ''
  if (!dryRun && action !== 'export' && !confirmLiveRun(action, item, force, message)) return

  // Lock the buttons before the first await so a second click can't start a
  // second run while the current tab is looked up.
  setRunning(action, dryRun)
  togglePanel(null) // show the log
  resetBtn.classList.add('hidden')
  // A previous Export JSON result belongs to that run only.
  downloadBtn.classList.add('hidden')
  lastExportData = null
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
    item: item.id,
    dryRun,
    force,
    message,
    oneSession: item.type === 'suggestions' && oneSessionInput.checked,
    scope,
    activeTabId,
    repoFilter: (customRepoInput.value.trim() || repoFilterInput.value).trim()
  }

  chrome.runtime.sendMessage({ action: 'START', options }, (response) => {
    if (response?.error) {
      setIdle()
      currentInfo.textContent = `Error: ${response.error}`
      logStatus.textContent = 'Error'
    }
  })
}

proceedBtn.addEventListener('click', () => startRun('proceed'))
archiveBtn.addEventListener('click', () => startRun('archive'))
exportBtn.addEventListener('click', () => startRun('export'))

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

// --- Listen for state changes ---
chrome.storage.onChanged.addListener((changes) => {
  if (!changes.archiveState) return
  const state = changes.archiveState.newValue
  if (!state) return
  renderState(state)
})

// --- Render state ---
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
        downloadBtn.classList.remove('hidden')
        downloadBtn.textContent = `⬇ Download suggestions JSON (${state.exportData.totalSuggestions || 0} found)`
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
