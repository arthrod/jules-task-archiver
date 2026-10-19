// Modified by tommyzed: Added repository selector and suggestions
/**
 * Jules Task Archiver — Popup Script
 *
 * Handles UI interactions, settings persistence, and progress display.
 */

const $ = (sel) => document.querySelector(sel)

// Match the HTML `maxlength` bounds on #ghOwner / #ghToken (popup.html) so
// storage writes stay bounded even if `.value` is set programmatically
// (devtools, extension context) and bypasses the input's typing limit.
const MAX_OWNER_LEN = 39
const MAX_TOKEN_LEN = 255

// --- DOM refs ---
const mainForm = $('#mainForm')
const ghOwnerInput = $('#ghOwner')
const ghTokenInput = $('#ghToken')
const forceCheckbox = $('#force')
const repoFilterInput = $('#repoFilter')
const customRepoInput = $('#customRepoInput')
const startBtn = $('#startBtn')
const resetBtn = $('#resetBtn')
const downloadBtn = $('#downloadBtn')
const progressSection = $('#progressSection')
const summarySection = $('#summarySection')
const currentInfo = $('#currentInfo')
const progressFill = $('#progressFill')
const logPre = $('#log')
const summaryDiv = $('#summary')

// --- Schedule settings (read by background.js's chrome.alarms tick) ---
const schedEnabledInput = $('#schedEnabled')
const schedIntervalInput = $('#schedInterval')
const schedSuggestionsInput = $('#schedSuggestions')
const schedMaxStartsInput = $('#schedMaxStarts')

// Storage-side bounds match background.js; the background re-validates anyway,
// these just keep obviously-bad values out of sync storage.
function readClampedNumber(input, min, max, fallback) {
  const n = Number.parseInt(input?.value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

// --- Operation mode state ---
let opMode = 'archive'

function getRunningText() {
  const modeRadio = document.querySelector('input[name="mode"]:checked')
  const isDry = modeRadio && modeRadio.value === 'dry'

  if (opMode === 'archive') {
    return isDry ? '⏳ Dry Running Archive...' : '⏳ Running Archive...'
  } else if (opMode === 'remove_suggestions') {
    return isDry ? '⏳ Dry Running Remove Suggestions...' : '⏳ Running Remove Suggestions...'
  } else if (opMode === 'export_suggestions') {
    return '⏳ Exporting Suggestions to JSON...'
  } else if (opMode === 'agent_batch') {
    return isDry ? '⏳ Dry Running Batch Agent...' : '⏳ Launching Single Agent for All Suggestions...'
  } else {
    return isDry ? '⏳ Dry Running Suggestions...' : '⏳ Running Suggestions...'
  }
}

function getStartButtonText(value, isDry) {
  if (value === 'archive') {
    return isDry ? 'Dry Run Archive' : 'Start Archiving'
  } else if (value === 'remove_suggestions') {
    return isDry ? 'Dry Run Remove Suggestions' : 'Remove Suggestions'
  } else if (value === 'export_suggestions') {
    return 'Export Suggestions JSON'
  } else {
    return isDry ? 'Dry Run Suggestions' : 'Start Suggestions'
  }
}

// --- Operation mode selector ---
function setActiveOpMode(value) {
  opMode = value
  updateOpModeUI(value)
}

function updateOpModeUI(value) {
  document.querySelectorAll('#opMode button').forEach((b) => {
    const isActive = b.dataset.value === value
    b.classList.toggle('active', isActive)
    b.setAttribute('aria-pressed', String(isActive))
  })

  // Progressive disclosure: hide archive-specific settings
  const isArchive = value === 'archive'
  const settingsSection = document.querySelector('.settings')
  const forceCheckboxContainer = forceCheckbox.closest('.setting-row')

  if (settingsSection) {
    settingsSection.classList.toggle('hidden', !isArchive)
  }
  if (forceCheckboxContainer) {
    forceCheckboxContainer.classList.toggle('hidden', !isArchive)
  }

  // Context-aware start button text
  if (!startBtn.disabled) {
    const modeRadio = document.querySelector('input[name="mode"]:checked')
    const isDry = modeRadio && modeRadio.value === 'dry'
    startBtn.textContent = getStartButtonText(value, isDry)
  }
}

document.querySelectorAll('#opMode button').forEach((btn) => {
  btn.addEventListener('click', () => {
    setActiveOpMode(btn.dataset.value)
    chrome.storage.sync.set({ opMode })
  })
})

// Update button text when execution mode changes
document.querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    if (!startBtn.disabled && !startBtn.textContent.startsWith('⏳')) {
      updateOpModeUI(opMode)
    }
  })
})

