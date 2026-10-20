// Modified by tommyzed: Updated popup unit test assertions
const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const popupJsPath = path.join(__dirname, '../popup.js')
const popupJs = fs.readFileSync(popupJsPath, 'utf8')
const itemsJsPath = path.join(__dirname, '../items.js')
const itemsJs = fs.readFileSync(itemsJsPath, 'utf8')
const settingsJsPath = path.join(__dirname, '../settings.js')
const settingsJs = fs.readFileSync(settingsJsPath, 'utf8')
const popupHtml = fs.readFileSync(path.join(__dirname, '../popup.html'), 'utf8')
const { RUN_PROTOCOL, START_OPTION_KEYS } = require('../settings.js')

/**
 * Creates a mock DOM element with basic functionality.
 */
function createMockElement(tag = 'div', attrs = {}) {
  const element = {
    tagName: tag.toUpperCase(),
    attributes: { ...attrs },
    dataset: attrs.dataset || {},
    children: [],
    classList: {
      classes: new Set(),
      toggle: (cls, val) => {
        if (val === undefined) {
          if (element.classList.classes.has(cls)) element.classList.classes.delete(cls)
          else element.classList.classes.add(cls)
        } else if (val) {
          element.classList.classes.add(cls)
        } else {
          element.classList.classes.delete(cls)
        }
      },
      add: (cls) => element.classList.classes.add(cls),
      remove: (cls) => element.classList.classes.delete(cls),
      contains: (cls) => element.classList.classes.has(cls)
    },
    setAttribute: (name, val) => {
      element.attributes[name] = val
    },
    getAttribute: (name) => element.attributes[name],
    removeAttribute: (name) => {
      delete element.attributes[name]
    },
    addEventListener: (type, cb) => {
      if (!element.listeners) element.listeners = {}
      if (!element.listeners[type]) element.listeners[type] = []
      element.listeners[type].push(cb)
    },
    dispatchEvent: (type, eventProps = {}) => {
      const results = []
      if (element.listeners?.[type]) {
        for (const cb of element.listeners[type]) {
          results.push(cb({ target: element, preventDefault: () => {}, ...eventProps }))
        }
      }
      return Promise.all(results)
    },
    contains: (other) => other === element || element.children.some((c) => c.contains?.(other)),
    style: { display: '' },
    appendChild: (child) => {
      if (child.nodeType === 11) {
        // DocumentFragment
        for (const c of child.children) {
          element.children.push(c)
          c.parentElement = element
        }
        child.children = [] // Clear fragment
      } else {
        element.children.push(child)
        child.parentElement = element
      }
    },
    remove: () => {
      if (element.parentElement?.children) {
        element.parentElement.children = element.parentElement.children.filter((c) => c !== element)
      }
    },
    querySelectorAll: (_sel) => [],
    querySelector: (_sel) => null,
    focus: () => {
      element.focused = true
    },
    get textContent() {
      return element._text ?? ''
    },
    set textContent(value) {
      element._text = String(value)
      if (value === '') element.children = []
    },
    id: '',
    className: '',
    value: '',
    checked: false,
    disabled: false,
    focused: false,
    scrollHeight: 0,
    scrollTop: 0
  }
  return element
}

/**
 * Creates a mock Chrome extension API.
 */
function createMockChrome(syncStorage, localStorage, listeners, sent, tabs, hello) {
  const runtime = {
    lastError: undefined,
    onMessage: {
      addListener: (cb) => listeners.runtime.push(cb)
    }
  }
  let sendImpl = (msg, cb) => {
    sent.push(msg)
    if (!cb) return
    if (msg.action === 'GET_STATE') cb({ status: 'idle' })
    else if (msg.action === 'GET_ALL_SOURCES') cb({ repos: [] })
    else if (msg.action === 'START') cb({ ok: true })
    else cb()
  }
  // HELLO is answered here, so a test that replaces sendMessage still talks to
  // a background on the popup's protocol. hello.reply = null is a worker too
  // old to know HELLO: the port closes with no answer.
  Object.defineProperty(runtime, 'sendMessage', {
    enumerable: true,
    get() {
      const impl = sendImpl
      return (msg, cb) => {
        if (msg.action !== 'HELLO') return impl(msg, cb)
        sent.push(msg)
        if (!cb) return
        // 'never' is a worker still starting: the answer comes when a test calls
        // hello.answer (the latest) or one of hello.pending, or hello.fail(cb).
        if (hello.reply === 'never') {
          hello.answer = cb
          hello.pending = [...(hello.pending || []), cb]
          hello.fail = (pendingCb) => {
            runtime.lastError = { message: 'The message port closed before a response was received.' }
            pendingCb()
            runtime.lastError = undefined
          }
          return
        }
        if (hello.reply !== null) return cb(hello.reply)
        runtime.lastError = { message: 'The message port closed before a response was received.' }
        cb()
        runtime.lastError = undefined
      }
    },
    set(fn) {
      sendImpl = fn
    }
  })
  return {
    storage: {
      sync: {
        get: (keys, cb) => {
          const res = {}
          const kArray = Array.isArray(keys) ? keys : [keys]
          for (const k of kArray) {
            if (syncStorage[k] !== undefined) res[k] = syncStorage[k]
          }
          cb(res)
        },
        set: (obj, cb) => {
          Object.assign(syncStorage, obj)
          if (cb) cb()
        },
        remove: (keys, cb) => {
          for (const k of [].concat(keys)) delete syncStorage[k]
          if (cb) cb()
        }
      },
      local: {
        get: (keys, cb) => {
          const res = {}
          const kArray = Array.isArray(keys) ? keys : [keys]
          for (const k of kArray) {
            if (localStorage[k] !== undefined) res[k] = localStorage[k]
          }
          cb(res)
        },
        set: (obj, cb) => {
          Object.assign(localStorage, obj)
          if (cb) cb()
        },
        remove: (key, cb) => {
          delete localStorage[key]
          if (cb) cb()
        }
      },
      onChanged: {
        addListener: (cb) => listeners.storage.push(cb)
      }
    },
    runtime,
    tabs: {
      query: (opts) => Promise.resolve(opts?.url ? tabs : [{ id: 123 }]),
      // Repo-picker fallback (GET_CODEBASES) runs when GET_ALL_SOURCES is empty.
      // Answer with a repo so the popup does not schedule retry timers.
      sendMessage: (_tabId, msg, cb) => {
        if (cb) cb(msg.action === 'GET_CODEBASES' ? { codebases: ['owner/scraped'] } : undefined)
      }
    }
  }
}

/**
 * Creates a mock <select> with the popup's static "All Repositories" option.
 */
function createMockSelect() {
  const select = createMockElement('select')
  select.value = ''
  select.options = [{ value: '', textContent: 'All Repositories' }]
  select.remove = (i) => select.options.splice(i, 1)
  select.appendChild = (opt) => select.options.push(opt)
  return select
}

const ELEMENT_IDS = [
  'moreToggle',
  'morePanel',
  'moreAll',
  'moreRepoScope',
  'moreRepo',
  'moreCategory',
  'moreLoad',
  'moreStatus',
  'moreChips',
  'moreList',
  'moreSelectAll',
  'moreDryRun',
  'moreForce',
  'moreAction',
  'moreConfirm',
  'itemsBtn',
  'itemsBtnText',
  'itemsMenu',
  'dryRun',
  'force',
  'addMessage',
  'message',
  'messageHint',
  'oneSessionRow',
  'oneSession',
  'proceedBtn',
  'archiveBtn',
  'exportBtn',
  'ghOwner',
  'ghToken',
  'customRepoInput',
  'resetBtn',
  'downloadBtn',
  'logStatus',
  'idleText',
  'currentInfo',
  'progressFill',
  'log',
  'summarySection',
  'summary',
  'tabStatus',
  'tabStatusText',
  'schedEnabled',
  'schedInterval',
  'schedSuggestions',
  'schedMaxStarts',
  'schedNext',
  'settingsToggle',
  'scheduleToggle',
  'settingsPanel',
  'schedulePanel',
  'mainView',
  'requestTimeoutSec',
  'listTimeoutSec',
  'extraJitter',
  'extraJitterMaxSec',
  'perAccountParallel',
  'totalParallel',
  'runLimit',
  'reloadTabOnSignIn',
  'defaultReply',
  'defaultRetry',
  'rpcInputs',
  'archiveBatch',
  'archiveSplit',
  'apiStates',
  'apiStatus',
  'rediscoverBtn',
  'resetApiBtn',
  'staleBanner',
  'settingsStatus'
]

