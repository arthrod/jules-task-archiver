const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const contentJsPath = path.join(__dirname, '../content.js')
const contentJsCode = fs.readFileSync(contentJsPath, 'utf8')

describe('content.js script injection', () => {
  it('should inject main-world.js and remove it on load', () => {
    let scriptCreated = null
    let appendedTo = null
    let removed = false

    const chrome = {
      runtime: {
        getURL: (p) => `chrome-extension://id/${p}`,
        onMessage: { addListener: () => {} }
      }
    }

    const document = {
      createElement: (tag) => {
        if (tag === 'script') {
          scriptCreated = {
            src: '',
            onload: null,
            remove: () => {
              removed = true
            }
          }
          return scriptCreated
        }
      },
      head: {
        appendChild: (_el) => {
          appendedTo = 'head'
        }
      },
      documentElement: {
        appendChild: (_el) => {
          if (!appendedTo) appendedTo = 'documentElement'
        }
      }
    }

    const window = {
      addEventListener: () => {},
      location: { origin: 'https://example.com' }
    }

    const sandbox = {
      chrome,
      document,
      window,
      console,
      setTimeout,
      clearTimeout,
      Date,
      Promise,
      URL,
      location: window.location
    }

    vm.createContext(sandbox)
    vm.runInContext(contentJsCode, sandbox, { filename: contentJsPath })

    // Assertions
    assert.ok(scriptCreated, 'Script should be created')
    assert.strictEqual(scriptCreated.src, 'chrome-extension://id/main-world.js')
    assert.strictEqual(appendedTo, 'head', 'Should prefer head if available')

    // Simulate onload
    assert.strictEqual(removed, false)
    scriptCreated.onload()
    assert.strictEqual(removed, true, 'Script should be removed after onload')
  })

  it('should fallback to documentElement if document.head is missing', () => {
    let scriptCreated = null
    let appendedTo = null

    const chrome = {
      runtime: {
        getURL: (p) => `chrome-extension://id/${p}`,
        onMessage: { addListener: () => {} }
      }
    }

    const document = {
      createElement: (tag) => {
        if (tag === 'script') {
          scriptCreated = {
            src: '',
            onload: null,
            remove: () => {}
          }
          return scriptCreated
        }
      },
      head: null,
      documentElement: {
        appendChild: (_el) => {
          appendedTo = 'documentElement'
        }
      }
    }

    const window = {
      addEventListener: () => {},
      location: { origin: 'https://example.com' }
    }

    const sandbox = {
      chrome,
      document,
      window,
      console,
      setTimeout,
      clearTimeout,
      Date,
      Promise,
      URL,
      location: window.location
    }

    vm.createContext(sandbox)
    vm.runInContext(contentJsCode, sandbox, { filename: contentJsPath })

    assert.ok(scriptCreated, 'Script should be created')
    assert.strictEqual(appendedTo, 'documentElement', 'Should fallback to documentElement')
  })

  it('should allow manual reinjection via test_injectMainWorldScript in TEST_MODE', () => {
    let scriptCreatedCount = 0

    const chrome = {
      runtime: {
        getURL: (p) => `chrome-extension://id/${p}`,
        onMessage: { addListener: () => {} }
      }
    }

    const document = {
      createElement: (tag) => {
        if (tag === 'script') {
          scriptCreatedCount++
          return { src: '', onload: null, remove: () => {} }
        }
      },
      head: { appendChild: () => {} },
      documentElement: { appendChild: () => {} }
    }

    const sandbox = {
      chrome,
      document,
      window: { addEventListener: () => {}, location: { origin: 'https://example.com' } },
      console,
      setTimeout,
      clearTimeout,
      Date,
      Promise,
      URL,
      TEST_MODE: true
    }
    sandbox.globalThis = sandbox
    sandbox.location = sandbox.window.location

    vm.createContext(sandbox)
    vm.runInContext(contentJsCode, sandbox, { filename: contentJsPath })

    const initialCount = scriptCreatedCount
    assert.ok(initialCount >= 1, 'Should have injected at least once on load')

    sandbox.test_injectMainWorldScript()
    assert.strictEqual(scriptCreatedCount, initialCount + 1, 'Should have injected again manually')
  })
})

describe('content.js and the CreateTask RPC id', () => {
  function load(stored) {
    const posted = []
    const storageListeners = []
    let script = null
    const chrome = {
      runtime: { getURL: (p) => `chrome-extension://id/${p}`, onMessage: { addListener: () => {} } },
      storage: {
        local: { get: (_key, cb) => cb({ julesApi: stored }) },
        onChanged: { addListener: (cb) => storageListeners.push(cb) }
      }
    }
    const document = {
      createElement: () => {
        script = { src: '', onload: null, remove: () => {} }
        return script
      },
      head: { appendChild: () => {} }
    }
    const window = {
      addEventListener: () => {},
      postMessage: (data, origin) => posted.push({ data, origin }),
      location: { origin: 'https://jules.google.com' }
    }
    const sandbox = { chrome, document, window, console, setTimeout, clearTimeout, Date, Promise, URL }
    vm.createContext(sandbox)
    vm.runInContext(contentJsCode, sandbox, { filename: contentJsPath })
    const ids = () => posted.filter((p) => p.data.type === 'JULES_CREATE_TASK_RPC').map((p) => [p.data.rpcId, p.origin])
    return { script, storageListeners, ids }
  }

  it('sends the saved id once main-world.js has loaded', () => {
    const env = load({ rpc: { CreateTask: 'Qq7Rr' } })
    assert.deepStrictEqual(env.ids(), [], 'main-world.js is not listening yet')
    env.script.onload()
    assert.deepStrictEqual(env.ids(), [['Qq7Rr', 'https://jules.google.com']])
  })

  it('sends an empty id while a rediscovery has CreateTask in doubt, so none is watched', () => {
    const env = load({ rpc: { CreateTask: 'Qq7Rr' }, inDoubt: ['Interact', 'CreateTask'] })
    env.script.onload()
    for (const listener of env.storageListeners) {
      listener({ julesApi: { newValue: { rpc: { CreateTask: 'Qq7Rr' }, inDoubt: ['GetTask', 'Interact'] } } }, 'local')
      listener({ julesApi: { newValue: { rpc: { CreateTask: 'Qq7Rr' }, inDoubt: ['CreateTask'] } } }, 'local')
    }
    assert.deepStrictEqual(
      env.ids().map(([id]) => id),
      ['', 'Qq7Rr', '']
    )
  })

  it('sends null when nothing is saved, and every later change', () => {
    const env = load(undefined)
    env.script.onload()
    for (const listener of env.storageListeners) {
      listener({ julesApi: { newValue: { rpc: { CreateTask: 'Zz9Yy' } } } }, 'local')
      listener({ settings: { newValue: {} } }, 'sync')
    }
    assert.deepStrictEqual(
      env.ids().map(([id]) => id),
      [null, 'Zz9Yy']
    )
  })
})
