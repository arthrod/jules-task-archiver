/**
 * Jules Task Archiver — MAIN World Script
 *
 * Runs in the page's MAIN world (not isolated).
 * Reads WIZ_global_data tokens and installs a fetch observer
 * for StartSuggestion (CreateTask, Rja83d today) config capture.
 *
 * Communicates with content.js (isolated world) via window.postMessage.
 */

// Extract config and post to isolated world
function broadcastConfig() {
  const w = window.WIZ_global_data
  const modelMatch = w?.TSDtV ? String(w.TSDtV).match(/beyond:models\/[\w-]+/) : null

  window.postMessage(
    {
      type: 'JULES_ARCHIVER_CONFIG',
      config: w
        ? {
            at: w.SNlM0e || null,
            bl: w.cfb2h || null,
            fsid: w.FdrFJe || null,
            modelId: modelMatch ? modelMatch[0] : null,
            // The signed-in Google account: u/N can be another one after a sign-in change.
            user: typeof w.S06Grb === 'string' && w.S06Grb ? w.S06Grb : null,
            timestamp: Date.now()
          }
        : null
    },
    window.location.origin
  )
}

// The CreateTask RPC id to watch. content.js sends the one in force (Settings
// or the last rediscovery), so a renamed id keeps working. It lives on window,
// not in a top-level let: an extension reload injects this file into the same
// page again, where a second let would throw, and the observer the first copy
// installed must see the id the second copy receives. '' (CreateTask in doubt)
// watches none: null.
function createTaskRpc() {
  const rpcId = window.__julesArchiverCreateTaskRpc
  if (rpcId === '') return null
  return typeof rpcId === 'string' && /^[A-Za-z0-9]{5,6}$/.test(rpcId) ? rpcId : 'Rja83d'
}

function callsRpc(url, rpcId) {
  const match = /[?&]rpcids=([^&#]*)/.exec(url)
  if (!match) return false
  try {
    return decodeURIComponent(match[1]).split(',').includes(rpcId)
  } catch (_e) {
    return false
  }
}

// The page may call fetch(url, init), fetch(URL) or fetch(Request).
function requestUrl(input) {
  if (typeof input === 'string') return input
  return typeof input?.url === 'string' ? input.url : String(input ?? '')
}

// A Request carries its own body, which the page's fetch then consumes, so a
// clone is read before the call. A body in init wins over the Request's.
function requestBody(input, opts) {
  if (opts?.body != null) return Promise.resolve(opts.body)
  if (typeof input?.clone === 'function')
    return input
      .clone()
      .text()
      .catch(() => '')
  return Promise.resolve('')
}

// Install fetch observer for StartSuggestion config capture, once per
// version: a page kept open across an update still runs the old observer
// (Part 1's watched only a hardcoded Rja83d; version 2 read the first RPC of
// a request, whichever it was), so a newer one installs on top. Its messages
// carry the version, and content.js relays only this one: bump all three together.
if (window.__julesArchiverObserver !== 3) {
  window.__julesArchiverObserver = 3
  window.__julesArchiver = true

  const _origFetch = window.fetch
  window.fetch = async function (...args) {
    const [input, opts] = args
    const rpcId = createTaskRpc()
    const body = rpcId && callsRpc(requestUrl(input), rpcId) ? requestBody(input, opts) : null
    const resp = await _origFetch.apply(this, args)
    if (body) {
      try {
        const params = new URLSearchParams(await body)
        const freq = JSON.parse(params.get('f.req'))
        // One request can carry several RPCs, each as [rpcId, payload, ...].
        const entry = freq[0].find((e) => e?.[0] === rpcId)
        const payload = JSON.parse(entry[1])
        window.postMessage(
          {
            type: 'JULES_START_CONFIG',
            observer: 3,
            config: {
              modelConfig: payload[2],
              experimentIds: payload[9]?.[4] || [],
              featureFlags: payload[2]?.[10] || [],
              capturedAt: Date.now()
            }
          },
          window.location.origin
        )
      } catch (_e) {
        /* ignore parse errors */
      }
    }
    return resp
  }
}

// Broadcast config immediately (WIZ_global_data should be ready by document_idle)
broadcastConfig()

// Also listen for explicit re-extract requests from content.js.
// Only honour requests from this page's own window/origin — a cross-origin
// frame must not be able to trigger config broadcasts.
window.addEventListener('message', (event) => {
  if (event.source !== window) return
  if (event.origin !== window.location.origin) return
  if (event.data?.type === 'JULES_REQUEST_CONFIG') {
    broadcastConfig()
  }
  if (event.data?.type === 'JULES_CREATE_TASK_RPC') window.__julesArchiverCreateTaskRpc = event.data.rpcId
})
