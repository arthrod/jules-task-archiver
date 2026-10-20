const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const mainWorldJsPath = path.join(__dirname, '../main-world.js')
const mainWorldJs = fs.readFileSync(mainWorldJsPath, 'utf8')

function setupSandbox(initialWizData = {}) {
  const messages = []
  const listeners = {}

  const windowMock = {
    WIZ_global_data: initialWizData,
    location: {
      origin: 'https://jules.google.com',
      href: 'https://jules.google.com/u/0/'
    },
    postMessage: (data, targetOrigin) => {
      messages.push({ data, targetOrigin })
    },
    addEventListener: (type, listener) => {
      listeners[type] = listeners[type] || []
      listeners[type].push(listener)
    },
    fetch: async () => ({ ok: true }),
    __julesArchiver: undefined,
    Date: {
      now: () => 1234567890
    },
    URLSearchParams: class {
      constructor(init) {
        this.params = new URLSearchParams(init)
      }
      get(name) {
        return this.params.get(name)
      }
    }
  }

  // Circular reference common in browsers
  windowMock.window = windowMock

  const sandbox = {
    window: windowMock,
    console,
    URLSearchParams: windowMock.URLSearchParams,
    JSON,
    Date: windowMock.Date,
    String,
    setTimeout
  }

  vm.createContext(sandbox)
  return { sandbox, windowMock, messages, listeners }
}

