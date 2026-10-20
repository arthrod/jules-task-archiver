const { describe, it } = require('node:test')
const assert = require('node:assert')
const {
  RUN_PROTOCOL,
  DEFAULT_SETTINGS,
  JULES_RPC_DEFAULTS,
  normalizeSettings,
  settingsFromSync,
  settingsToSync,
  normalizeJulesApi,
  pickStateMap,
  statesFromBundle,
  applyDiscovery
} = require('../settings.js')
const { TASK_STATES } = require('../items.js')

// The two [[0,"Unknown"],...] maps in the Jules bundle on 2026-10-19: row[5]
// (the one the extension uses) and the row[25] enum.
const ROW5_MAP = [
  [0, 'Unknown'],
  [1, 'Queued'],
  [11, 'Queued restart'],
  [2, 'In progress'],
  [9, 'Planning'],
  [12, 'Awaiting user feedback'],
  [10, 'Awaiting plan approval'],
  [3, 'Completed'],
  [4, 'Error'],
  [8, 'Paused'],
  [7, 'Completed']
]
const ROW25_MAP = [
  [0, 'Unknown'],
  [1, 'Pending'],
  [2, 'Queued'],
  [3, 'In progress'],
  [4, 'Awaiting plan approval'],
  [5, 'Awaiting user feedback'],
  [6, 'Completed'],
  [7, 'Error'],
  [8, 'Completed'],
  [9, 'Paused']
]
const LIVE_RPC = Object.entries(JULES_RPC_DEFAULTS).map(([name, id]) => [id, `SweBotService.${name}`])
const live = (overrides = {}) => ({
  rpc: [...LIVE_RPC, ['AbCdE', 'OtherService.ListTasks']],
  stateMaps: [ROW5_MAP, ROW25_MAP],
  ...overrides
})
const plain = (value) => JSON.parse(JSON.stringify(value))

describe('normalizeSettings', () => {
  it('fills in every default', () => {
    assert.deepStrictEqual(normalizeSettings(undefined), DEFAULT_SETTINGS)
    assert.deepStrictEqual(normalizeSettings({}), DEFAULT_SETTINGS)
  })

  it('clamps numbers into range and rounds them', () => {
    const s = normalizeSettings({
      requestTimeoutSec: 1,
      listTimeoutSec: 99999,
      perAccountParallel: '3.6',
      runLimit: -4
    })
    assert.strictEqual(s.requestTimeoutSec, 5)
    assert.strictEqual(s.listTimeoutSec, 1800)
    assert.strictEqual(s.perAccountParallel, 4)
    assert.strictEqual(s.runLimit, 0)
  })

  it('treats an empty or unreadable number as its default', () => {
    const s = normalizeSettings({ requestTimeoutSec: '', extraJitterMaxSec: 'abc', runLimit: '' })
    assert.strictEqual(s.requestTimeoutSec, 30)
    assert.strictEqual(s.extraJitterMaxSec, 10)
    assert.strictEqual(s.runLimit, 0)
  })

  it('keeps "Run up to" at 1', () => {
    assert.strictEqual(normalizeSettings({ runLimit: 1 }).runLimit, 1)
  })

  it('reloads the tab unless it was turned off, and adds extra jitter only when turned on', () => {
    assert.strictEqual(normalizeSettings({ reloadTabOnSignIn: 'no' }).reloadTabOnSignIn, true)
    assert.strictEqual(normalizeSettings({ reloadTabOnSignIn: false }).reloadTabOnSignIn, false)
    assert.strictEqual(normalizeSettings({ extraJitter: 'yes' }).extraJitter, false)
    assert.strictEqual(normalizeSettings({ extraJitter: true }).extraJitter, true)
  })

  it('trims and caps the default messages', () => {
    const s = normalizeSettings({ defaultReply: '  Go  ', defaultRetry: 'x'.repeat(3000) })
    assert.strictEqual(s.defaultReply, 'Go')
    assert.strictEqual(s.defaultRetry.length, 2000)
  })
})