function setupPopupSandbox({
  sync = {},
  local = {},
  tabs = [],
  confirm = () => true,
  hello = { protocol: RUN_PROTOCOL }
} = {}) {
  const helloState = { reply: hello }
  const syncStorage = { ...sync }
  const localStorage = { ...local }
  const listeners = { storage: [], runtime: [] }
  const sent = []
  const confirms = []
  const radioStates = { scope: 'all' }

  const elements = {}
  for (const id of ELEMENT_IDS) elements[`#${id}`] = createMockElement('div')
  elements['#repoFilter'] = createMockSelect()
  elements['#dryRun'].checked = true
  elements['#moreAll'].checked = true
  elements['#moreCategory'].value = 'all'
  elements['#morePanel'].classList.add('hidden')
  elements['#message'].disabled = true
  elements['#oneSessionRow'].classList.add('hidden')
  elements['#settingsPanel'].classList.add('hidden')
  elements['#staleBanner'].classList.add('hidden')
  elements['#schedulePanel'].classList.add('hidden')
  elements['#settingsToggle'].setAttribute('aria-expanded', 'false')
  elements['#scheduleToggle'].setAttribute('aria-expanded', 'false')
  const tips = [createMockElement('span'), createMockElement('span')]
  elements['#progressFill'].parentElement = createMockElement('div')

  const documentListeners = {}
  const document = {
    querySelector: (sel) => {
      if (sel === 'input[name="scope"]:checked') return { value: radioStates.scope }
      if (elements[sel]) return elements[sel]
      return createMockElement()
    },
    querySelectorAll: (sel) => (sel === '.tip' ? tips : []),
    createElement: (tag) => createMockElement(tag),
    createDocumentFragment: () => {
      const frag = createMockElement('documentfragment')
      frag.nodeType = 11
      return frag
    },
    addEventListener: (type, cb) => {
      documentListeners[type] = documentListeners[type] || []
      documentListeners[type].push(cb)
    }
  }
  const chrome = createMockChrome(syncStorage, localStorage, listeners, sent, tabs, helloState)

  const sandbox = {
    chrome,
    document,
    window: {
      confirm: (text) => {
        confirms.push(text)
        return confirm(text)
      }
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Math,
    String,
    Array,
    Object,
    URL
  }
  vm.createContext(sandbox)
  vm.runInContext(itemsJs, sandbox, { filename: itemsJsPath })
  vm.runInContext(settingsJs, sandbox, { filename: settingsJsPath })

  const load = () => vm.runInContext(popupJs, sandbox, { filename: popupJsPath })
  const starts = () => sent.filter((m) => m.action === 'START').map((m) => JSON.parse(JSON.stringify(m.options)))
  const options = () =>
    elements['#itemsMenu'].children.flatMap((g) => g.children.filter((c) => c.attributes.role === 'option'))
  const option = (label) => options().find((o) => o.attributes['aria-label'] === label)
  const tick = () => new Promise((r) => setTimeout(r, 0))

  return {
    sandbox,
    elements,
    syncStorage,
    localStorage,
    listeners,
    sent,
    confirms,
    radioStates,
    documentListeners,
    tips,
    load,
    starts,
    options,
    option,
    tick,
    helloState
  }
}

describe('Items dropdown', () => {
  it('lists All, every task state with its code, then Suggestions, in two groups', () => {
    const env = setupPopupSandbox()
    env.load()
    const groups = env.elements['#itemsMenu'].children
    assert.deepStrictEqual(
      groups.map((g) => g.children[0].textContent),
      ['Tasks', 'Suggestions']
    )
    assert.deepStrictEqual(
      env.options().map((o) => o.attributes['aria-label']),
      [
        'All',
        'Waiting on You (12)',
        'Awaiting Plan Approval (10)',
        'Error (4)',
        'Paused (8)',
        'In Progress (2)',
        'Planning (9)',
        'Queued (1)',
        'Queued Restart (11)',
        'Completed (3)',
        'Completed (7)',
        'Unknown (0)',
        'Suggestions'
      ]
    )
  })

  it('shows the state code as a badge next to the name', () => {
    const env = setupPopupSandbox()
    env.load()
    const opt = env.option('Waiting on You (12)')
    assert.strictEqual(opt.children[0].textContent, 'Waiting on You')
    assert.strictEqual(opt.children[1].className, 'n')
    assert.strictEqual(opt.children[1].textContent, '12')
  })

  it('starts on All', () => {
    const env = setupPopupSandbox()
    env.load()
    assert.strictEqual(env.elements['#itemsBtnText'].textContent, 'All')
    assert.strictEqual(env.option('All').attributes['aria-selected'], 'true')
  })

  it('selects an option on click, closes the menu and remembers the choice', () => {
    const env = setupPopupSandbox()
    env.load()
    env.elements['#itemsBtn'].dispatchEvent('click')
    assert.strictEqual(env.elements['#itemsBtn'].attributes['aria-expanded'], 'true')
    env.option('Error (4)').dispatchEvent('click')
    assert.strictEqual(env.elements['#itemsBtnText'].textContent, 'Error (4)')
    assert.strictEqual(env.option('Error (4)').attributes['aria-selected'], 'true')
    assert.strictEqual(env.option('All').attributes['aria-selected'], 'false')
    assert.strictEqual(env.elements['#itemsBtn'].attributes['aria-expanded'], 'false')
    assert.strictEqual(env.syncStorage.item, 'state:4')
  })

  it('works from the keyboard', () => {
    const env = setupPopupSandbox()
    env.load()
    const btn = env.elements['#itemsBtn']
    const menu = env.elements['#itemsMenu']
    btn.dispatchEvent('keydown', { key: 'ArrowDown' })
    assert.strictEqual(btn.attributes['aria-expanded'], 'true')
    assert.strictEqual(menu.attributes['aria-activedescendant'], env.option('All').id)
    menu.dispatchEvent('keydown', { key: 'ArrowDown' })
    menu.dispatchEvent('keydown', { key: 'ArrowDown' })
    assert.strictEqual(menu.attributes['aria-activedescendant'], env.option('Awaiting Plan Approval (10)').id)
    menu.dispatchEvent('keydown', { key: 'Enter' })
    assert.strictEqual(env.elements['#itemsBtnText'].textContent, 'Awaiting Plan Approval (10)')
    assert.strictEqual(btn.attributes['aria-expanded'], 'false')
    assert.strictEqual(btn.focused, true)

    btn.dispatchEvent('keydown', { key: 'Enter' })
    menu.dispatchEvent('keydown', { key: 'End' })
    assert.strictEqual(menu.attributes['aria-activedescendant'], env.option('Suggestions').id)
    menu.dispatchEvent('keydown', { key: 'Escape' })
    assert.strictEqual(btn.attributes['aria-expanded'], 'false')
    assert.strictEqual(
      env.elements['#itemsBtnText'].textContent,
      'Awaiting Plan Approval (10)',
      'Escape keeps the choice'
    )
  })

  it('closes when clicking elsewhere', () => {
    const env = setupPopupSandbox()
    env.load()
    env.elements['#itemsBtn'].dispatchEvent('click')
    for (const cb of env.documentListeners.click) cb({ target: env.elements['#proceedBtn'] })
    assert.strictEqual(env.elements['#itemsBtn'].attributes['aria-expanded'], 'false')
  })

  it('restores the remembered item', () => {
    const env = setupPopupSandbox({ sync: { item: 'state:12' } })
    env.load()
    assert.strictEqual(env.elements['#itemsBtnText'].textContent, 'Waiting on You (12)')
  })

  it('selects nothing, rather than All, for a remembered item that no longer exists', () => {
    const env = setupPopupSandbox({ sync: { item: 'state:99' } })
    env.load()
    assert.strictEqual(env.elements['#itemsBtnText'].textContent, 'Choose an item')
    assert.strictEqual(env.elements['#proceedBtn'].disabled, true)
    env.option('All').dispatchEvent('click')
    assert.strictEqual(env.elements['#itemsBtnText'].textContent, 'All')
    assert.strictEqual(env.elements['#proceedBtn'].disabled, false)
  })

  it('shows "One session for all" only for Suggestions', () => {
    const env = setupPopupSandbox()
    env.load()
    const row = env.elements['#oneSessionRow']
    assert.strictEqual(row.classList.contains('hidden'), true)
    env.option('Suggestions').dispatchEvent('click')
    assert.strictEqual(row.classList.contains('hidden'), false)
    env.option('Error (4)').dispatchEvent('click')
    assert.strictEqual(row.classList.contains('hidden'), true)
  })

  it('explains what the message does for the chosen item', () => {
    const env = setupPopupSandbox()
    env.load()
    const hint = env.elements['#messageHint']
    env.option('Waiting on You (12)').dispatchEvent('click')
    assert.match(hint.textContent, /Added after the default reply/)
    env.option('Completed (3)').dispatchEvent('click')
    assert.match(hint.textContent, /follow-up/)
    env.option('Error (4)').dispatchEvent('click')
    assert.match(hint.textContent, /retry/)
    env.option('Suggestions').dispatchEvent('click')
    assert.match(hint.textContent, /prompt/)
  })
})

describe('Settings and Schedule toggles', () => {
  it('open one panel at a time, and close it on a second click', () => {
    const env = setupPopupSandbox()
    env.load()
    const [sBtn, cBtn] = [env.elements['#settingsToggle'], env.elements['#scheduleToggle']]
    const [sPanel, cPanel] = [env.elements['#settingsPanel'], env.elements['#schedulePanel']]
    sBtn.dispatchEvent('click')
    assert.deepStrictEqual(
      [sBtn.attributes['aria-expanded'], sPanel.classList.contains('hidden'), cPanel.classList.contains('hidden')],
      ['true', false, true]
    )
    cBtn.dispatchEvent('click')
    assert.deepStrictEqual(
      [sBtn.attributes['aria-expanded'], cBtn.attributes['aria-expanded'], sPanel.classList.contains('hidden')],
      ['false', 'true', true]
    )
    cBtn.dispatchEvent('click')
    assert.strictEqual(cPanel.classList.contains('hidden'), true)
    assert.strictEqual(cBtn.attributes['aria-expanded'], 'false')
  })

  it('an open panel takes the place of the controls and log', () => {
    const env = setupPopupSandbox()
    env.load()
    env.elements['#settingsToggle'].dispatchEvent('click')
    assert.strictEqual(env.elements['#mainView'].classList.contains('hidden'), true)
    env.elements['#settingsToggle'].dispatchEvent('click')
    assert.strictEqual(env.elements['#mainView'].classList.contains('hidden'), false)
  })

  it('closes the panel when a run starts, to show the log', async () => {
    const env = setupPopupSandbox()
    env.load()
    env.elements['#scheduleToggle'].dispatchEvent('click')
    await env.elements['#exportBtn'].dispatchEvent('click')
    assert.strictEqual(env.elements['#schedulePanel'].classList.contains('hidden'), true)
    assert.strictEqual(env.elements['#mainView'].classList.contains('hidden'), false)
  })
})

describe('Tooltips', () => {
  it('Escape hides them until the pointer or focus leaves', () => {
    const env = setupPopupSandbox()
    env.load()
    for (const cb of env.documentListeners.keydown) cb({ key: 'Escape' })
    assert.ok(env.tips.every((t) => t.classList.contains('tip-off')))
    env.tips[0].dispatchEvent('mouseleave')
    env.tips[1].dispatchEvent('focusout')
    assert.ok(env.tips.every((t) => !t.classList.contains('tip-off')))
  })
})

describe('Message box', () => {
  it('is disabled until "Add a message" is checked', () => {
    const env = setupPopupSandbox()
    env.load()
    assert.strictEqual(env.elements['#message'].disabled, true)
    env.elements['#addMessage'].checked = true
    env.elements['#addMessage'].dispatchEvent('change')
    assert.strictEqual(env.elements['#message'].disabled, false)
    assert.strictEqual(env.elements['#message'].focused, true)
  })

  it('saves the message while typing, so closing the popup does not lose it', async () => {
    const env = setupPopupSandbox()
    env.load()
    env.elements['#message'].value = 'Half-typed'
    env.elements['#message'].dispatchEvent('input')
    assert.strictEqual(env.syncStorage.message, undefined, 'not on every keystroke')
    await new Promise((r) => setTimeout(r, 450))
    assert.strictEqual(env.syncStorage.message, 'Half-typed')
  })

  it('remembers the message between popup openings', () => {
    const env = setupPopupSandbox({ sync: { message: 'Keep going' } })
    env.load()
    assert.strictEqual(env.elements['#message'].value, 'Keep going')
    env.elements['#message'].value = '  New text  '
    env.elements['#message'].dispatchEvent('change')
    assert.strictEqual(env.syncStorage.message, 'New text')
  })
})

describe('Proceed, Archive and Export', () => {
  it('Proceed sends a dry run of the chosen item by default', async () => {
    const env = setupPopupSandbox()
    env.load()
    env.option('Waiting on You (12)').dispatchEvent('click')
    await env.elements['#proceedBtn'].dispatchEvent('click')
    assert.deepStrictEqual(env.starts(), [
      {
        action: 'proceed',
        item: 'state:12',
        dryRun: true,
        force: false,
        message: '',
        oneSession: false,
        scope: 'all',
        activeTabId: null,
        repoFilter: ''
      }
    ])
    assert.deepStrictEqual(env.confirms, [], 'a dry run never asks')
  })

  it('Archive sends the archive action', async () => {
    const env = setupPopupSandbox()
    env.load()
    env.option('Completed (3)').dispatchEvent('click')
    await env.elements['#archiveBtn'].dispatchEvent('click')
    const [start] = env.starts()
    assert.strictEqual(start.action, 'archive')
    assert.strictEqual(start.item, 'state:3')
  })

  it('sends the message only when "Add a message" is checked', async () => {
    const env = setupPopupSandbox()
    env.load()
    env.elements['#message'].value = '  Ship it  '
    await env.elements['#proceedBtn'].dispatchEvent('click')
    env.sandbox.setIdle()
    env.elements['#addMessage'].checked = true
    await env.elements['#proceedBtn'].dispatchEvent('click')
    assert.deepStrictEqual(
      env.starts().map((s) => s.message),
      ['', 'Ship it']
    )
  })

  it('caps the message length', async () => {
    const env = setupPopupSandbox()
    env.load()
    env.elements['#addMessage'].checked = true
    env.elements['#message'].value = 'x'.repeat(5000)
    await env.elements['#proceedBtn'].dispatchEvent('click')
    assert.strictEqual(env.starts()[0].message.length, 2000)
  })

  it('sends "One session for all" only for Suggestions', async () => {
    const env = setupPopupSandbox()
    env.load()
    env.elements['#oneSession'].checked = true
    await env.elements['#proceedBtn'].dispatchEvent('click')
    env.sandbox.setIdle()
    env.option('Suggestions').dispatchEvent('click')
    await env.elements['#proceedBtn'].dispatchEvent('click')
    assert.deepStrictEqual(
      env.starts().map((s) => [s.item, s.oneSession]),
      [
        ['all', false],
        ['suggestions', true]
      ]
    )
  })

  it('sends the selected or typed repository', async () => {
    const env = setupPopupSandbox()
    env.load()
    env.elements['#repoFilter'].value = 'a/one'
    await env.elements['#archiveBtn'].dispatchEvent('click')
    env.sandbox.setIdle()
    env.elements['#customRepoInput'].value = ' typed/repo '
    await env.elements['#archiveBtn'].dispatchEvent('click')
    assert.deepStrictEqual(
      env.starts().map((s) => s.repoFilter),
      ['a/one', 'typed/repo']
    )
  })

  it('sends the current tab for the "Current tab" scope', async () => {
    const env = setupPopupSandbox()
    env.load()
    env.radioStates.scope = 'current'
    await env.elements['#proceedBtn'].dispatchEvent('click')
    assert.deepStrictEqual([env.starts()[0].scope, env.starts()[0].activeTabId], ['current', 123])
  })

  it('Export suggestions always runs for real', async () => {
    const env = setupPopupSandbox()
    env.load()
    await env.elements['#exportBtn'].dispatchEvent('click')
    const [start] = env.starts()
    assert.strictEqual(start.action, 'export')
    assert.strictEqual(start.dryRun, false)
  })

  it('disables every run button while a run is going and labels the one that started it', async () => {
    const env = setupPopupSandbox()
    env.load()
    env.elements['#dryRun'].checked = false
    env.option('Error (4)').dispatchEvent('click')
    await env.elements['#archiveBtn'].dispatchEvent('click')
    for (const id of ['#proceedBtn', '#archiveBtn', '#exportBtn']) assert.strictEqual(env.elements[id].disabled, true)
    assert.strictEqual(env.elements['#archiveBtn'].textContent, '⏳ Archiving…')
    assert.strictEqual(env.elements['#archiveBtn'].attributes['aria-busy'], 'true')
    await env.elements['#proceedBtn'].dispatchEvent('click')
    assert.strictEqual(env.starts().length, 1, 'a second click does not start a second run')
  })

  it('locks the buttons before waiting for the current tab, so a double click starts one run', async () => {
    const env = setupPopupSandbox()
    env.load()
    env.radioStates.scope = 'current'
    let answer
    env.sandbox.chrome.tabs.query = () =>
      new Promise((resolve) => {
        answer = () => resolve([{ id: 7 }])
      })
    const first = env.elements['#proceedBtn'].dispatchEvent('click')
    const second = env.elements['#archiveBtn'].dispatchEvent('click')
    assert.strictEqual(env.elements['#proceedBtn'].disabled, true)
    answer()
    await Promise.all([first, second])
    assert.deepStrictEqual(
      env.starts().map((s) => [s.action, s.activeTabId]),
      [['proceed', 7]]
    )
  })

  it('re-enables the buttons and shows the error when the background rejects the run', async () => {
    const env = setupPopupSandbox()
    env.sandbox.chrome.runtime.sendMessage = (msg, cb) => {
      if (msg.action === 'START') cb({ error: 'Unknown item "x"' })
      else if (cb) cb(msg.action === 'GET_STATE' ? { status: 'idle' } : { repos: ['a/b'] })
    }
    env.load()
    await env.elements['#proceedBtn'].dispatchEvent('click')
    assert.strictEqual(env.elements['#proceedBtn'].disabled, false)
    assert.strictEqual(env.elements['#currentInfo'].textContent, 'Error: Unknown item "x"')
  })
})

describe('Background version check', () => {
  const startMessages = (env) => env.sent.filter((m) => m.action === 'START')

  it('blocks every run when the worker is too old to answer HELLO', async () => {
    const env = setupPopupSandbox({ hello: null })
    env.load()
    await env.tick()
    assert.strictEqual(env.elements['#staleBanner'].classList.contains('hidden'), false)
    for (const id of ['#proceedBtn', '#archiveBtn', '#exportBtn']) assert.strictEqual(env.elements[id].disabled, true)
    for (const id of ['#schedEnabled', '#schedInterval', '#schedSuggestions', '#schedMaxStarts']) {
      assert.strictEqual(env.elements[id].disabled, true, `${id} is locked: the old worker would act on it`)
    }
    env.elements['#dryRun'].checked = false
    env.option('Waiting on You (12)').dispatchEvent('click')
    await env.elements['#proceedBtn'].dispatchEvent('click')
    assert.deepStrictEqual(startMessages(env), [])
  })

  it('blocks every run when the worker speaks another protocol', async () => {
    const env = setupPopupSandbox({ hello: { protocol: RUN_PROTOCOL - 1 } })
    env.load()
    await env.tick()
    assert.strictEqual(env.elements['#staleBanner'].classList.contains('hidden'), false)
    assert.strictEqual(env.elements['#archiveBtn'].disabled, true)
  })

  it('checks again before each run, in case the worker changed since the popup opened', async () => {
    const env = setupPopupSandbox()
    env.load()
    await env.tick()
    assert.strictEqual(env.elements['#staleBanner'].classList.contains('hidden'), true)
    env.helloState.reply = null
    await env.elements['#proceedBtn'].dispatchEvent('click')
    assert.deepStrictEqual(startMessages(env), [])
    assert.strictEqual(env.elements['#staleBanner'].classList.contains('hidden'), false)
    assert.strictEqual(env.elements['#proceedBtn'].disabled, true)
    assert.match(env.elements['#currentInfo'].textContent, /reload the extension/)
  })

  it('keeps the buttons off when a run ends with a stale worker', async () => {
    const env = setupPopupSandbox({ hello: null })
    env.load()
    await env.tick()
    for (const listener of env.listeners.storage) {
      listener({
        archiveState: { newValue: { status: 'done', log: [], progress: { archived: 0, skipped: 0, total: 0 } } }
      })
    }
    assert.strictEqual(env.elements['#proceedBtn'].disabled, true)
  })

  it('keeps the schedule locked until the worker answers HELLO', async () => {
    const env = setupPopupSandbox({ hello: 'never' })
    env.load()
    await env.tick()
    const ids = ['#schedEnabled', '#schedInterval', '#schedSuggestions', '#schedMaxStarts']
    for (const id of ids) assert.strictEqual(env.elements[id].disabled, true, `${id} waits for the version check`)
    env.elements['#schedEnabled'].checked = true
    env.elements['#schedEnabled'].dispatchEvent('change')
    env.elements['#schedMaxStarts'].value = '9'
    env.elements['#schedMaxStarts'].dispatchEvent('change')
    assert.strictEqual(env.syncStorage.schedEnabled, undefined, 'no schedule write before the worker is known')
    assert.strictEqual(env.syncStorage.schedMaxStarts, undefined)
    env.helloState.answer({ protocol: RUN_PROTOCOL })
    await env.tick()
    for (const id of ids) assert.strictEqual(env.elements[id].disabled, false)
    env.elements['#schedEnabled'].dispatchEvent('change')
    assert.strictEqual(env.syncStorage.schedEnabled, true)
  })

  it('stays locked when the first HELLO answers late, after a check before a run failed', async () => {
    const env = setupPopupSandbox({ hello: 'never' })
    env.load()
    await env.tick()
    const firstAnswer = env.helloState.answer
    env.helloState.reply = null
    env.option('Waiting on You (12)').dispatchEvent('click')
    await env.elements['#proceedBtn'].dispatchEvent('click')
    assert.strictEqual(env.elements['#staleBanner'].classList.contains('hidden'), false)
    firstAnswer({ protocol: RUN_PROTOCOL })
    await env.tick()
    assert.strictEqual(env.elements['#schedEnabled'].disabled, true, 'a stale worker stays stale')
    env.elements['#schedEnabled'].checked = true
    env.elements['#schedEnabled'].dispatchEvent('change')
    assert.strictEqual(env.syncStorage.schedEnabled, undefined)
  })

  it('does not start when the popup went stale while the check before the run was out', async () => {
    const env = setupPopupSandbox({ hello: 'never' })
    env.load()
    await env.tick()
    env.option('Waiting on You (12)').dispatchEvent('click')
    const click = env.elements['#proceedBtn'].dispatchEvent('click')
    await env.tick()
    const [initial, beforeRun] = env.helloState.pending
    env.helloState.fail(initial)
    await env.tick()
    beforeRun({ protocol: RUN_PROTOCOL })
    await click
    assert.deepStrictEqual(startMessages(env), [])
    assert.strictEqual(env.elements['#staleBanner'].classList.contains('hidden'), false)
  })

  it('sends its protocol and only options the background knows', async () => {
    const env = setupPopupSandbox()
    env.load()
    env.option('Suggestions').dispatchEvent('click')
    env.elements['#oneSession'].checked = true
    await env.elements['#proceedBtn'].dispatchEvent('click')
    env.option('Waiting on You (12)').dispatchEvent('click')
    env.elements['#force'].checked = true
    env.elements['#addMessage'].checked = true
    env.elements['#message'].value = 'go'
    await env.elements['#archiveBtn'].dispatchEvent('click')
    await env.elements['#exportBtn'].dispatchEvent('click')
    const starts = startMessages(env)
    assert.ok(starts.length >= 1)
    for (const msg of starts) {
      assert.strictEqual(msg.protocol, RUN_PROTOCOL)
      for (const key of Object.keys(msg.options)) assert.ok(START_OPTION_KEYS.includes(key), `unknown option ${key}`)
    }
  })
})

describe('Live-run confirmations', () => {
  async function liveClick(env, label, button, { force = false, message = '' } = {}) {
    env.load()
    env.elements['#dryRun'].checked = false
    env.elements['#force'].checked = force
    if (message) {
      env.elements['#addMessage'].checked = true
      env.elements['#message'].value = message
    }
    env.option(label).dispatchEvent('click')
    await env.elements[button].dispatchEvent('click')
  }

  it('asks before archiving every task, and stops when cancelled', async () => {
    const env = setupPopupSandbox({ confirm: () => false })
    await liveClick(env, 'All', '#archiveBtn')
    assert.strictEqual(env.confirms.length, 1)
    assert.match(env.confirms[0], /Archive every task/)
    assert.deepStrictEqual(env.starts(), [])
  })

  it('archives every task once confirmed', async () => {
    const env = setupPopupSandbox({ confirm: () => true })
    await liveClick(env, 'All', '#archiveBtn')
    assert.strictEqual(env.starts().length, 1)
  })

  it('asks before a Force archive', async () => {
    const env = setupPopupSandbox({ confirm: () => false })
    await liveClick(env, 'Completed (3)', '#archiveBtn', { force: true })
    assert.match(env.confirms[0], /Force archive/)
    assert.deepStrictEqual(env.starts(), [])
  })

  it('asks before Force messages Completed tasks under All', async () => {
    const env = setupPopupSandbox({ confirm: () => false })
    await liveClick(env, 'All', '#proceedBtn', { force: true, message: 'More' })
    assert.match(env.confirms[0], /Completed tasks get your message/)
    assert.deepStrictEqual(env.starts(), [])
  })

  it('does not ask for an ordinary live Proceed or Archive', async () => {
    const env = setupPopupSandbox({ confirm: () => false })
    await liveClick(env, 'Waiting on You (12)', '#proceedBtn')
    env.sandbox.setIdle()
    await env.elements['#archiveBtn'].dispatchEvent('click')
    assert.deepStrictEqual(env.confirms, [])
    assert.strictEqual(env.starts().length, 2)
  })
})

describe('renderState', () => {
  it('shows progress while running', () => {
    const env = setupPopupSandbox()
    env.load()
    env.sandbox.renderState({
      status: 'running',
      currentTab: 'u/1',
      currentRepo: 'o/r',
      log: ['line 1', 'line 2'],
      progress: { archived: 3, skipped: 1, total: 8 },
      options: { dryRun: true }
    })
    assert.strictEqual(env.elements['#log'].textContent, 'line 1\nline 2')
    assert.strictEqual(env.elements['#log'].classList.contains('hidden'), false)
    assert.strictEqual(env.elements['#idleText'].classList.contains('hidden'), true)
    assert.strictEqual(env.elements['#progressFill'].style.width, '50%')
    assert.strictEqual(env.elements['#currentInfo'].textContent, 'u/1 > o/r [4/8]')
    assert.strictEqual(env.elements['#logStatus'].textContent, '4 / 8 · dry-run')
  })

  it('shows the summary and a Reset button when done', () => {
    const env = setupPopupSandbox()
    env.load()
    env.sandbox.setRunning('proceed', false)
    env.sandbox.renderState({ status: 'done', log: ['ok'], results: [{ label: 'u/0', count: 2 }], options: {} })
    assert.strictEqual(env.elements['#logStatus'].textContent, 'Done')
    assert.strictEqual(env.elements['#resetBtn'].classList.contains('hidden'), false)
    assert.strictEqual(env.elements['#proceedBtn'].disabled, false)
    assert.strictEqual(env.elements['#proceedBtn'].textContent, 'Proceed')
    assert.strictEqual(env.elements['#summarySection'].classList.contains('hidden'), false)
  })

  it('shows the error when the run failed', () => {
    const env = setupPopupSandbox()
    env.load()
    env.sandbox.renderState({ status: 'error', error: 'No Jules tabs found', log: ['x'], options: {} })
    assert.strictEqual(env.elements['#currentInfo'].textContent, 'Error: No Jules tabs found')
    assert.strictEqual(env.elements['#logStatus'].textContent, 'Error')
  })

  it('reacts to background state changes in storage', () => {
    const env = setupPopupSandbox()
    env.load()
    for (const cb of env.listeners.storage) {
      cb({ archiveState: { newValue: { status: 'error', error: 'boom', log: ['x'], options: {} } } })
    }
    assert.strictEqual(env.elements['#currentInfo'].textContent, 'Error: boom')
  })
})

describe('renderSummary', () => {
  it('renders an empty state message when no results are processed', () => {
    const env = setupPopupSandbox()
    env.load()
    env.sandbox.renderSummary([])
    assert.match(env.elements['#summary'].children[0].textContent, /No items were processed/)
  })

  it('creates one line per account and a total', () => {
    const env = setupPopupSandbox()
    env.load()
    env.sandbox.renderSummary([
      { label: 'u/0', count: 2 },
      { label: 'u/1', count: 0, err: 'boom' }
    ])
    const lines = env.elements['#summary'].children.map((c) => c.textContent)
    assert.deepStrictEqual(lines, ['u/0: 2 processed', 'u/1: ERROR - boom', 'TOTAL: 2 processed'])
  })
})

describe('Popup open', () => {
  it('rehydrates a running operation started earlier', () => {
    const env = setupPopupSandbox()
    env.sandbox.chrome.runtime.sendMessage = (msg, cb) => {
      if (!cb) return
      if (msg.action === 'GET_STATE') {
        cb({
          status: 'running',
          log: ['x'],
          progress: { archived: 0, skipped: 0, total: 0 },
          options: { action: 'archive', dryRun: false, item: { id: 'state:4' } }
        })
      } else cb({ repos: ['a/b'] })
    }
    env.load()
    assert.strictEqual(env.elements['#itemsBtnText'].textContent, 'Error (4)')
    assert.strictEqual(env.elements['#archiveBtn'].textContent, '⏳ Archiving…')
    assert.strictEqual(env.elements['#proceedBtn'].disabled, true)
  })

  it('counts the open Jules accounts and tabs', async () => {
    const env = setupPopupSandbox({
      tabs: [
        { id: 1, url: 'https://jules.google.com/u/0/session/1' },
        { id: 2, url: 'https://jules.google.com/u/1/' },
        { id: 3, url: 'https://jules.google.com/u/1/session/2' },
        { id: 4, url: 'https://jules.google.com/accounts.google.com' }
      ]
    })
    env.load()
    await env.tick()
    assert.strictEqual(env.elements['#tabStatusText'].textContent, '2 accounts · 3 tabs')
    assert.strictEqual(env.elements['#tabStatus'].classList.contains('off'), false)
  })

  it('says when no Jules tab is open', async () => {
    const env = setupPopupSandbox({ tabs: [] })
    env.load()
    await env.tick()
    assert.strictEqual(env.elements['#tabStatusText'].textContent, 'No Jules tab open')
    assert.strictEqual(env.elements['#tabStatus'].classList.contains('off'), true)
  })

  it('tells the user whether Dry-run is on', () => {
    const env = setupPopupSandbox()
    env.load()
    assert.match(env.elements['#idleText'].textContent, /Dry-run is on/)
    env.elements['#dryRun'].checked = false
    env.elements['#dryRun'].dispatchEvent('change')
    assert.match(env.elements['#idleText'].textContent, /Dry-run is off/)
  })

  it('migrates ghToken from sync to local storage', () => {
    const env = setupPopupSandbox({ sync: { ghToken: 'secret-token', ghOwner: 'some-owner' } })
    env.load()
    assert.strictEqual(env.localStorage.ghToken, 'secret-token')
    assert.strictEqual(env.syncStorage.ghToken, undefined)
    assert.strictEqual(env.elements['#ghToken'].value, 'secret-token')
    assert.strictEqual(env.elements['#ghOwner'].value, 'some-owner')
  })
})

describe('Repository picker', () => {
  it('populates options from GET_ALL_SOURCES', () => {
    const env = setupPopupSandbox()
    const base = env.sandbox.chrome.runtime.sendMessage
    env.sandbox.chrome.runtime.sendMessage = (msg, cb) => {
      if (msg.action === 'GET_ALL_SOURCES') return cb({ repos: ['a/one', 'b/two'] })
      return base(msg, cb)
    }
    env.load()
    assert.deepStrictEqual(
      env.elements['#repoFilter'].options.map((o) => o.value),
      ['', 'a/one', 'b/two']
    )
  })

  it('falls back to the content script codebases when GET_ALL_SOURCES is empty', async () => {
    const env = setupPopupSandbox()
    env.load()
    await env.tick()
    assert.deepStrictEqual(
      env.elements['#repoFilter'].options.map((o) => o.value),
      ['', 'owner/scraped']
    )
  })

  it('clears the typed repo when a dropdown option is chosen, and vice versa', () => {
    const env = setupPopupSandbox()
    env.load()
    env.elements['#customRepoInput'].value = 'typed/repo'
    env.elements['#repoFilter'].value = 'a/one'
    env.elements['#repoFilter'].dispatchEvent('change')
    assert.strictEqual(env.elements['#customRepoInput'].value, '')
    env.elements['#customRepoInput'].value = 'typed/repo'
    env.elements['#customRepoInput'].dispatchEvent('input')
    assert.strictEqual(env.elements['#repoFilter'].value, '')
  })
})

describe('Export download', () => {
  const doneWithExport = {
    status: 'done',
    log: ['done'],
    results: [{ label: 'default', count: 3 }],
    exportData: { totalSuggestions: 3, repositories: [] },
    options: {}
  }

  it('shows the download button when a finished run carries exportData', () => {
    const env = setupPopupSandbox()
    env.load()
    env.elements['#downloadBtn'].classList.add('hidden')
    env.sandbox.renderState(doneWithExport)
    assert.strictEqual(env.elements['#downloadBtn'].classList.contains('hidden'), false)
    assert.strictEqual(env.elements['#downloadBtn'].textContent, '⬇ Download suggestions JSON (3 found)')
  })

  it('names the button Export and says on it when the export is done', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8')
    const button = html.match(/<button[^>]*id="exportBtn"[^>]*>([\s\S]*?)<\/button>/)
    assert.ok(button, 'popup.html has #exportBtn')
    assert.match(button[1], /^\s*↓ Export\s*$/)
    assert.match(button[0], /title="[^"]*JSON file[^"]*"/, 'a tooltip says what Export makes')
    const env = setupPopupSandbox()
    env.load()
    env.sandbox.renderState(doneWithExport)
    assert.strictEqual(env.elements['#exportBtn'].textContent, '✓ 3 exported')
    env.sandbox.renderState({ status: 'idle', log: [], results: [], options: {} })
    env.elements['#resetBtn'].dispatchEvent('click')
    assert.strictEqual(env.elements['#exportBtn'].textContent, '↓ Export')
  })

  it('drops the finished export when a scheduled run starts', () => {
    const env = setupPopupSandbox()
    env.load()
    env.sandbox.renderState(doneWithExport)
    env.sandbox.renderState({
      status: 'running',
      log: ['=== SCHEDULED (chrome.alarms) ==='],
      results: [],
      progress: { archived: 0, skipped: 0, total: 0 },
      options: { action: 'archive', scheduled: true }
    })
    assert.strictEqual(env.elements['#exportBtn'].textContent.includes('exported'), false)
    assert.strictEqual(env.elements['#downloadBtn'].classList.contains('hidden'), true)
    assert.strictEqual(vm.runInContext('lastExportData', env.sandbox), null)
  })

  it('hides the download button on reset and returns focus to Proceed', () => {
    const env = setupPopupSandbox()
    env.load()
    env.elements['#downloadBtn'].classList.remove('hidden')
    env.elements['#resetBtn'].dispatchEvent('click')
    assert.strictEqual(env.elements['#downloadBtn'].classList.contains('hidden'), true)
    assert.strictEqual(env.elements['#proceedBtn'].focused, true)
    assert.ok(env.sent.some((m) => m.action === 'RESET'))
  })

  it('drops the previous export when another operation starts', async () => {
    const env = setupPopupSandbox()
    env.load()
    env.sandbox.renderState(doneWithExport)
    await env.elements['#proceedBtn'].dispatchEvent('click')
    assert.strictEqual(env.elements['#downloadBtn'].classList.contains('hidden'), true)
    assert.strictEqual(vm.runInContext('lastExportData', env.sandbox), null, 'stale export must not be downloadable')
  })
})

