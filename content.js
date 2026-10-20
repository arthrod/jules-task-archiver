// Modified by tommyzed: Updated message types and codebases
/**
 * Jules Task Archiver — Content Script (Isolated World)
 *
 * Listens for config tokens posted by main-world.js via window.postMessage.
 * Relays StartSuggestion config to background service worker.
 * Handles chrome.runtime messages from background/popup.
 */

// Store config extracted from MAIN world
let cachedConfig = null

// Tell main-world.js which CreateTask RPC id to watch: the one saved in the
// Jules API values (settings.js), or null for the built-in one.
function postCreateTaskRpc(julesApi) {
  const rpcId = julesApi?.rpc?.CreateTask
  window.postMessage(
    { type: 'JULES_CREATE_TASK_RPC', rpcId: typeof rpcId === 'string' ? rpcId : null },
    window.location.origin
  )
}

function sendCreateTaskRpc() {
  chrome.storage?.local?.get?.('julesApi', (data) => postCreateTaskRpc(data?.julesApi))
}

// Inject main-world.js into the page to access variables
function injectMainWorldScript() {
  const script = document.createElement('script')
  script.src = chrome.runtime.getURL('main-world.js')
  script.onload = () => {
    script.remove()
    sendCreateTaskRpc()
  }
  ;(document.head || document.documentElement).appendChild(script)
}
injectMainWorldScript()

chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && 'julesApi' in changes) postCreateTaskRpc(changes.julesApi.newValue)
})

// Reject messages that did not originate from this page's own window/origin.
// The MAIN world script and isolated world share the same window and origin,
// so anything failing these checks is a cross-origin/cross-frame spoof attempt.
function isTrustedMessage(event) {
  if (event.source !== window || event.origin !== window.location.origin) return false
  const type = event.data?.type
  if (typeof type !== 'string' || !type.startsWith('JULES_')) return false
  if (type.endsWith('_CONFIG') && type !== 'JULES_REQUEST_CONFIG' && !event.data?.config) return false
  return true
}

// Listen for messages from MAIN world script
window.addEventListener('message', (event) => {
  if (!isTrustedMessage(event)) return
  if (event.data?.type === 'JULES_ARCHIVER_CONFIG') {
    cachedConfig = event.data.config
  }
  if (event.data?.type === 'JULES_START_CONFIG') {
    chrome.runtime.sendMessage({
      action: 'CACHE_START_CONFIG',
      config: event.data.config
    })
  }
})

// Request fresh config from MAIN world script
// `fresh` skips the cache: the background asks for it when Jules rejected the
// cached tokens.
function extractConfig(fresh = false) {
  // If already cached and fresh (less than 5 min old), return it
  if (!fresh && cachedConfig?.timestamp && Date.now() - cachedConfig.timestamp < 300000) {
    return Promise.resolve(cachedConfig)
  }

  return new Promise((resolve) => {
    // Ask main-world.js to re-broadcast config
    window.postMessage({ type: 'JULES_REQUEST_CONFIG' }, window.location.origin)

    function handler(event) {
      if (!isTrustedMessage(event)) return
      if (event.data?.type !== 'JULES_ARCHIVER_CONFIG') return
      window.removeEventListener('message', handler)
      clearTimeout(timeout)
      cachedConfig = event.data.config
      resolve(cachedConfig)
    }

    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler)
      resolve(cachedConfig)
    }, 2000)

    window.addEventListener('message', handler)
  })
}

// Detect account from URL
// ⚡ Bolt Optimization: Use a pre-compiled regex and .exec() instead of .split('/')
// to avoid creating intermediate array allocations when parsing the URL pathname.
const ACCOUNT_NUM_REGEX = /\/u\/(\d+)(?:\/|$)/
function getAccountNum() {
  try {
    const match = ACCOUNT_NUM_REGEX.exec(new URL(location.href).pathname)
    return match ? match[1] : '0'
  } catch (_e) {
    return '0'
  }
}

function getAccountLabel() {
  const num = getAccountNum()
  return num !== '0' ? `u/${num}` : 'default'
}

// Message handler
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case 'PING':
      sendResponse({ ok: true, account: getAccountLabel() })
      break

    case 'GET_CONFIG':
      extractConfig(msg.fresh === true).then((config) => {
        sendResponse({
          config,
          accountNum: getAccountNum(),
          account: getAccountLabel()
        })
      })
      return true // async response

    // Fallback repo list for the popup's picker, scraped from the Jules
    // codebases page when the YqkSHd lookup returns nothing.
    case 'GET_CODEBASES': {
      const codebases = Array.from(document.querySelectorAll('.source-row.clickable-row'))
        .map((el) => {
          const owner = el.querySelector('.owner')?.textContent.trim() || ''
          const repo = el.querySelector('.repo')?.textContent.trim() || ''
          return owner && repo ? `${owner}/${repo}` : ''
        })
        .filter(Boolean)
      sendResponse({ codebases })
      break
    }

    default:
      sendResponse({ error: 'Unknown action' })
  }
})

// Exposure for testing
if (typeof globalThis !== 'undefined' && globalThis.TEST_MODE) {
  globalThis.test_cachedConfig = {
    get: () => cachedConfig,
    set: (v) => {
      cachedConfig = v
    }
  }
  globalThis.test_extractConfig = extractConfig
  globalThis.test_getAccountNum = getAccountNum
  globalThis.test_getAccountLabel = getAccountLabel
  globalThis.test_injectMainWorldScript = injectMainWorldScript
}