describe('settings in chrome.storage.sync', () => {
  // chrome.storage.sync measures an item as its key plus its JSON value.
  const itemBytes = (key, value) => Buffer.byteLength(key + JSON.stringify(value))

  it('keeps every item under the 8 KB sync limit with two full messages', () => {
    const full = '"'.repeat(2000) // each quote is two bytes in JSON
    const items = settingsToSync({ defaultReply: full, defaultRetry: full, runLimit: 1 })
    for (const [key, value] of Object.entries(items)) assert.ok(itemBytes(key, value) < 8192, key)
    assert.ok(itemBytes('settings', normalizeSettings({ defaultReply: full, defaultRetry: full })) > 8192)
  })

  it('reads back what it writes', () => {
    const values = normalizeSettings({ defaultReply: 'Go', defaultRetry: 'Again', runLimit: 1, extraJitter: true })
    assert.deepStrictEqual(settingsFromSync(settingsToSync(values)), values)
  })

  it("falls back to the old popup's reply boxes while the new ones are empty", () => {
    const s = settingsFromSync({ continueMessage: 'Old', continueErrorMessage: 'Old retry', defaultRetry: 'New' })
    assert.strictEqual(s.defaultReply, 'Old')
    assert.strictEqual(s.defaultRetry, 'New')
  })
})

describe('normalizeJulesApi', () => {
  it('falls back to the built-in values', () => {
    assert.deepStrictEqual(plain(normalizeJulesApi(null)), {
      rpc: JULES_RPC_DEFAULTS,
      archiveBatch: 50,
      archiveSplit: 10,
      states: null,
      checkedAt: null
    })
  })

  it('drops an RPC id that is not 5-6 letters or digits', () => {
    const api = normalizeJulesApi({ rpc: { ListTasks: 'x', ArchiveTasks: 'Zz9Yy', GetTask: 'a"b' } })
    assert.strictEqual(api.rpc.ListTasks, 'p1Takd')
    assert.strictEqual(api.rpc.ArchiveTasks, 'Zz9Yy')
    assert.strictEqual(api.rpc.GetTask, 'n74qPd')
  })

  it('never lets the fallback chunk exceed the batch', () => {
    const api = normalizeJulesApi({ archiveBatch: 5, archiveSplit: 20 })
    assert.deepStrictEqual([api.archiveBatch, api.archiveSplit], [5, 5])
  })

  it('rejects a state table with duplicate codes or an unknown kind', () => {
    assert.strictEqual(
      normalizeJulesApi({
        states: [
          { code: 1, name: 'A', kind: 'running' },
          { code: 1, name: 'B', kind: 'running' }
        ]
      }).states,
      null
    )
    assert.strictEqual(normalizeJulesApi({ states: [{ code: 1, name: 'A', kind: 'delete' }] }).states, null)
  })
})

describe('reading the Jules bundle', () => {
  it('picks the row[5] state map, not the row[25] enum', () => {
    assert.strictEqual(pickStateMap([ROW25_MAP, ROW5_MAP]), ROW5_MAP)
    assert.strictEqual(pickStateMap([ROW25_MAP]), null)
    assert.strictEqual(pickStateMap([ROW5_MAP, ROW5_MAP]), null, 'two candidates are ambiguous')
  })

  it("maps today's bundle to exactly the built-in states, in dropdown order", () => {
    assert.deepStrictEqual(statesFromBundle(ROW5_MAP), TASK_STATES)
  })
})