describe('Schedule settings', () => {
  it('turns the schedule on and off with a switch', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8')
    const input = html.match(/<input[^>]*id="schedEnabled"[^>]*>/)
    assert.ok(input)
    assert.match(input[0], /type="checkbox"/, 'still a checkbox for screen readers')
    assert.match(input[0], /class="switch"/)
  })

  it('loads and clamps the schedule fields', async () => {
    const env = setupPopupSandbox({ sync: { schedEnabled: true, schedIntervalMin: 30, schedMaxStarts: 7 } })
    env.load()
    await env.tick() // the schedule unlocks once the worker answers HELLO
    assert.strictEqual(env.elements['#schedEnabled'].checked, true)
    assert.strictEqual(env.elements['#schedInterval'].value, '30')
    env.elements['#schedInterval'].value = '99999'
    env.elements['#schedInterval'].dispatchEvent('change')
    assert.strictEqual(env.syncStorage.schedIntervalMin, 1440)
    env.elements['#schedMaxStarts'].value = 'abc'
    env.elements['#schedMaxStarts'].dispatchEvent('change')
    assert.strictEqual(env.syncStorage.schedMaxStarts, 20)
  })
})

describe('Settings panel', () => {
  const rpcInput = (env, i) => env.elements['#rpcInputs'].children[i].children[1]

  it('shows the defaults when nothing is saved', () => {
    const env = setupPopupSandbox()
    env.load()
    assert.strictEqual(env.elements['#requestTimeoutSec'].value, '30')
    assert.strictEqual(env.elements['#listTimeoutSec'].value, '300')
    assert.strictEqual(env.elements['#perAccountParallel'].value, '6')
    assert.strictEqual(env.elements['#totalParallel'].value, '12')
    assert.strictEqual(env.elements['#runLimit'].value, '0')
    assert.strictEqual(env.elements['#extraJitter'].checked, false)
    assert.strictEqual(env.elements['#extraJitterMaxSec'].disabled, true, 'the max is greyed out until jitter is on')
    assert.strictEqual(env.elements['#reloadTabOnSignIn'].checked, true)
    assert.strictEqual(env.elements['#defaultReply'].value, '')
  })

  it('loads saved settings and saves a change as one clamped object', () => {
    const env = setupPopupSandbox({ sync: { settings: { runLimit: 1, extraJitter: true, extraJitterMaxSec: 20 } } })
    env.load()
    assert.strictEqual(env.elements['#runLimit'].value, '1')
    assert.strictEqual(env.elements['#extraJitterMaxSec'].disabled, false)

    env.elements['#requestTimeoutSec'].value = '2'
    env.elements['#requestTimeoutSec'].dispatchEvent('change')
    assert.strictEqual(env.elements['#requestTimeoutSec'].value, '5', 'the field shows the clamped value')
    const saved = JSON.parse(JSON.stringify(env.syncStorage.settings))
    assert.strictEqual(saved.requestTimeoutSec, 5)
    assert.strictEqual(saved.runLimit, 1)
    assert.strictEqual(saved.extraJitterMaxSec, 20)
  })

  it('saves the default reply and retry texts under their own keys', () => {
    const env = setupPopupSandbox()
    env.load()
    env.elements['#defaultReply'].value = '  Keep going  '
    env.elements['#defaultReply'].dispatchEvent('change')
    assert.strictEqual(env.syncStorage.defaultReply, 'Keep going')
    assert.strictEqual(env.syncStorage.defaultRetry, '')
    assert.strictEqual('defaultReply' in env.syncStorage.settings, false, 'not inside the 8 KB settings item')
  })

  it("moves the old popup's reply boxes into the default reply and retry once", () => {
    const env = setupPopupSandbox({ sync: { continueMessage: 'Old reply', continueErrorMessage: 'Old retry' } })
    env.load()
    assert.strictEqual(env.elements['#defaultReply'].value, 'Old reply')
    assert.strictEqual(env.syncStorage.defaultRetry, 'Old retry')
    assert.strictEqual(env.syncStorage.continueMessage, undefined)
    assert.strictEqual(env.syncStorage.continueErrorMessage, undefined)
  })

  it('does not overwrite a default reply already set, and still retires the old keys', () => {
    const env = setupPopupSandbox({ sync: { defaultReply: 'New', continueMessage: 'Old reply' } })
    env.load()
    assert.strictEqual(env.elements['#defaultReply'].value, 'New')
    assert.strictEqual(env.syncStorage.defaultReply, 'New')
    assert.strictEqual(env.syncStorage.continueMessage, undefined)
  })

  it('says when sync storage refuses the settings, and keeps the old keys', () => {
    const env = setupPopupSandbox({ sync: { continueMessage: 'Old reply' } })
    env.sandbox.chrome.storage.sync.set = (_data, cb) => {
      env.sandbox.chrome.runtime.lastError = { message: 'QUOTA_BYTES_PER_ITEM quota exceeded' }
      cb?.()
      env.sandbox.chrome.runtime.lastError = undefined
    }
    env.load()
    assert.strictEqual(env.elements['#settingsStatus'].classList.contains('hidden'), false)
    assert.match(env.elements['#settingsStatus'].textContent, /Settings not saved: QUOTA_BYTES_PER_ITEM/)
    assert.strictEqual(env.syncStorage.continueMessage, 'Old reply')
  })

  it('shows the RPC ids and saves a valid change to local storage', () => {
    const env = setupPopupSandbox()
    env.load()
    assert.strictEqual(rpcInput(env, 0).value, 'p1Takd')
    rpcInput(env, 1).value = 'Zz9Yy'
    rpcInput(env, 1).dispatchEvent('change')
    assert.strictEqual(env.localStorage.julesApi.rpc.ArchiveTasks, 'Zz9Yy')
  })

  it('refuses a malformed RPC id and puts the old one back', () => {
    const env = setupPopupSandbox()
    env.load()
    rpcInput(env, 0).value = 'x'
    rpcInput(env, 0).dispatchEvent('change')
    assert.strictEqual(rpcInput(env, 0).value, 'p1Takd')
    assert.strictEqual(env.localStorage.julesApi, undefined)
    assert.match(env.elements['#apiStatus'].textContent, /5 or 6 letters or digits/)
  })

  it('rebuilds the Items dropdown from rediscovered states', () => {
    const states = [
      { code: 13, name: 'Waiting on You', kind: 'feedback' },
      { code: 3, name: 'Completed', kind: 'completed' }
    ]
    const env = setupPopupSandbox({ local: { julesApi: { states } } })
    env.load()
    const labels = env.options().map((o) => o.attributes['aria-label'])
    assert.ok(labels.includes('Waiting on You (13)'), labels.join(', '))
    assert.ok(!labels.some((l) => l.includes('(12)')))
    assert.match(env.elements['#apiStates'].textContent, /from Jules, 2 codes/)
  })

  it('never turns a saved item into All while its state table is still loading', async () => {
    const states = [
      { code: 13, name: 'Waiting on You', kind: 'feedback' },
      { code: 3, name: 'Completed', kind: 'completed' }
    ]
    const env = setupPopupSandbox({ sync: { item: 'state:13' }, local: { julesApi: { states } } })
    const localGet = env.sandbox.chrome.storage.local.get
    env.sandbox.chrome.storage.local.get = (keys, cb) => setTimeout(() => localGet(keys, cb), 0)
    env.load()
    assert.strictEqual(env.elements['#itemsBtnText'].textContent, 'Choose an item')
    assert.strictEqual(env.elements['#proceedBtn'].disabled, true)
    assert.strictEqual(env.elements['#archiveBtn'].disabled, true)
    await env.elements['#proceedBtn'].dispatchEvent('click')
    assert.deepStrictEqual(env.starts(), [])
    await env.tick()
    assert.strictEqual(env.elements['#itemsBtnText'].textContent, 'Waiting on You (13)')
    assert.strictEqual(env.elements['#proceedBtn'].disabled, false)
    await env.elements['#proceedBtn'].dispatchEvent('click')
    assert.deepStrictEqual(
      env.starts().map((s) => s.item),
      ['state:13']
    )
  })

  it('selects nothing, not All, when a rediscovery removes the chosen state', () => {
    const env = setupPopupSandbox()
    env.load()
    env.option('Waiting on You (12)').dispatchEvent('click')
    const states = [{ code: 3, name: 'Completed', kind: 'completed' }]
    for (const listener of env.listeners.storage) listener({ julesApi: { newValue: { states } } }, 'local')
    assert.strictEqual(env.elements['#itemsBtnText'].textContent, 'Choose an item')
    assert.strictEqual(env.elements['#archiveBtn'].disabled, true)
    assert.strictEqual(env.elements['#exportBtn'].disabled, false, 'Export needs no item')
  })

  it('asks the background to rediscover and shows what changed', () => {
    const env = setupPopupSandbox()
    env.load()
    const asked = []
    env.sandbox.chrome.runtime.sendMessage = (msg, cb) => {
      asked.push(msg.action)
      cb({ api: { rpc: { ArchiveTasks: 'Qq7Rr' } }, changes: ['ArchiveTasks: Tjmm5c → Qq7Rr'], problems: [] })
    }
    env.elements['#rediscoverBtn'].dispatchEvent('click')
    assert.deepStrictEqual(asked, ['REDISCOVER_API'])
    assert.strictEqual(rpcInput(env, 1).value, 'Qq7Rr')
    assert.match(env.elements['#apiStatus'].textContent, /Changed: ArchiveTasks: Tjmm5c → Qq7Rr/)
    assert.strictEqual(env.elements['#rediscoverBtn'].disabled, false)
  })

  it("shows the background's error when rediscovery fails", () => {
    const env = setupPopupSandbox()
    env.load()
    env.sandbox.chrome.runtime.sendMessage = (_msg, cb) => cb({ error: 'Open a Jules tab first.' })
    env.elements['#rediscoverBtn'].dispatchEvent('click')
    assert.strictEqual(env.elements['#apiStatus'].textContent, 'Open a Jules tab first.')
  })

  it('keeps a long rediscovery report short, with the whole of it in the tooltip', async () => {
    const env = setupPopupSandbox()
    const changes = ['ListTasks: p1Takd → Aa111', 'GetTask: n74qPd → Bb222', 'Interact: SLmX6 → Cc333']
    const problems = ['Dismiss not found; keeping sc1vFf', 'New state Awaiting Review (14) is not in the list']
    const base = env.sandbox.chrome.runtime.sendMessage
    env.sandbox.chrome.runtime.sendMessage = (msg, cb) =>
      msg.action === 'REDISCOVER_API' ? cb({ api: {}, changes, problems }) : base(msg, cb)
    env.load()
    await env.elements['#rediscoverBtn'].dispatchEvent('click')
    const status = env.elements['#apiStatus']
    assert.strictEqual(
      status.textContent,
      'Changed: ListTasks: p1Takd → Aa111; GetTask: n74qPd → Bb222 and 1 more. 2 problems; hover for details.'
    )
    for (const line of [...changes, ...problems]) assert.ok(status.title.includes(line), line)
  })

  it('resets the Jules API values to the built-in ones', () => {
    const env = setupPopupSandbox({ local: { julesApi: { rpc: { ListTasks: 'Abc12' } } } })
    env.load()
    assert.strictEqual(rpcInput(env, 0).value, 'Abc12')
    env.elements['#resetApiBtn'].dispatchEvent('click')
    assert.strictEqual(env.localStorage.julesApi, undefined)
    assert.strictEqual(rpcInput(env, 0).value, 'p1Takd')
  })
})

