const { describe, it } = require('node:test')
const assert = require('node:assert')
const {
  TASK_STATES,
  ITEM_ALL,
  ITEM_SUGGESTIONS,
  setTaskStates,
  getTaskStates,
  listItems,
  toggleItemSelection,
  combineItems,
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

describe('toggleItemSelection', () => {
  it('adds a task state, in listItems order', () => {
    assert.deepStrictEqual(toggleItemSelection(['state:12'], 'state:4'), ['state:12', 'state:4'])
    assert.deepStrictEqual(toggleItemSelection(['state:4'], 'state:12'), ['state:12', 'state:4'])
  })

  it('removes an already selected id and allows an empty selection', () => {
    assert.deepStrictEqual(toggleItemSelection(['state:12', 'state:4'], 'state:12'), ['state:4'])
    assert.deepStrictEqual(toggleItemSelection(['state:12'], 'state:12'), [])
  })

  it('never mutates its input', () => {
    const selected = ['state:12']
    const next = toggleItemSelection(selected, 'state:4')
    assert.deepStrictEqual(selected, ['state:12'])
    assert.notStrictEqual(next, selected)
  })

  it('picking All drops every task state and keeps Suggestions', () => {
    assert.deepStrictEqual(toggleItemSelection(['state:12', 'state:4', 'suggestions'], 'all'), ['all', 'suggestions'])
    assert.deepStrictEqual(toggleItemSelection([], 'all'), ['all'])
    assert.deepStrictEqual(toggleItemSelection(['all', 'suggestions'], 'all'), ['suggestions'])
  })

  it('picking a task state drops All', () => {
    assert.deepStrictEqual(toggleItemSelection(['all'], 'state:4'), ['state:4'])
    assert.deepStrictEqual(toggleItemSelection(['all', 'suggestions'], 'state:4'), ['state:4', 'suggestions'])
  })

  it('picking Suggestions keeps the task ids', () => {
    assert.deepStrictEqual(toggleItemSelection(['state:12', 'state:4'], 'suggestions'), [
      'state:12',
      'state:4',
      'suggestions'
    ])
    assert.deepStrictEqual(toggleItemSelection(['all'], 'suggestions'), ['all', 'suggestions'])
    assert.deepStrictEqual(toggleItemSelection(['suggestions'], 'suggestions'), [])
  })

  it('ignores an id that is not an item, returning a copy', () => {
    const selected = ['state:12']
    const next = toggleItemSelection(selected, 'nope')
    assert.deepStrictEqual(next, ['state:12'])
    assert.notStrictEqual(next, selected)
    assert.deepStrictEqual(toggleItemSelection([], 'state:99'), [])
  })
})

describe('combineItems', () => {
  const all = resolveItem('All')
  const suggestions = resolveItem('Suggestions')
  const waiting = resolveItem('Waiting on You (12)')
  const error = resolveItem('Error (4)')

  it('returns neither slot for an empty list', () => {
    assert.deepStrictEqual(combineItems([]), { tasks: null, suggestions: null })
  })

  it('keeps Suggestions on its own', () => {
    const combined = combineItems([suggestions])
    assert.strictEqual(combined.tasks, null)
    assert.strictEqual(combined.suggestions, suggestions)
  })

  it('returns a lone task item as it is, repeats included', () => {
    assert.strictEqual(combineItems([error]).tasks, error)
    assert.strictEqual(combineItems([error, error]).tasks, error)
  })

  it('returns All for All on its own, repeats included', () => {
    assert.strictEqual(combineItems([all]).tasks, all)
    assert.strictEqual(combineItems([all, all]).tasks, all)
  })

  it('refuses All together with any task item', () => {
    for (const item of [waiting, error, resolveItem('Completed')]) {
      const message = 'All already covers every task state; pick All or states'
      assert.throws(() => combineItems([all, item]), { message })
      assert.throws(() => combineItems([item, all]), { message })
      assert.throws(() => combineItems([all, item, suggestions]), { message })
    }
  })

  it('keeps All with Suggestions, which is no task item', () => {
    assert.deepStrictEqual(combineItems([all, suggestions]), { tasks: all, suggestions })
  })

  it('merges several task items in first-seen order, de-duplicated', () => {
    const merged = combineItems([error, waiting, error])
    assert.deepStrictEqual(merged.tasks, {
      id: 'multi:state:4+state:12',
      label: 'Error (4), Waiting on You (12)',
      group: 'Tasks',
      type: 'tasks',
      codes: [4, 12]
    })
    assert.notStrictEqual(merged.tasks.id, ITEM_ALL, 'a merged item is never treated as All')
    assert.strictEqual(merged.suggestions, null)
  })

  it('unions the codes of a shared name like Completed (3, 7) in first-seen order', () => {
    const merged = combineItems([resolveItem('Completed'), error])
    assert.deepStrictEqual(merged.tasks, {
      id: 'multi:name:completed+state:4',
      label: 'Completed, Error (4)',
      group: 'Tasks',
      type: 'tasks',
      codes: [3, 7, 4]
    })
  })

  it('keeps Suggestions beside the merged tasks', () => {
    const combined = combineItems([waiting, error, suggestions])
    assert.strictEqual(combined.suggestions, suggestions)
    assert.strictEqual(combined.tasks.id, 'multi:state:12+state:4')
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

describe('setTaskStates', () => {
  it('swaps the table every helper uses, and an empty table restores the built-in one', () => {
    const states = [
      { code: 42, name: 'Waiting on You', kind: 'feedback' },
      { code: 3, name: 'Completed', kind: 'completed' }
    ]
    try {
      setTaskStates(states)
      assert.strictEqual(getTaskStates(), states)
      assert.deepStrictEqual(
        listItems().map((i) => i.label),
        ['All', 'Waiting on You (42)', 'Completed (3)', 'Suggestions']
      )
      assert.deepStrictEqual(resolveItem('Waiting on You').codes, [42])
      assert.strictEqual(taskStateFor({ state: 12 }), null)
      setTaskStates([])
      assert.strictEqual(getTaskStates(), TASK_STATES)
    } finally {
      setTaskStates(null)
    }
  })

  it('lists a task without a state under the Completed code a rediscovery found', () => {
    // Jules renumbered Completed to 13 and gave 3 to another state.
    const states = [
      { code: 12, name: 'Waiting on You', kind: 'feedback' },
      { code: 3, name: 'Planning', kind: 'running' },
      { code: 13, name: 'Completed', kind: 'completed' }
    ]
    try {
      setTaskStates(states)
      assert.strictEqual(taskStateCode({ state: null }), 13)
      assert.strictEqual(taskStateFor({}).name, 'Completed')
      assert.ok(itemIncludesTask(resolveItem('Completed'), {}))
      assert.ok(!itemIncludesTask(resolveItem('Planning'), {}))
      assert.strictEqual(taskStateCode({ state: 3 }), 3, 'a task with a state keeps it')
    } finally {
      setTaskStates(null)
    }
    assert.strictEqual(taskStateCode({}), 3, 'the built-in table still says 3')
  })
})

describe('More Actions eligibility', () => {
  const { MORE_ACTIONS, moreActionFits, moreItemKey, moreSessionUrl } = require('../items.js')

  it("lists the actions in Jules' order, with Jules' words", () => {
    assert.deepStrictEqual(
      Object.values(MORE_ACTIONS).map((action) => action.label),
      [
        'Pause session',
        'Resume session',
        'Copy session URL',
        'Archive',
        'Unarchive',
        'Delete permanently',
        'Pause schedule',
        'Resume schedule',
        'Delete schedule'
      ]
    )
    assert.deepStrictEqual(
      Object.keys(MORE_ACTIONS).filter((action) => MORE_ACTIONS[action].local),
      ['copyUrl'],
      'only Copy session URL runs in the popup'
    )
    assert.strictEqual(MORE_ACTIONS.deleteSchedule.method, 'DeleteScheduledTask')
    assert.strictEqual(MORE_ACTIONS.deleteTask.method, 'DeleteTasks')
    assert.deepStrictEqual(
      Object.keys(MORE_ACTIONS).filter((action) => MORE_ACTIONS[action].destructive),
      ['deleteTask', 'deleteSchedule'],
      'the two actions that cannot be undone'
    )
  })

  it("builds a task's URL as Jules' Copy session URL does", () => {
    assert.strictEqual(moreSessionUrl({ account: 'u/1', id: '123456789' }), 'https://jules.google.com/task/123456789')
  })

  it('fits every action only to the supported kind and state', () => {
    for (const kind of ['task', 'archived', 'schedule', 'unknown']) {
      for (const state of [null, 0, 1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 99]) {
        const item = { kind, state }
        const expected = {
          pauseTask: kind === 'task' && [1, 2, 9, 11].includes(state),
          resumeTask: kind === 'task' && state === 8,
          copyUrl: kind === 'task' || kind === 'archived',
          archive: kind === 'task',
          unarchive: kind === 'archived',
          deleteTask: kind === 'archived',
          pauseSchedule: kind === 'schedule' && state === 2,
          resumeSchedule: kind === 'schedule' && state === 3,
          deleteSchedule: kind === 'schedule'
        }
        for (const action of Object.keys(MORE_ACTIONS)) {
          assert.strictEqual(moreActionFits(action, item), expected[action], `${action}, ${kind}, ${state}`)
        }
      }
    }
    assert.strictEqual(moreActionFits('delete', { kind: 'task', state: 2 }), false)
    assert.strictEqual(moreActionFits('archive', null), false)
  })

  it('uses rediscovered task states and keeps item identities distinct', () => {
    try {
      setTaskStates([{ code: 42, name: 'Working', kind: 'running' }])
      assert.strictEqual(moreActionFits('pauseTask', { kind: 'task', state: 42 }), true)
    } finally {
      setTaskStates(null)
    }
    const item = { account: 'u/1', kind: 'task', id: 'same' }
    assert.notStrictEqual(moreItemKey(item), moreItemKey({ ...item, account: 'u/2' }))
    assert.notStrictEqual(moreItemKey(item), moreItemKey({ ...item, kind: 'schedule' }))
  })
})