// --- Load saved settings & cleanup insecure storage ---
chrome.storage.sync.get(
  ['ghOwner', 'opMode', 'ghToken', 'schedEnabled', 'schedIntervalMin', 'schedStartSuggestions', 'schedMaxStarts'],
  (syncData) => {
    schedEnabledInput.checked = syncData.schedEnabled === true
    if (syncData.schedIntervalMin !== undefined) schedIntervalInput.value = String(syncData.schedIntervalMin)
    schedSuggestionsInput.checked = syncData.schedStartSuggestions === true
    if (syncData.schedMaxStarts !== undefined) schedMaxStartsInput.value = String(syncData.schedMaxStarts)
    if (syncData.ghOwner) ghOwnerInput.value = syncData.ghOwner
    if (syncData.opMode) {
      setActiveOpMode(syncData.opMode)
    }

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
})
schedIntervalInput.addEventListener('change', () => {
  const minutes = readClampedNumber(schedIntervalInput, 1, 1440, 60)
  schedIntervalInput.value = String(minutes)
  chrome.storage.sync.set({ schedIntervalMin: minutes })
})
schedSuggestionsInput.addEventListener('change', () => {
  chrome.storage.sync.set({ schedStartSuggestions: schedSuggestionsInput.checked === true })
})
schedMaxStartsInput.addEventListener('change', () => {
  const maxStarts = readClampedNumber(schedMaxStartsInput, 1, 500, 20)
  schedMaxStartsInput.value = String(maxStarts)
  chrome.storage.sync.set({ schedMaxStarts: maxStarts })
})

// --- Repository picker ---
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

// --- Start operation ---
mainForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  // Save settings first, ensuring token is only in local storage
  chrome.storage.sync.set({
    ghOwner: ghOwnerInput.value.trim().slice(0, MAX_OWNER_LEN)
  })
  chrome.storage.sync.remove('ghToken')
  chrome.storage.local.set({
    ghToken: ghTokenInput.value.trim().slice(0, MAX_TOKEN_LEN)
  })

  const mode = document.querySelector('input[name="mode"]:checked').value
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

  if (mode === 'run' && forceCheckbox.checked && opMode === 'archive') {
    if (
      !window.confirm(
        '⚠️ WARNING: You are about to FORCE archive tasks.\n\nThis will ignore task state and open Pull Requests.\n\nAre you sure you want to proceed?'
      )
    ) {
      return
    }
  }

  const options = {
    dryRun: mode === 'dry',
    force: forceCheckbox.checked,
    scope,
    activeTabId,
    opMode,
    repoFilter: (customRepoInput.value.trim() || repoFilterInput.value).trim()
  }

  // Reset UI
  startBtn.disabled = true
  startBtn.setAttribute('aria-busy', 'true')
  startBtn.textContent = getRunningText()
  resetBtn.classList.add('hidden')
  // A previous Export JSON result belongs to that run only.
  downloadBtn.classList.add('hidden')
  lastExportData = null
  progressSection.classList.remove('hidden')
  summarySection.classList.add('hidden')
  currentInfo.textContent = 'Starting...'
  progressFill.style.width = '0%'
  progressFill.style.background = '' // Reset error color if present
  logPre.textContent = ''

  chrome.runtime.sendMessage({ action: 'START', options })
})

// --- Reset ---
resetBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'RESET' })
  startBtn.disabled = false
  startBtn.removeAttribute('aria-busy')
  updateOpModeUI(opMode)
  resetBtn.classList.add('hidden')
  downloadBtn.classList.add('hidden')
  progressSection.classList.add('hidden')
  summarySection.classList.add('hidden')
  // Move focus back to the primary action so keyboard users are not stranded
  // on the now-hidden Reset button.
  startBtn.focus()
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
  // Log
  if (state.log?.length > 0) {
    logPre.textContent = state.log.join('\n')
    logPre.scrollTop = logPre.scrollHeight
    progressSection.classList.remove('hidden')
  }

  // Current info
  if (state.status === 'running') {
    const parts = []
    if (state.currentTab) parts.push(state.currentTab)
    if (state.currentRepo) parts.push(state.currentRepo)
    currentInfo.textContent = parts.join(' > ')

    if (state.progress?.total > 0) {
      const pct = Math.round(((state.progress.archived + state.progress.skipped) / state.progress.total) * 100)
      progressFill.style.width = `${pct}%`
      progressFill.parentElement.setAttribute('aria-valuenow', String(pct))
      currentInfo.textContent += ` [${state.progress.archived + state.progress.skipped}/${state.progress.total}]`
    }
  }

  // Done or error
  if (state.status === 'done' || state.status === 'error') {
    startBtn.disabled = false
    startBtn.removeAttribute('aria-busy')
    updateOpModeUI(opMode)
    resetBtn.classList.remove('hidden')
    progressFill.style.width = '100%'
    progressFill.parentElement.setAttribute('aria-valuenow', '100')

    if (state.status === 'done') {
      currentInfo.textContent = 'Complete'
      renderSummary(state.results)
      if (state.exportData) {
        lastExportData = state.exportData
        downloadBtn.classList.remove('hidden')
        downloadBtn.textContent = `⬇ Download Suggestions JSON (${state.exportData.totalSuggestions || 0} found)`
      }
    } else {
      currentInfo.textContent = `Error: ${state.error}`
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
    emptyDiv.style.marginTop = '4px'
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
chrome.runtime.sendMessage({ action: 'GET_STATE' }, (state) => {
  if (state && state.status !== 'idle') {
    // Rehydrate opMode if it's available in the state options
    if (state.options?.opMode) {
      opMode = state.options.opMode
    }
    renderState(state)
    if (state.status === 'running') {
      startBtn.disabled = true
      startBtn.setAttribute('aria-busy', 'true')
      startBtn.textContent = getRunningText()
    } else {
      resetBtn.classList.remove('hidden')
    }
  }
})

// --- Export download (re-save; the background already saved one copy) ---
let lastExportData = null

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