describe('popup.html', () => {
  it('loads items.js before popup.js', () => {
    assert.ok(popupHtml.indexOf('src="items.js"') < popupHtml.indexOf('src="popup.js"'))
  })

  it('has the Items listbox, the three checkboxes and the two run buttons', () => {
    assert.match(popupHtml, /id="itemsBtn"[^>]*aria-haspopup="listbox"|aria-haspopup="listbox"[\s\S]*?id="itemsBtn"/)
    assert.match(popupHtml, /id="itemsMenu" role="listbox"/)
    assert.match(popupHtml, /<input type="checkbox" id="dryRun" checked/)
    assert.match(popupHtml, /<input type="checkbox" id="force"/)
    assert.match(popupHtml, /<input type="checkbox" id="addMessage"/)
    assert.match(popupHtml, /id="proceedBtn">Proceed</)
    assert.match(popupHtml, /id="archiveBtn">Archive</)
  })

  it('caps and labels the message box', () => {
    assert.match(popupHtml, /<textarea\s+id="message"[\s\S]*?maxlength="2000"[\s\S]*?aria-describedby="messageHint"/)
  })

  it('links the GitHub inputs to their hints', () => {
    assert.match(popupHtml, /id="ghOwner"[\s\S]*?aria-describedby="ghOwnerHint ghOwnerError"/)
    assert.match(popupHtml, /id="ghToken"[\s\S]*?aria-describedby="ghOwnerHint"/)
  })

  it('loads settings.js after items.js and before popup.js', () => {
    const at = (src) => popupHtml.indexOf(`src="${src}"`)
    assert.ok(at('items.js') < at('settings.js') && at('settings.js') < at('popup.js'))
  })

  it('has every Settings field', () => {
    for (const id of [
      'requestTimeoutSec',
      'listTimeoutSec',
      'extraJitter',
      'extraJitterMaxSec',
      'perAccountParallel',
      'totalParallel',
      'runLimit',
      'reloadTabOnSignIn',
      'defaultReply',
      'defaultRetry',
      'rpcInputs',
      'archiveBatch',
      'archiveSplit',
      'rediscoverBtn',
      'resetApiBtn'
    ]) {
      assert.match(popupHtml, new RegExp(`id="${id}"`), id)
    }
  })

  it('puts the Settings and Schedule toggles side by side, with their panels hidden', () => {
    assert.match(
      popupHtml,
      /<nav class="lrow"[^>]*>\s*<button[^>]*id="settingsToggle"[^>]*aria-expanded="false"[^>]*aria-controls="settingsPanel"/
    )
    assert.match(popupHtml, /id="scheduleToggle"[^>]*aria-expanded="false"[^>]*aria-controls="schedulePanel"/)
    assert.match(popupHtml, /<section class="xb set hidden" id="settingsPanel" aria-labelledby="settingsToggle"/)
    assert.match(popupHtml, /<section class="xb hidden" id="schedulePanel" aria-labelledby="scheduleToggle"/)
  })

  it('keeps License & Credits inside Settings', () => {
    const start = popupHtml.indexOf('id="settingsPanel"')
    const end = popupHtml.indexOf('id="schedulePanel"')
    assert.ok(popupHtml.slice(start, end).includes('href="license.html"'))
  })

  it('explains Force and the message in tooltips the checkboxes point to', () => {
    assert.match(popupHtml, /id="force" aria-describedby="forceTip"/)
    assert.match(popupHtml, /role="tooltip" id="forceTip"[^>]*>\s*Archive skips the open-PR check/)
    assert.match(popupHtml, /id="addMessage"[^>]*aria-describedby="messageHint"/)
    assert.match(popupHtml, /role="tooltip" id="messageHint"/)
    assert.ok(!popupHtml.includes('id="forceHint"'), 'the Force text is no longer shown under the checkboxes')
  })

  it('labels the Scope radio group with a legend', () => {
    assert.match(popupHtml, /<legend[^>]*id="scopeLabel"[^>]*>Scope<\/legend>/)
  })

  it('has no inline styles or scripts (blocked by the extension CSP)', () => {
    assert.ok(!/\sstyle=/i.test(popupHtml))
    assert.ok(!/<style[\s>]/i.test(popupHtml))
    assert.ok(!/<script>(?!<\/script>)/i.test(popupHtml))
  })
})