describe('main-world.js', () => {
  it('should broadcast config on load', () => {
    const { sandbox, messages } = setupSandbox({
      SNlM0e: 'at-token',
      cfb2h: 'bl-label',
      FdrFJe: 'fsid-token',
      TSDtV: 'beyond:models/gemini-pro',
      S06Grb: '123456789012345678901'
    })

    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })

    assert.strictEqual(messages.length, 1)
    assert.strictEqual(messages[0].targetOrigin, 'https://jules.google.com')
    assert.strictEqual(messages[0].data.type, 'JULES_ARCHIVER_CONFIG')
    assert.strictEqual(messages[0].data.config.at, 'at-token')
    assert.strictEqual(messages[0].data.config.bl, 'bl-label')
    assert.strictEqual(messages[0].data.config.fsid, 'fsid-token')
    assert.strictEqual(messages[0].data.config.modelId, 'beyond:models/gemini-pro')
    assert.strictEqual(messages[0].data.config.timestamp, 1234567890)
    // The signed-in Google account: the More Actions cache is kept per account.
    assert.strictEqual(messages[0].data.config.user, '123456789012345678901')
  })

  it('should handle missing WIZ_global_data', () => {
    const { sandbox, messages } = setupSandbox(null)

    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })

    assert.strictEqual(messages.length, 1)
    assert.strictEqual(messages[0].targetOrigin, 'https://jules.google.com')
    assert.strictEqual(messages[0].data.config, null)
  })

  it('should handle partial WIZ_global_data', () => {
    const { sandbox, messages } = setupSandbox({
      SNlM0e: 'at-token'
    })

    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })

    assert.strictEqual(messages[0].data.config.at, 'at-token')
    assert.strictEqual(messages[0].data.config.bl, null)
    assert.strictEqual(messages[0].data.config.modelId, null)
    assert.strictEqual(messages[0].data.config.user, null)
  })

  it('should handle non-matching modelId string', () => {
    const { sandbox, messages } = setupSandbox({
      TSDtV: 'invalid-model-string'
    })

    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })

    assert.strictEqual(messages[0].data.config.modelId, null)
  })

  it('should handle empty WIZ_global_data object', () => {
    const { sandbox, messages } = setupSandbox({})

    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })

    assert.strictEqual(messages[0].data.config.at, null)
    assert.strictEqual(messages[0].data.config.bl, null)
    assert.strictEqual(messages[0].data.config.fsid, null)
    assert.strictEqual(messages[0].data.config.modelId, null)
  })

  it('should respond to JULES_REQUEST_CONFIG message', () => {
    const { sandbox, messages, listeners, windowMock } = setupSandbox({
      SNlM0e: 'at-token'
    })

    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })
    assert.strictEqual(messages.length, 1) // Initial broadcast

    // Simulate request message
    const event = {
      source: windowMock,
      origin: 'https://jules.google.com',
      data: { type: 'JULES_REQUEST_CONFIG' }
    }
    listeners.message.forEach((l) => {
      l(event)
    })

    assert.strictEqual(messages.length, 2)
    assert.strictEqual(messages[1].targetOrigin, 'https://jules.google.com')
    assert.strictEqual(messages[1].data.type, 'JULES_ARCHIVER_CONFIG')
  })

  it('should ignore JULES_REQUEST_CONFIG from a foreign origin', () => {
    const { sandbox, messages, listeners, windowMock } = setupSandbox({
      SNlM0e: 'at-token'
    })

    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })
    assert.strictEqual(messages.length, 1)

    // Same window object, but a spoofed cross-origin value
    const event = {
      source: windowMock,
      origin: 'https://evil.example.com',
      data: { type: 'JULES_REQUEST_CONFIG' }
    }
    listeners.message.forEach((l) => {
      l(event)
    })

    assert.strictEqual(messages.length, 1, 'foreign-origin request must not trigger a broadcast')
  })

  it('should ignore JULES_REQUEST_CONFIG from other sources', () => {
    const { sandbox, messages, listeners } = setupSandbox({
      SNlM0e: 'at-token'
    })

    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })
    assert.strictEqual(messages.length, 1)

    // Simulate request message from wrong source
    const event = {
      source: {}, // Not window
      data: { type: 'JULES_REQUEST_CONFIG' }
    }
    listeners.message.forEach((l) => {
      l(event)
    })

    assert.strictEqual(messages.length, 1)
  })

  it('should intercept Rja83d fetch and broadcast start config', async () => {
    const { sandbox, messages, windowMock } = setupSandbox({})

    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })
    assert.strictEqual(messages.length, 1) // Initial broadcast

    // Setup mock payload
    const payload = [
      null,
      null,
      ['model-config', null, null, null, null, null, null, null, null, null, ['flag1']], // payload[2] and payload[2][10]
      null,
      null,
      null,
      null,
      null,
      null,
      [null, null, null, null, ['exp1', 'exp2']] // payload[9][4]
    ]
    const freq = [[['Rja83d', JSON.stringify(payload), null, 'generic']]]
    const body = `f.req=${encodeURIComponent(JSON.stringify(freq))}`

    // Call intercepted fetch
    await windowMock.fetch('https://jules.google.com/_/Swebot/data/batchexecute?rpcids=Rja83d', {
      method: 'POST',
      body
    })

    const startMsg = messages.find((m) => m.data.type === 'JULES_START_CONFIG')
    assert.ok(startMsg, 'JULES_START_CONFIG message should be sent')
    assert.strictEqual(startMsg.targetOrigin, 'https://jules.google.com')
    assert.deepStrictEqual(startMsg.data.config.modelConfig, payload[2])
    assert.deepStrictEqual(startMsg.data.config.experimentIds, ['exp1', 'exp2'])
    assert.deepStrictEqual(startMsg.data.config.featureFlags, ['flag1'])
    assert.strictEqual(startMsg.data.config.capturedAt, 1234567890)
    // The tag tells content.js the message is from this observer, not from an
    // older one still installed on a page opened before an update.
    assert.strictEqual(startMsg.data.observer, 4)
  })

  it('captures the start config from fetch(Request), reading a clone before the page sends it', async () => {
    const { sandbox, messages, windowMock } = setupSandbox({})
    const sent = []
    windowMock.fetch = async (input) => {
      sent.push(input)
      input.used = true
      return { ok: true }
    }
    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })

    const payload = [null, null, ['model-config'], null, null, null, null, null, null, [null, null, null, null, ['e1']]]
    const body = `f.req=${encodeURIComponent(JSON.stringify([[['Rja83d', JSON.stringify(payload)]]]))}`
    const request = {
      url: 'https://jules.google.com/_/Swebot/data/batchexecute?rpcids=Rja83d',
      used: false,
      clone() {
        assert.strictEqual(this.used, false, 'the clone must be taken before the page fetch reads the body')
        return { text: async () => body }
      }
    }
    await windowMock.fetch(request)

    assert.strictEqual(sent[0], request, 'the page still sends its own Request')
    const startMsg = messages.find((m) => m.data.type === 'JULES_START_CONFIG')
    assert.ok(startMsg, 'JULES_START_CONFIG message should be sent')
    assert.deepStrictEqual(startMsg.data.config.experimentIds, ['e1'])
  })

  it('reads the URL of fetch(URL)', async () => {
    const { sandbox, messages, windowMock } = setupSandbox({})
    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })
    const payload = [null, null, ['m'], null, null, null, null, null, null, null]
    const body = `f.req=${encodeURIComponent(JSON.stringify([[['Rja83d', JSON.stringify(payload)]]]))}`
    const url = { toString: () => 'https://jules.google.com/_/Swebot/data/batchexecute?rpcids=Rja83d' }
    await windowMock.fetch(url, { method: 'POST', body })
    assert.ok(messages.find((m) => m.data.type === 'JULES_START_CONFIG'))
    const before = messages.length
    await windowMock.fetch(new URL('https://jules.google.com/_/Swebot/data/batchexecute?rpcids=Rja83d'), { body })
    assert.ok(
      messages.slice(before).some((m) => m.data.type === 'JULES_START_CONFIG'),
      'a real URL instance'
    )
  })

  it('watches the CreateTask id content.js sends, and the built-in one again on null', async () => {
    const { sandbox, messages, windowMock, listeners } = setupSandbox({})
    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })
    const payload = [null, null, ['m'], null, null, null, null, null, null, null]
    const base = 'https://jules.google.com/_/Swebot/data/batchexecute?rpcids='
    const captured = async (rpcIds) => {
      const entries = rpcIds.split(',').map((id) => [id, JSON.stringify(payload)])
      const body = `f.req=${encodeURIComponent(JSON.stringify([entries]))}`
      const before = messages.length
      await windowMock.fetch(base + rpcIds, { method: 'POST', body })
      return messages.slice(before).some((m) => m.data.type === 'JULES_START_CONFIG')
    }
    const tell = (rpcId) => {
      for (const listener of listeners.message) {
        listener({
          source: windowMock,
          origin: 'https://jules.google.com',
          data: { type: 'JULES_CREATE_TASK_RPC', rpcId }
        })
      }
    }
    assert.strictEqual(await captured('Rja83dX'), false, 'a longer id is another RPC')
    tell('Qq7Rr')
    assert.strictEqual(await captured('Qq7Rr'), true)
    assert.strictEqual(await captured('Rja83d'), false)
    assert.strictEqual(await captured('abc12,Qq7Rr'), true, 'one of several rpcids')
    tell('not an id')
    assert.strictEqual(await captured('Rja83d'), true)
    tell('Qq7Rr')
    tell(null)
    assert.strictEqual(await captured('Rja83d'), true)
  })

  it('watches no id while content.js sends an empty one (CreateTask in doubt)', async () => {
    const { sandbox, messages, windowMock, listeners } = setupSandbox({})
    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })
    const payload = [null, null, ['m'], null, null, null, null, null, null, null]
    const base = 'https://jules.google.com/_/Swebot/data/batchexecute?rpcids='
    const captured = async (rpcId) => {
      const body = `f.req=${encodeURIComponent(JSON.stringify([[[rpcId, JSON.stringify(payload)]]]))}`
      const before = messages.length
      await windowMock.fetch(base + rpcId, { method: 'POST', body })
      return messages.slice(before).some((m) => m.data.type === 'JULES_START_CONFIG')
    }
    const tell = (rpcId) => {
      for (const listener of listeners.message) {
        listener({
          source: windowMock,
          origin: 'https://jules.google.com',
          data: { type: 'JULES_CREATE_TASK_RPC', rpcId }
        })
      }
    }
    tell('Qq7Rr')
    tell('')
    assert.strictEqual(await captured('Qq7Rr'), false, 'the doubted id is not read as CreateTask')
    assert.strictEqual(await captured('Rja83d'), false, 'nor is the built-in one')
    tell('Qq7Rr')
    assert.strictEqual(await captured('Qq7Rr'), true, 'a later id is watched again')
  })

  it('should gracefully handle malformed fetch payloads', async () => {
    const { sandbox, messages, windowMock } = setupSandbox({})

    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })
    const initialCount = messages.length

    // Call fetch with malformed body
    await windowMock.fetch('https://jules.google.com/_/Swebot/data/batchexecute?rpcids=Rja83d', {
      method: 'POST',
      body: 'f.req=invalid-json'
    })

    assert.strictEqual(messages.length, initialCount, 'Should not broadcast config on malformed fetch')
  })

  it('should handle fetch with missing body', async () => {
    const { sandbox, messages, windowMock } = setupSandbox({})

    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })
    const initialCount = messages.length

    await windowMock.fetch('https://jules.google.com/_/Swebot/data/batchexecute?rpcids=Rja83d', {
      method: 'POST'
    })

    assert.strictEqual(messages.length, initialCount)
  })

  it('should ignore other fetch calls', async () => {
    const { sandbox, messages, windowMock } = setupSandbox({})

    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })
    const initialCount = messages.length

    await windowMock.fetch('https://jules.google.com/other-api')

    assert.strictEqual(messages.length, initialCount)
  })

  it('should only install fetch observer once', () => {
    const { sandbox, windowMock } = setupSandbox({})

    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })
    const firstFetch = windowMock.fetch

    // Run script again
    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })
    assert.strictEqual(windowMock.fetch, firstFetch, 'Fetch should not be wrapped again')
  })

  it('installs over the observer an older version left in the page', async () => {
    const { sandbox, messages, windowMock, listeners } = setupSandbox({})
    windowMock.__julesArchiver = true // set by the old main-world.js, whose observer is still in fetch
    const oldFetch = windowMock.fetch
    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })
    assert.notStrictEqual(windowMock.fetch, oldFetch)
    for (const listener of listeners.message) {
      listener({
        source: windowMock,
        origin: 'https://jules.google.com',
        data: { type: 'JULES_CREATE_TASK_RPC', rpcId: 'Qq7Rr' }
      })
    }
    const payload = [null, null, ['m'], null, null, null, null, null, null, null]
    const body = `f.req=${encodeURIComponent(JSON.stringify([[['Qq7Rr', JSON.stringify(payload)]]]))}`
    await windowMock.fetch('https://jules.google.com/_/Swebot/data/batchexecute?rpcids=Qq7Rr', { body })
    assert.ok(messages.some((m) => m.data.type === 'JULES_START_CONFIG'))
  })

  it('reads the CreateTask entry of a request that carries several RPCs', async () => {
    const { sandbox, messages, windowMock } = setupSandbox({})
    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })
    const other = [null, null, ['not the model'], null, null, null, null, null, null, [null, null, null, null, ['x']]]
    const create = [
      null,
      null,
      ['model-config'],
      null,
      null,
      null,
      null,
      null,
      null,
      [null, null, null, null, ['exp1']]
    ]
    const entries = [
      ['abc12', JSON.stringify(other), null, '1'],
      ['Rja83d', JSON.stringify(create), null, '2']
    ]
    const body = `f.req=${encodeURIComponent(JSON.stringify([entries]))}`
    await windowMock.fetch('https://jules.google.com/_/Swebot/data/batchexecute?rpcids=abc12,Rja83d', { body })
    const start = messages.find((m) => m.data.type === 'JULES_START_CONFIG')
    assert.ok(start)
    assert.deepStrictEqual(start.data.config.modelConfig, ['model-config'])
    assert.deepStrictEqual(start.data.config.experimentIds, ['exp1'])
  })

  it('installs over the observer of the previous version too', () => {
    const { sandbox, windowMock } = setupSandbox({})
    windowMock.__julesArchiverObserver = 2 // read only freq[0][0], whatever RPC it was
    const oldFetch = windowMock.fetch
    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })
    assert.notStrictEqual(windowMock.fetch, oldFetch)
  })

  it('installs over the untagged version-3 observer and tags what it posts', async () => {
    const { sandbox, messages, windowMock } = setupSandbox({})
    // Version 3 before the tag: content.js drops its messages, so a newer one must install.
    windowMock.__julesArchiverObserver = 3
    const oldFetch = windowMock.fetch
    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })
    assert.notStrictEqual(windowMock.fetch, oldFetch)
    const payload = [null, null, ['m'], null, null, null, null, null, null, null]
    const body = `f.req=${encodeURIComponent(JSON.stringify([[['Rja83d', JSON.stringify(payload)]]]))}`
    await windowMock.fetch('https://jules.google.com/_/Swebot/data/batchexecute?rpcids=Rja83d', { body })
    assert.strictEqual(messages.find((m) => m.data.type === 'JULES_START_CONFIG')?.data.observer, 4)
  })

  it('lets a copy injected again after a reload retarget the first observer', async () => {
    const { sandbox, messages, windowMock, listeners } = setupSandbox({})
    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })
    vm.runInContext(mainWorldJs, sandbox, { filename: mainWorldJsPath })
    const second = listeners.message.at(-1)
    second({
      source: windowMock,
      origin: 'https://jules.google.com',
      data: { type: 'JULES_CREATE_TASK_RPC', rpcId: 'Qq7Rr' }
    })
    const payload = [null, null, ['m'], null, null, null, null, null, null, null]
    const body = `f.req=${encodeURIComponent(JSON.stringify([[['Qq7Rr', JSON.stringify(payload)]]]))}`
    await windowMock.fetch('https://jules.google.com/_/Swebot/data/batchexecute?rpcids=Qq7Rr', { body })
    assert.ok(messages.some((m) => m.data.type === 'JULES_START_CONFIG'))
  })
})
