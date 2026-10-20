/**
 * Jules Task Archiver — Items
 *
 * The Items dropdown shared by background.js, popup.js and the jules-archive
 * CLI: "All", one entry per Jules task state, and "Suggestions". A state's
 * label carries its code, e.g. "Waiting on You (12)".
 */

// ListTasks row[5] values, from the Jules web bundle's own state -> label map
// (2026-10-19), cross-checked against row[25] on 51 live tasks. `kind` decides
// what Proceed does with a task in that state.
const TASK_STATES = [
  { code: 12, name: 'Waiting on You', kind: 'feedback' },
  { code: 10, name: 'Awaiting Plan Approval', kind: 'plan' },
  { code: 4, name: 'Error', kind: 'error' },
  { code: 8, name: 'Paused', kind: 'paused' },
  { code: 2, name: 'In Progress', kind: 'running' },
  { code: 9, name: 'Planning', kind: 'running' },
  { code: 1, name: 'Queued', kind: 'running' },
  { code: 11, name: 'Queued Restart', kind: 'running' },
  { code: 3, name: 'Completed', kind: 'completed' },
  { code: 7, name: 'Completed', kind: 'completed' },
  { code: 0, name: 'Unknown', kind: 'unknown' }
]

// Jules shows a task without a state code as Completed, so it is listed under
// Completed (3).
const NO_STATE_CODE = 3

const ITEM_ALL = 'all'
const ITEM_SUGGESTIONS = 'suggestions'

// The table in use: TASK_STATES, or the states "Rediscover from Jules" read
// from the Jules bundle (settings.js).
let activeTaskStates = TASK_STATES

function setTaskStates(states) {
  activeTaskStates = Array.isArray(states) && states.length > 0 ? states : TASK_STATES
}

function getTaskStates() {
  return activeTaskStates
}

function listItems(states = activeTaskStates) {
  return [
    { id: ITEM_ALL, label: 'All', group: 'Tasks', type: 'tasks', codes: null },
    ...states.map((s) => ({
      id: `state:${s.code}`,
      label: `${s.name} (${s.code})`,
      name: s.name,
      code: s.code,
      group: 'Tasks',
      type: 'tasks',
      codes: [s.code]
    })),
    { id: ITEM_SUGGESTIONS, label: 'Suggestions', group: 'Suggestions', type: 'suggestions', codes: null }
  ]
}

function normalizeItemText(value) {
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase()
}

// Accepts an item id ("state:12"), a dropdown label ("Waiting on You (12)") or
// a state name without its code ("Completed" covers both 3 and 7). Case and
// spacing don't matter. Returns null when nothing matches.
function resolveItem(input, states = activeTaskStates) {
  if (typeof input !== 'string') return null
  const wanted = normalizeItemText(input)
  if (!wanted) return null
  const items = listItems(states)
  const exact = items.find((i) => i.id === wanted || normalizeItemText(i.label) === wanted)
  if (exact) return exact
  const named = states.filter((s) => normalizeItemText(s.name) === wanted)
  if (named.length === 0) return null
  if (named.length === 1) return items.find((i) => i.code === named[0].code)
  return {
    id: `name:${wanted}`,
    label: named[0].name,
    name: named[0].name,
    group: 'Tasks',
    type: 'tasks',
    codes: named.map((s) => s.code)
  }
}

function taskStateCode(task) {
  return task?.state ?? NO_STATE_CODE
}

// The state a task is listed under, or null for a code Jules added later.
function taskStateFor(task, states = activeTaskStates) {
  const code = taskStateCode(task)
  return states.find((s) => s.code === code) || null
}

function isCompletedTask(task, states = activeTaskStates) {
  return taskStateFor(task, states)?.kind === 'completed'
}

function itemIncludesTask(item, task) {
  if (item?.type !== 'tasks') return false
  return item.codes === null || item.codes.includes(taskStateCode(task))
}

// Shared eligibility keeps the action counts and the worker's checks in step.
const MORE_ACTIONS = {
  archive: { label: 'Archive', method: 'ArchiveTasks' },
  unarchive: { label: 'Unarchive', method: 'ArchiveTasks' },
  pauseTask: { label: 'Pause task', method: 'PauseTask' },
  resumeTask: { label: 'Resume task', method: 'ResumeTask' },
  pauseSchedule: { label: 'Pause schedule', method: 'PauseScheduledTask' },
  resumeSchedule: { label: 'Resume schedule', method: 'ResumeScheduledTask' }
}

function moreItemKey(item) {
  return JSON.stringify([item.account, item.kind, item.id])
}

function moreActionFits(action, item) {
  if (!item) return false
  switch (action) {
    case 'archive':
      return item.kind === 'task'
    case 'unarchive':
      return item.kind === 'archived'
    case 'pauseTask':
      return item.kind === 'task' && taskStateFor(item)?.kind === 'running'
    case 'resumeTask':
      return item.kind === 'task' && taskStateFor(item)?.kind === 'paused'
    case 'pauseSchedule':
      return item.kind === 'schedule' && item.state === 2
    case 'resumeSchedule':
      return item.kind === 'schedule' && item.state === 3
    default:
      return false
  }
}

if (typeof module !== 'undefined') {
  module.exports = {
    MORE_ACTIONS,
    moreItemKey,
    moreActionFits,
    TASK_STATES,
    NO_STATE_CODE,
    ITEM_ALL,
    ITEM_SUGGESTIONS,
    setTaskStates,
    getTaskStates,
    listItems,
    resolveItem,
    taskStateCode,
    isCompletedTask,
    taskStateFor,
    itemIncludesTask
  }
}