// The worker's answers to a two-part load: LOAD_ITEMS gives the tasks and
// schedules, LOAD_ARCHIVED the archived tasks (with their notes).
function moreReplies(accounts, loadId = 'L1') {
  return (msg) => {
    if (msg.action === 'LOAD_ITEMS') {
      return {
        loadId,
        accounts: accounts.map(({ account, tasks, schedules }) => ({ account, tasks, schedules, notes: [] }))
      }
    }
    if (msg.action === 'LOAD_ARCHIVED') {
      return { loadId, accounts: accounts.map(({ account, archived, notes }) => ({ account, archived, notes })) }
    }
    if (msg.action === 'APPLY_ACTION') return { ok: true }
    return {}
  }
}

describe('More Actions popup', () => {
  const accounts = [
    {
      account: 'u/1',
      tasks: [
        { id: 'run', title: 'Running title', state: 2, repo: 'org/repo' },
        { id: 'done', title: 'Completed title', state: null, repo: 'org/repo' }
      ],
      schedules: [{ id: 'sched', title: 'Schedule title', state: 2, repo: 'org/repo' }],
      archived: [{ id: 'old', title: 'Archived title', state: 3, repo: 'org/repo' }],
      notes: ['Archived listing note']
    }
  ]

  async function setup() {
    const env = setupPopupSandbox()
    const reply = moreReplies(accounts)
    env.sandbox.chrome.runtime.sendMessage = (msg, cb) => {
      env.sent.push(msg)
      if (cb) cb(reply(msg))
    }
    env.load()
    await env.tick()
    return env
  }

  it('places More Actions before Export and opens its panel', async () => {
    const nav = popupHtml.slice(popupHtml.indexOf('<nav'), popupHtml.indexOf('</nav>'))
    assert.match(nav, /settingsToggle[\s\S]*scheduleToggle[\s\S]*moreToggle[\s\S]*exportBtn/)
    const env = await setup()
    await env.elements['#moreToggle'].dispatchEvent('click')
    assert.strictEqual(env.elements['#moreToggle'].getAttribute('aria-expanded'), 'true')
    assert.ok(!env.elements['#morePanel'].classList.contains('hidden'))
  })

  it('disables Load until the Repo field is valid', async () => {
    const env = await setup()
    const el = env.elements
    el['#moreAll'].checked = false
    el['#moreRepoScope'].checked = true
    await el['#moreRepoScope'].dispatchEvent('change')
    assert.strictEqual(el['#moreLoad'].disabled, true)
    el['#moreRepo'].value = 'org/repo'
    await el['#moreRepo'].dispatchEvent('input')
    assert.strictEqual(el['#moreLoad'].disabled, false)
    await el['#moreLoad'].dispatchEvent('click')
    assert.strictEqual(env.sent.find((msg) => msg.action === 'LOAD_ITEMS').repo, 'org/repo')
  })

  it('picks the Repo scope when a repo is typed', async () => {
    const env = await setup()
    const el = env.elements
    assert.ok(!el['#moreRepoScope'].checked)
    el['#moreRepo'].value = '   '
    await el['#moreRepo'].dispatchEvent('input')
    assert.ok(!el['#moreRepoScope'].checked, 'spaces are not a repo')
    el['#moreRepo'].value = 'org/repo'
    await el['#moreRepo'].dispatchEvent('input')
    assert.strictEqual(el['#moreRepoScope'].checked, true)
    assert.strictEqual(el['#moreLoad'].disabled, false)
    await el['#moreLoad'].dispatchEvent('click')
    assert.strictEqual(env.sent.find((msg) => msg.action === 'LOAD_ITEMS').repo, 'org/repo')
  })

  it('loads counts, checkbox rows and retains selections across chips', async () => {
    const env = await setup()
    const el = env.elements
    await el['#moreLoad'].dispatchEvent('click')
    await env.tick()
    const load = env.sent.find((msg) => msg.action === 'LOAD_ITEMS')
    assert.strictEqual(load.protocol, RUN_PROTOCOL)
    assert.strictEqual(load.category, 'all')
    assert.ok(!env.sent.some((msg) => msg.action === 'LOAD_ARCHIVED'), 'All leaves the archived tasks out')
    assert.strictEqual(el['#moreStatus'].textContent, '2 tasks, 1 schedules')
    assert.deepStrictEqual(
      el['#moreChips'].children.map((chip) => chip.textContent),
      ['All (3)', 'Scheduled (1)', 'Completed (1)']
    )
    assert.strictEqual(el['#moreList'].children.length, 3)
    const checkbox = el['#moreList'].children[0].children[0]
    assert.strictEqual(checkbox.type, 'checkbox')
    checkbox.checked = true
    await checkbox.dispatchEvent('change')
    assert.ok(el['#moreAction'].children.some((opt) => opt.textContent === 'Pause task (1)' && !opt.disabled))
    await el['#moreChips'].children[1].dispatchEvent('click')
    assert.strictEqual(el['#moreList'].children.length, 1)
    await el['#moreChips'].children[0].dispatchEvent('click')
    assert.strictEqual(el['#moreList'].children[0].children[0].checked, true)
  })

  it("Confirm sends only fitting selected items, with the panel's own Dry run box", async () => {
    const env = await setup()
    const el = env.elements
    await el['#moreLoad'].dispatchEvent('click')
    el['#moreSelectAll'].checked = true
    await el['#moreSelectAll'].dispatchEvent('change')
    el['#moreAction'].value = 'pauseTask'
    await el['#moreAction'].dispatchEvent('change')
    assert.strictEqual(el['#moreConfirm'].disabled, false)
    assert.strictEqual(el['#dryRun'].checked, true)
    assert.strictEqual(el['#moreConfirm'].textContent, 'Confirm', "the main Dry run box doesn't count here")
    el['#moreDryRun'].checked = true
    await el['#moreDryRun'].dispatchEvent('change')
    assert.strictEqual(el['#moreConfirm'].textContent, 'Confirm (dry run)')
    await el['#moreConfirm'].dispatchEvent('click')
    const msg = JSON.parse(JSON.stringify(env.sent.find((msg) => msg.action === 'APPLY_ACTION')))
    assert.deepStrictEqual(msg, {
      action: 'APPLY_ACTION',
      protocol: RUN_PROTOCOL,
      operation: 'pauseTask',
      dryRun: true,
      force: false,
      items: [{ account: 'u/1', kind: 'task', id: 'run' }]
    })
    assert.ok(el['#morePanel'].classList.contains('hidden'))
    assert.strictEqual(el['#moreLoad'].disabled, true)
  })

  it('labels a completed task Jules marks for review "Ready for review"', async () => {
    const env = setupPopupSandbox()
    const reply = moreReplies([
      {
        account: 'u/1',
        tasks: [
          { id: 'review', title: 'Review me', state: 3, repo: 'org/repo', awaitingReview: true },
          { id: 'done', title: 'Done', state: 3, repo: 'org/repo', awaitingReview: false }
        ],
        schedules: []
      }
    ])
    env.sandbox.chrome.runtime.sendMessage = (msg, cb) => {
      env.sent.push(msg)
      if (cb) cb(reply(msg))
    }
    env.load()
    await env.tick()
    await env.elements['#moreLoad'].dispatchEvent('click')
    assert.deepStrictEqual(
      env.elements['#moreList'].children.map((row) => row.children[1].children[1].textContent),
      ['Task · Ready for review · org/repo · u/1', 'Task · Completed · org/repo · u/1']
    )
  })

  it('locks Load and Confirm for a stale worker', async () => {
    const env = setupPopupSandbox({ hello: { protocol: -1 } })
    env.load()
    await env.tick()
    assert.strictEqual(env.elements['#moreLoad'].disabled, true)
    assert.strictEqual(env.elements['#moreConfirm'].disabled, true)
    await env.elements['#moreLoad'].dispatchEvent('click')
    assert.ok(!env.sent.some((msg) => msg.action === 'LOAD_ITEMS'))
  })
})

