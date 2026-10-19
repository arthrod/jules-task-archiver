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
const popupHtml = fs.readFileSync(path.join(__dirname, '../popup.html'), 'utf8')

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
function createMockChrome(syncStorage, localStorage, listeners, sent, tabs) {
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
        remove: (key, cb) => {
          delete syncStorage[key]
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
        }
      },
      onChanged: {
        addListener: (cb) => listeners.storage.push(cb)
      }
    },
    runtime: {
      sendMessage: (msg, cb) => {
        sent.push(msg)
        if (!cb) return
        if (msg.action === 'GET_STATE') cb({ status: 'idle' })
        else if (msg.action === 'GET_ALL_SOURCES') cb({ repos: [] })
        else if (msg.action === 'START') cb({ ok: true })
        else cb()
      },
      onMessage: {
        addListener: (cb) => listeners.runtime.push(cb)
      }
    },
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
  'mainView'
]

function setupPopupSandbox({ sync = {}, local = {}, tabs = [], confirm = () => true } = {}) {
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
  elements['#message'].disabled = true
  elements['#oneSessionRow'].classList.add('hidden')
  elements['#settingsPanel'].classList.add('hidden')
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
  const chrome = createMockChrome(syncStorage, localStorage, listeners, sent, tabs)

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
    tick
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

  it('ignores a remembered item that no longer exists', () => {
    const env = setupPopupSandbox({ sync: { item: 'state:99' } })
    env.load()
    assert.strictEqual(env.elements['#itemsBtnText'].textContent, 'All')
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
  it('loads and clamps the schedule fields', () => {
    const env = setupPopupSandbox({ sync: { schedEnabled: true, schedIntervalMin: 30, schedMaxStarts: 7 } })
    env.load()
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
    assert.match(popupHtml, /aria-describedby="ghOwnerHint ghOwnerError"/)
    assert.match(popupHtml, /aria-describedby="ghTokenHint"/)
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