describe('applyDiscovery', () => {
  it("changes nothing when the bundle matches today's values", () => {
    const { api, changes, problems } = applyDiscovery(null, live(), TASK_STATES)
    assert.deepStrictEqual(changes, [])
    assert.deepStrictEqual(problems, [])
    assert.deepStrictEqual(plain(api.rpc), JULES_RPC_DEFAULTS)
    assert.strictEqual(api.states, null)
  })

  it('follows an RPC id Google renamed and reports it', () => {
    const rpc = LIVE_RPC.map(([id, m]) => (m === 'SweBotService.ArchiveTasks' ? ['Qq7Rr', m] : [id, m]))
    const { api, changes } = applyDiscovery(null, live({ rpc }), TASK_STATES)
    assert.strictEqual(api.rpc.ArchiveTasks, 'Qq7Rr')
    assert.deepStrictEqual(changes, ['ArchiveTasks: Tjmm5c → Qq7Rr'])
  })

  it('ignores the same method name in another service', () => {
    const { api } = applyDiscovery(null, live(), TASK_STATES)
    assert.strictEqual(api.rpc.ListTasks, 'p1Takd')
  })

  it('keeps the current id when a method is missing or has two ids', () => {
    const rpc = LIVE_RPC.filter(([, m]) => m !== 'SweBotService.GetTask')
    rpc.push(['Ab12C', 'SweBotService.Interact'])
    const { api, problems } = applyDiscovery(null, live({ rpc }), TASK_STATES)
    assert.strictEqual(api.rpc.GetTask, 'n74qPd')
    assert.strictEqual(api.rpc.Interact, 'SLmX6')
    assert.ok(problems.includes('GetTask not found; keeping n74qPd'))
    assert.ok(problems.includes('Interact has more than one id in the bundle; keeping SLmX6'))
  })

  it('changes nothing when most RPCs are missing (the bundle changed shape)', () => {
    const current = { rpc: { ListTasks: 'Keep1' } }
    const { api, changes, problems } = applyDiscovery(
      current,
      live({ rpc: [['Zz9Yy', 'SweBotService.ListTasks']] }),
      TASK_STATES
    )
    assert.strictEqual(api.rpc.ListTasks, 'Keep1')
    assert.deepStrictEqual(changes, [])
    assert.match(problems[0], /didn't look as expected \(found 1 of 14 RPCs\); nothing changed/)
  })

  it('follows renumbered states and reports a state Jules added', () => {
    const map = ROW5_MAP.map(([code, label]) => (label === 'Awaiting user feedback' ? [13, label] : [code, label]))
    map.push([14, 'Awaiting review'])
    const { api, changes, problems } = applyDiscovery(null, live({ stateMaps: [map, ROW25_MAP] }), TASK_STATES)
    const byCode = Object.fromEntries(api.states.map((s) => [s.code, s]))
    assert.deepStrictEqual(byCode[13], { code: 13, name: 'Waiting on You', kind: 'feedback' })
    assert.deepStrictEqual(byCode[14], { code: 14, name: 'Awaiting Review', kind: 'unknown' })
    assert.strictEqual(byCode[12], undefined)
    assert.deepStrictEqual(changes.sort(), [
      'state 13 added: Waiting on You',
      'state 14 added: Awaiting Review',
      'state removed: Waiting on You (12)'
    ])
    assert.ok(problems.some((p) => p.includes('New state Awaiting Review (14)')))
  })

  it('goes back to the built-in states once Jules matches them again', () => {
    const current = { states: [{ code: 13, name: 'Waiting on You', kind: 'feedback' }] }
    const { api } = applyDiscovery(current, live(), TASK_STATES)
    assert.strictEqual(api.states, null)
  })

  it('keeps the current states when the state map is missing', () => {
    const { api, problems } = applyDiscovery(null, live({ stateMaps: [ROW25_MAP] }), TASK_STATES)
    assert.strictEqual(api.states, null)
    assert.ok(problems.includes('Task state map not found; keeping the current states.'))
  })
})

describe('More Actions protocol', () => {
  it('requires protocol 5 and exposes rediscoverable action methods', () => {
    assert.strictEqual(RUN_PROTOCOL, 5)
    for (const [method, id] of Object.entries({
      ListScheduledTasks: 'hvmRxc',
      PauseScheduledTask: 'gBUOb',
      ResumeScheduledTask: 'XuzQWe',
      PauseTask: 'tqq5v'
    })) {
      assert.strictEqual(JULES_RPC_DEFAULTS[method], id)
      const { api, changes } = applyDiscovery(
        null,
        live({
          rpc: [
            ...LIVE_RPC.filter(([, name]) => name !== `SweBotService.${method}`),
            ['Ab12C', `SweBotService.${method}`]
          ]
        }),
        TASK_STATES
      )
      assert.strictEqual(api.rpc[method], 'Ab12C')
      assert.ok(changes.some((change) => change.startsWith(`${method}:`)))
    }
  })
})