describe('More Actions popup edge cases', () => {
  it('shows loading, failure and empty states without retaining old selections', async () => {
    const env = setupPopupSandbox()
    env.load()
    await env.tick()
    const el = env.elements
    let answer
    env.sandbox.chrome.runtime.sendMessage = (msg, cb) => {
      env.sent.push(msg)
      if (msg.action === 'LOAD_ITEMS') answer = cb
      if (msg.action === 'LOAD_ARCHIVED') cb({ loadId: msg.loadId, accounts: [] })
    }
    const loading = el['#moreLoad'].dispatchEvent('click')
    await env.tick()
    assert.strictEqual(el['#moreLoad'].textContent, 'Loading…')
    assert.strictEqual(el['#moreLoad'].getAttribute('aria-busy'), 'true')
    assert.strictEqual(el['#moreConfirm'].disabled, true)
    answer({ error: 'Listing failed' })
    await loading
    assert.strictEqual(el['#moreStatus'].textContent, 'Listing failed')
    assert.strictEqual(el['#moreLoad'].textContent, 'Load')
    assert.strictEqual(el['#moreList'].children.length, 0)
    const next = el['#moreLoad'].dispatchEvent('click')
    await env.tick()
    answer({ loadId: 'L2', accounts: [] })
    await next
    assert.strictEqual(el['#moreStatus'].textContent, '0 tasks, 0 schedules')
    assert.strictEqual(el['#moreSelectAll'].disabled, true)
  })

  // Holds the worker's LOAD_ARCHIVED answers so a test can give them later.
  function heldArchived(accounts) {
    const env = setupPopupSandbox()
    env.held = []
    let loads = 0
    env.sandbox.chrome.runtime.sendMessage = (msg, cb) => {
      env.sent.push(msg)
      if (msg.action === 'LOAD_ITEMS') return cb(moreReplies(accounts, `L${++loads}`)(msg))
      if (msg.action === 'LOAD_ARCHIVED') return env.held.push({ msg, cb })
      if (cb) cb({})
    }
    return env
  }
  // What the worker answers for Archived: nothing until LOAD_ARCHIVED.
  const archivedOnly = [
    {
      account: 'u/1',
      archived: [{ id: 'old', title: 'Archived title', state: 3, repo: 'org/repo' }],
      notes: ['Archived listing note']
    }
  ]
  async function loadArchived(env) {
    env.load()
    await env.tick()
    env.elements['#moreCategory'].value = 'archive'
    await env.elements['#moreLoad'].dispatchEvent('click')
    await env.tick()
  }

  it('Archived waits for LOAD_ARCHIVED, with Load free meanwhile', async () => {
    const env = heldArchived(archivedOnly)
    await loadArchived(env)
    const el = env.elements
    assert.strictEqual(env.sent.find((msg) => msg.action === 'LOAD_ITEMS').category, 'archive')
    assert.strictEqual(el['#moreStatus'].textContent, 'Listing the archived tasks…')
    assert.strictEqual(el['#moreLoad'].disabled, false, 'Load is free again')
    assert.strictEqual(el['#moreLoad'].textContent, 'Load')
    const [{ msg, cb }] = env.held
    assert.deepStrictEqual(JSON.parse(JSON.stringify(msg)), {
      action: 'LOAD_ARCHIVED',
      protocol: RUN_PROTOCOL,
      loadId: 'L1'
    })
    cb(moreReplies(archivedOnly, 'L1')(msg))
    await env.tick()
    assert.strictEqual(el['#moreStatus'].textContent, '1 archived tasks · Archived listing note')
    assert.strictEqual(el['#moreChips'].children.length, 0, 'one category needs no chips')
    assert.strictEqual(el['#moreList'].children.length, 1)
    assert.strictEqual(
      el['#moreList'].children[0].children[1].children[1].textContent,
      'Archived · Completed · org/repo · u/1'
    )
  })

  it('drops the archived tasks of a load that a newer Load replaced', async () => {
    const env = heldArchived(archivedOnly)
    await loadArchived(env)
    const el = env.elements
    await el['#moreLoad'].dispatchEvent('click')
    await env.tick()
    assert.deepStrictEqual(
      env.held.map(({ msg }) => msg.loadId),
      ['L1', 'L2']
    )
    env.held[0].cb(moreReplies(archivedOnly, 'L1')(env.held[0].msg))
    await env.tick()
    assert.strictEqual(el['#moreList'].children.length, 0)
    assert.strictEqual(el['#moreStatus'].textContent, 'Listing the archived tasks…')
    env.held[1].cb(moreReplies(archivedOnly, 'L2')(env.held[1].msg))
    await env.tick()
    assert.strictEqual(el['#moreList'].children.length, 1)
  })

  it('says when the archived tasks could not be listed', async () => {
    const env = heldArchived(archivedOnly)
    await loadArchived(env)
    env.held[0].cb({ error: 'Jules gave up' })
    await env.tick()
    assert.strictEqual(env.elements['#moreStatus'].textContent, 'Could not list the archived tasks: Jules gave up')
    assert.strictEqual(env.elements['#moreList'].children.length, 0)
  })

  it('Load sends the chosen category and shows only what it listed', async () => {
    for (const [category, account, status] of [
      ['scheduled', { schedules: [{ id: 's', title: 'S', state: 2, repo: 'org/repo' }] }, '1 schedules'],
      ['complete', { tasks: [{ id: 't', title: 'T', state: 3, repo: 'org/repo' }] }, '1 completed tasks']
    ]) {
      const env = setupPopupSandbox()
      const reply = moreReplies([{ account: 'u/1', ...account }])
      env.sandbox.chrome.runtime.sendMessage = (msg, cb) => {
        env.sent.push(msg)
        if (cb) cb(reply(msg))
      }
      env.load()
      await env.tick()
      const el = env.elements
      el['#moreCategory'].value = category
      await el['#moreLoad'].dispatchEvent('click')
      await env.tick()
      assert.strictEqual(env.sent.find((msg) => msg.action === 'LOAD_ITEMS').category, category)
      assert.ok(!env.sent.some((msg) => msg.action === 'LOAD_ARCHIVED'))
      assert.strictEqual(el['#moreStatus'].textContent, status)
      assert.strictEqual(el['#moreChips'].children.length, 0)
      assert.strictEqual(el['#moreList'].children.length, 1)
    }
  })

  it('rechecks HELLO before loading and stays locked after a version change', async () => {
    const env = setupPopupSandbox()
    env.load()
    await env.tick()
    env.helloState.reply = { protocol: -1 }
    await env.elements['#moreLoad'].dispatchEvent('click')
    assert.strictEqual(env.elements['#moreLoad'].disabled, true)
    assert.strictEqual(env.elements['#moreConfirm'].disabled, true)
    assert.ok(!env.sent.some((msg) => msg.action === 'LOAD_ITEMS'))
  })
})

