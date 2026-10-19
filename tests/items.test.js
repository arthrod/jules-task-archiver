const { describe, it } = require('node:test')
const assert = require('node:assert')
const {
  TASK_STATES,
  ITEM_ALL,
  ITEM_SUGGESTIONS,
  listItems,
  resolveItem,
  taskStateCode,
  taskStateFor,
  itemIncludesTask
} = require('../items.js')

describe('listItems', () => {
  it('lists All, every task state with its code, then Suggestions', () => {
    const labels = listItems().map((i) => i.label)
    assert.deepStrictEqual(labels, [
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
    ])
  })

  it('groups the states under Tasks and Suggestions on its own', () => {
    const items = listItems()
    assert.ok(items.slice(0, -1).every((i) => i.group === 'Tasks' && i.type === 'tasks'))
    assert.deepStrictEqual(
      { group: items.at(-1).group, type: items.at(-1).type },
      { group: 'Suggestions', type: 'suggestions' }
    )
  })

  it('gives every item a unique id', () => {
    const ids = listItems().map((i) => i.id)
    assert.strictEqual(new Set(ids).size, ids.length)
  })
})

describe('resolveItem', () => {
  it('resolves the exact dropdown label', () => {
    assert.deepStrictEqual(resolveItem('Waiting on You (12)').codes, [12])
    assert.strictEqual(resolveItem('All').id, ITEM_ALL)
    assert.strictEqual(resolveItem('Suggestions').id, ITEM_SUGGESTIONS)
  })

  it('ignores case and extra spaces', () => {
    assert.deepStrictEqual(resolveItem('  waiting   ON you (12) ').codes, [12])
    assert.strictEqual(resolveItem('ALL').id, ITEM_ALL)
  })

  it('resolves an item id', () => {
    assert.strictEqual(resolveItem('state:4').label, 'Error (4)')
  })

  it('resolves a state name without its code', () => {
    assert.strictEqual(resolveItem('Error').label, 'Error (4)')
    assert.strictEqual(resolveItem('waiting on you').label, 'Waiting on You (12)')
  })

  it('resolves a shared name to every state that carries it', () => {
    const item = resolveItem('Completed')
    assert.strictEqual(item.label, 'Completed')
    assert.strictEqual(item.type, 'tasks')
    assert.deepStrictEqual(item.codes, [3, 7])
  })

  it('returns null for anything else', () => {
    for (const input of ['', '   ', 'Waiting', 'Completed (5)', 'state:99', null, undefined, 12, {}]) {
      assert.strictEqual(resolveItem(input), null, `input ${JSON.stringify(input)}`)
    }
  })

  it('uses the state list it is given', () => {
    const states = [{ code: 42, name: 'Waiting on You', kind: 'feedback' }]
    assert.deepStrictEqual(resolveItem('Waiting on You (42)', states).codes, [42])
    assert.strictEqual(resolveItem('Waiting on You (12)', states), null)
  })
})

describe('task state helpers', () => {
  it('lists a task without a state code under Completed (3)', () => {
    assert.strictEqual(taskStateCode({ state: null }), 3)
    assert.strictEqual(taskStateCode({}), 3)
    assert.strictEqual(taskStateFor({ state: undefined }).name, 'Completed')
  })

  it('keeps a zero state code as Unknown', () => {
    assert.strictEqual(taskStateCode({ state: 0 }), 0)
    assert.strictEqual(taskStateFor({ state: 0 }).kind, 'unknown')
  })

  it('returns null for a state code Jules added later', () => {
    assert.strictEqual(taskStateFor({ state: 99 }), null)
  })

  it('maps every state to what Proceed does with it', () => {
    const kinds = Object.fromEntries(TASK_STATES.map((s) => [s.code, s.kind]))
    assert.deepStrictEqual(kinds, {
      0: 'unknown',
      1: 'running',
      2: 'running',
      3: 'completed',
      4: 'error',
      7: 'completed',
      8: 'paused',
      9: 'running',
      10: 'plan',
      11: 'running',
      12: 'feedback'
    })
  })
})

describe('itemIncludesTask', () => {
  it('All includes every task, whatever its state', () => {
    const all = resolveItem('All')
    for (const state of [0, 1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 99, null]) {
      assert.strictEqual(itemIncludesTask(all, { state }), true, `state ${state}`)
    }
  })

  it('a state item includes only its own code', () => {
    const item = resolveItem('Error (4)')
    assert.strictEqual(itemIncludesTask(item, { state: 4 }), true)
    assert.strictEqual(itemIncludesTask(item, { state: 12 }), false)
  })

  it('Completed (3) includes tasks without a state code', () => {
    assert.strictEqual(itemIncludesTask(resolveItem('Completed (3)'), { state: null }), true)
    assert.strictEqual(itemIncludesTask(resolveItem('Completed (7)'), { state: null }), false)
  })

  it('Suggestions never includes a task', () => {
    assert.strictEqual(itemIncludesTask(resolveItem('Suggestions'), { state: 12 }), false)
  })
})