describe('More Actions confirmation choices', () => {
  const cases = [
    ['archive', 'task', 3],
    ['unarchive', 'archived', 3],
    ['pauseTask', 'task', 1],
    ['resumeTask', 'task', 8],
    ['pauseSchedule', 'schedule', 2],
    ['resumeSchedule', 'schedule', 3]
  ]
  for (const [action, kind, state] of cases) {
    it(`confirms ${action} for only its fitting selections in a live run`, async () => {
      const env = setupPopupSandbox()
      const entry = { id: 'chosen', title: '<b>Plain title</b>', repo: 'org/repo', state }
      const account = { account: 'u/1', tasks: [], schedules: [], archived: [], notes: [] }
      account[kind === 'task' ? 'tasks' : kind === 'schedule' ? 'schedules' : 'archived'].push(entry)
      account.schedules.push({ id: 'unfit', title: 'Other', state: 99, repo: 'org/repo' })
      const reply = moreReplies([account])
      env.sandbox.chrome.runtime.sendMessage = (msg, cb) => {
        env.sent.push(msg)
        if (cb) cb(msg.action === 'GET_STATE' ? { status: 'idle' } : reply(msg))
      }
      env.load()
      await env.tick()
      const el = env.elements
      el['#moreCategory'].value = kind === 'archived' ? 'archive' : 'all'
      await el['#moreLoad'].dispatchEvent('click')
      await env.tick()
      assert.strictEqual(el['#moreConfirm'].disabled, true)
      el['#moreSelectAll'].checked = true
      await el['#moreSelectAll'].dispatchEvent('change')
      assert.ok(
        el['#moreAction'].children
          .filter((opt) => opt.value && !opt.textContent.endsWith('(0)'))
          .every((opt) => !opt.disabled)
      )
      assert.ok(
        el['#moreAction'].children.filter((opt) => opt.textContent.endsWith('(0)')).every((opt) => opt.disabled)
      )
      // Force is checked first, while no action is chosen: it counts only for Archive.
      el['#moreForce'].checked = true
      await el['#moreForce'].dispatchEvent('change')
      el['#moreAction'].value = action
      await el['#moreAction'].dispatchEvent('change')
      assert.strictEqual(el['#moreForce'].disabled, action !== 'archive')
      assert.strictEqual(el['#moreConfirm'].textContent, 'Confirm')
      await el['#moreConfirm'].dispatchEvent('click')
      const sent = env.sent.find((msg) => msg.action === 'APPLY_ACTION')
      assert.strictEqual(sent.operation, action)
      assert.strictEqual(sent.dryRun, false)
      assert.strictEqual(sent.force, action === 'archive')
      assert.deepStrictEqual(JSON.parse(JSON.stringify(sent.items)), [{ account: 'u/1', kind, id: 'chosen' }])
      // The acted item leaves the selection, on screen too.
      await env.tick()
      const row = el['#moreList'].children.find((r) => r.children[1].children[0].textContent === '<b>Plain title</b>')
      assert.strictEqual(row.children[0].checked, false)
      assert.ok(el['#moreAction'].children.find((opt) => opt.value === action).textContent.endsWith('(0)'))
    })
  }
})

describe('More Actions smoke', () => {
  it('boots the popup with a compatible worker and default controls', async () => {
    const env = setupPopupSandbox()
    env.load()
    await env.tick()
    assert.ok(env.sent.some((msg) => msg.action === 'HELLO'))
    assert.ok(env.sent.some((msg) => msg.action === 'GET_STATE'))
    assert.strictEqual(env.elements['#moreLoad'].disabled, false)
    assert.strictEqual(env.elements['#moreConfirm'].disabled, true)
    assert.strictEqual(env.elements['#proceedBtn'].disabled, false)
  })
})
