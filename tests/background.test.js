// Modified by tommyzed: Added repository filtering test cases
const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { RUN_PROTOCOL } = require('../settings.js')

const bgScriptPath = path.join(__dirname, '..', 'background.js')
const utilsScriptPath = path.join(__dirname, '..', 'utils.js')
const itemsScriptPath = path.join(__dirname, '..', 'items.js')
const bgScriptContent = fs.readFileSync(bgScriptPath, 'utf8')
const utilsScriptContent = fs.readFileSync(utilsScriptPath, 'utf8')
const itemsScriptContent = fs.readFileSync(itemsScriptPath, 'utf8')
const settingsScriptContent = fs.readFileSync(path.join(__dirname, '..', 'settings.js'), 'utf8')

function setupEnvironment(initialStorage = {}, initialSyncStorage = {}, { sessionReady = null, prepare = null } = {}) {
  const sessionSetData = []
  let currentStorage = { ...initialStorage }
  let syncStorage = { ...initialSyncStorage }
  const storageChangeListeners = []
  const alarmListeners = []
  const alarmsStore = new Map()
  const messageListeners = []

  const chromeMock = {
    storage: {
      session: {
        get: async (key) => {
          // A worker that just woke up reads its saved state a little later.
          if (sessionReady) await sessionReady
          return key ? { [key]: currentStorage[key] } : currentStorage
        },
        set: async (data) => {
          sessionSetData.push(data)
          currentStorage = { ...currentStorage, ...data }
        }
      },
      sync: {
        get: async (keys) => {
          if (Array.isArray(keys)) {
            const res = {}
            for (const k of keys) res[k] = syncStorage[k]
            return res
          }
          return { ...syncStorage }
        },
        set: async (data) => {
          const changes = {}
          for (const k of Object.keys(data)) {
            changes[k] = { oldValue: syncStorage[k], newValue: data[k] }
          }
          syncStorage = { ...syncStorage, ...data }
          for (const cb of storageChangeListeners) cb(changes, 'sync')
        },
        remove: async (key) => {
          delete syncStorage[key]
        }
      },
      local: {
        get: async () => ({}),
        set: async () => {}
      },
      onChanged: {
        addListener: (cb) => storageChangeListeners.push(cb)
      }
    },
    alarms: {
      create: async (name, info) => {
        alarmsStore.set(name, { name, ...info })
      },
      get: async (name) => alarmsStore.get(name),
      clear: async (name) => {
        const had = alarmsStore.delete(name)
        return had
      },
      clearAll: async () => {
        alarmsStore.clear()
      },
      onAlarm: {
        addListener: (cb) => alarmListeners.push(cb)
      }
    },
    runtime: {
      onMessage: { addListener: (cb) => messageListeners.push(cb) },
      getPlatformInfo: async () => ({})
    },
    webNavigation: {
      getFrame: async () => ({ url: 'https://jules.google.com/u/0/session', documentId: 'doc1' })
    },
    tabs: {
      query: async () => [],
      get: async (id) => ({ id, url: 'https://jules.google.com/u/0/session' }),
      sendMessage: async () => ({
        config: { at: 'token', bl: 'build', fsid: '123' },
        accountNum: '0',
        account: 'default'
      })
    },
    scripting: {
      executeScript: async () => {}
    }
  }

  const activeTimers = []
  const clearedTimers = []
  const sandbox = {
    chrome: chromeMock,
    fetch: async () => ({ ok: true, json: async () => [], text: async () => ")]}'\n\n4\n[[]]" }),
    setTimeout,
    clearTimeout,
    // No-op timer mocks: the real keepAlive interval would otherwise keep the
    // Node event loop alive and hang the test process after all tests pass.
    setInterval: (fn, ms) => {
      const id = activeTimers.length + 1
      activeTimers.push({ id, fn, ms })
      return id
    },
    clearInterval: (id) => {
      clearedTimers.push(id)
    },
    test_activeTimers: activeTimers,
    test_clearedTimers: clearedTimers,
    Math,
    Date,
    JSON,
    String,
    Array,
    Map,
    Object,
    Error,
    URLSearchParams,
    URL,
    Promise,
    console,
    parseInt,
    crypto,
    importScripts: () => {},
    AbortController
  }

  vm.createContext(sandbox)
  // Changes the mocks before background.js reads them at start-up.
  if (prepare) prepare(chromeMock)

  // Separate source filenames keep V8 coverage aligned with the real files.
  for (const [source, filename] of [
    [utilsScriptContent, utilsScriptPath],
    [itemsScriptContent, itemsScriptPath],
    [settingsScriptContent, path.join(__dirname, '..', 'settings.js')],
    [bgScriptContent, bgScriptPath]
  ])
    vm.runInContext(source, sandbox, { filename })

  const scriptContent = `\n
    globalThis.test_stateReadyPromise = stateReadyPromise;
    globalThis.test_state = () => state;
    globalThis.test_updateState = updateState;
    globalThis.test_addLog = addLog;
    globalThis.test_trimLog = trimLog;
    globalThis.test_MAX_LOG_LINES = MAX_LOG_LINES;
    globalThis.test_LOG_BUFFER = LOG_BUFFER;
    globalThis.test_buildBatchRequest = buildBatchRequest;
    globalThis.test_callBatchExecute = callBatchExecute;
    globalThis.test_burstDelayMs = burstDelayMs;
    globalThis.test_postBatchExecute = postBatchExecute;
    globalThis.test_takeRunBudget = takeRunBudget;
    globalThis.test_accountRunState = () => ({ accountPauses, stoppedAccounts, accountRateLimits });
    globalThis.test_settings = () => settings;
    globalThis.test_julesApi = () => julesApi;
    globalThis.test_readJulesBundle = readJulesBundle;
    globalThis.test_rediscoverJulesApi = rediscoverJulesApi;
    globalThis.test_API_REDISCOVER_ALARM = API_REDISCOVER_ALARM;
    globalThis.test_settingsReady = () => settingsReadyPromise;
    globalThis.test_runInPool = runInPool;
    globalThis.test_createLimiter = createLimiter;
    globalThis.test_archiveTasksWithRetry = archiveTasksWithRetry;
    globalThis.test_withRetry = withRetry;
    globalThis.test_isRetryable = isRetryable;
    globalThis.test_RETRY_ATTEMPTS = RETRY_ATTEMPTS;
    globalThis.test_RETRY_BASE_MS = RETRY_BASE_MS;
    globalThis.test_fixJsonControlChars = fixJsonControlChars;
    globalThis.test_findJsonEnd = findJsonEnd;
    globalThis.test_parseResponse = parseResponse;
    globalThis.test_parseTask = parseTask;
    globalThis.test_groupTasksByRepo = groupTasksByRepo;
    globalThis.test_TASK = TASK;
    globalThis.test_JULES_ORIGIN = JULES_ORIGIN;
    globalThis.test_getJulesTabs = getJulesTabs;
    globalThis.test_extractAccountNum = extractAccountNum;
    globalThis.test_getTabLabel = getTabLabel;
    globalThis.test_getOpenPRs = getOpenPRs;
    globalThis.test_executeArchive = executeArchive;
    globalThis.test_getStartConfig = getStartConfig;
    globalThis.test_prCache = prCache;
    globalThis.test_jFetch = jFetch;
    globalThis.test_taskHasOpenPR = taskHasOpenPR;
    globalThis.test_parseSuggestion = parseSuggestion;
    globalThis.test_buildSuggestionPrompt = buildSuggestionPrompt;
    globalThis.test_buildStartPayload = buildStartPayload;
    globalThis.test_SUGGESTION = SUGGESTION;
    globalThis.test_SDETAIL = SDETAIL;
    globalThis.test_createRoleConfig = createRoleConfig;
    globalThis.test_SECURITY_CONFIG = SECURITY_CONFIG;
    globalThis.test_PERFORMANCE_CONFIG = PERFORMANCE_CONFIG;
    globalThis.test_CLEANUP_CONFIG = CLEANUP_CONFIG;
    globalThis.test_TESTING_CONFIG = TESTING_CONFIG;
    globalThis.test_CATEGORY_CONFIG = CATEGORY_CONFIG;
    globalThis.test_DEFAULT_CATEGORY = DEFAULT_CATEGORY;
    globalThis.test_initOperationState = initOperationState;
    globalThis.test_discoverTabs = discoverTabs;
    globalThis.test_processAllTabs = processAllTabs;
    globalThis.test_finalizeOperation = finalizeOperation;
    globalThis.test_handleOperationError = handleOperationError;
    globalThis.test_listTasks = listTasks;
    globalThis.test_safeListTasks = safeListTasks;
    globalThis.test_safeListSources = safeListSources;
    globalThis.test_startOperation = startOperation;
    globalThis.test_startSuggestion = startSuggestion;
    globalThis.test_startKeepAlive = startKeepAlive;
    globalThis.test_stopKeepAlive = stopKeepAlive;
    globalThis.test_getKeepAliveInterval = () => keepAliveInterval;
    globalThis.test_listSuggestions = listSuggestions;
    globalThis.test_listSuggestionEnabledSources = listSuggestionEnabledSources;
    globalThis.test_isSuggestionEnabled = isSuggestionEnabled;
    globalThis.test_getDailySessionQuota = getDailySessionQuota;
    globalThis.test_ensureContentScript = ensureContentScript;
    globalThis.test_getTabConfig = getTabConfig;
    globalThis.test_normalizeSchedule = normalizeSchedule;
    globalThis.test_getScheduleConfig = getScheduleConfig;
    globalThis.test_syncScheduleAlarm = syncScheduleAlarm;
    globalThis.test_runScheduledTick = runScheduledTick;
    globalThis.test_processSuggestionsForTab = processSuggestionsForTab;
    globalThis.test_SCHEDULE_ALARM_NAME = SCHEDULE_ALARM_NAME;
    globalThis.test_DEFAULT_SCHEDULE = DEFAULT_SCHEDULE;
    globalThis.test_RJA83D = RJA83D;
    globalThis.test_TASK_STATES = TASK_STATES;
    globalThis.test_INTERACT_EXPERIMENT_IDS = INTERACT_EXPERIMENT_IDS;
    globalThis.test_DEFAULT_CONTINUE_MESSAGE = DEFAULT_CONTINUE_MESSAGE;
    globalThis.test_DEFAULT_ERROR_CONTINUE_MESSAGE = DEFAULT_ERROR_CONTINUE_MESSAGE;
    globalThis.test_MAX_MESSAGE_LEN = MAX_MESSAGE_LEN;
  `

  const script = new vm.Script(scriptContent, { filename: path.join(__dirname, 'background-hooks.js') })
  script.runInContext(sandbox)
  // Pacing waits 0.5-2 s per burst request; tests that check it put it back.
  sandbox.burstDelayMs = () => 0

  return {
    sandbox,
    sessionSetData,
    alarmsStore,
    alarmListeners,
    messageListeners,
    storageChangeListeners,
    getSyncStorage: () => syncStorage
  }
}

// =============================================================================
// Task Operations Tests
// =============================================================================

describe('listTasks', () => {
  it('should return an empty array when callBatchExecute returns null', async () => {
    const { sandbox } = setupEnvironment()
    // Override the internal callBatchExecute with a mock that returns null
    sandbox.callBatchExecute = async () => null

    const tasks = await sandbox.test_listTasks('filter', {})
    assert.strictEqual(JSON.stringify(tasks), '[]')
  })

  it('should return an empty array when callBatchExecute returns an empty array', async () => {
    const { sandbox } = setupEnvironment()
    // Override the internal callBatchExecute with a mock that returns []
    sandbox.callBatchExecute = async () => []

    const tasks = await sandbox.test_listTasks('filter', {})
    assert.strictEqual(JSON.stringify(tasks), '[]')
  })
})

// =============================================================================
// batchexecute Client Tests
// =============================================================================

describe('buildBatchRequest', () => {
  it('should format correct URL and body', () => {
    const { sandbox } = setupEnvironment()
    const config = { bl: 'build-label', fsid: '123456', at: 'xsrf-token', accountNum: '3' }
    const result = sandbox.test_buildBatchRequest('Tjmm5c', [['task-id'], 1], config)

    assert.ok(result.url.includes('jules.google.com/u/3/_/Swebot/data/batchexecute'))
    assert.ok(result.url.includes('rpcids=Tjmm5c'))
    assert.ok(result.url.includes('bl=build-label'))
    assert.ok(result.url.includes('f.sid=123456'))
    assert.ok(result.url.includes('rt=c'))
    assert.ok(result.body.includes('at=xsrf-token'))
    assert.ok(result.body.includes('Tjmm5c'))
  })
})

// =============================================================================
// Response Parser Tests
// =============================================================================

describe('fixJsonControlChars', () => {
  it('should escape CR/LF inside JSON strings', () => {
    const { sandbox } = setupEnvironment()
    const input = '["hello\r\nworld"]'
    const fixed = sandbox.test_fixJsonControlChars(input)
    assert.strictEqual(fixed, '["hello\\r\\nworld"]')
  })

  it('should not modify CR/LF outside strings', () => {
    const { sandbox } = setupEnvironment()
    const input = '[\n"hello",\n"world"\n]'
    const fixed = sandbox.test_fixJsonControlChars(input)
    assert.strictEqual(fixed, '[\n"hello",\n"world"\n]')
  })

  it('should handle escaped quotes correctly', () => {
    const { sandbox } = setupEnvironment()
    const input = '["she said \\"hi\\""]'
    const fixed = sandbox.test_fixJsonControlChars(input)
    assert.strictEqual(fixed, '["she said \\"hi\\""]')
  })
})

describe('findJsonEnd', () => {
  it('should find end of balanced array', () => {
    const { sandbox } = setupEnvironment()
    assert.strictEqual(sandbox.test_findJsonEnd('[["a","b"]]extra'), 11)
  })

  it('should handle strings with brackets', () => {
    const { sandbox } = setupEnvironment()
    assert.strictEqual(sandbox.test_findJsonEnd('[["a[b]c"]]'), 11)
  })

  it('should return -1 for unbalanced input', () => {
    const { sandbox } = setupEnvironment()
    assert.strictEqual(sandbox.test_findJsonEnd('[["a"'), -1)
  })

  it('should scan from startPos and return an absolute index', () => {
    const { sandbox } = setupEnvironment()
    // 6-char prefix (byte-length line) followed by the JSON array
    assert.strictEqual(sandbox.test_findJsonEnd('1234\n\n[["a","b"]]tail', 6), 17)
  })

  it('should ignore brackets located before startPos', () => {
    const { sandbox } = setupEnvironment()
    // The leading "]]]" must not corrupt depth counting when skipped
    assert.strictEqual(sandbox.test_findJsonEnd(']]]["x"]', 3), 8)
  })

  it('should treat startPos=0 the same as the default', () => {
    const { sandbox } = setupEnvironment()
    assert.strictEqual(sandbox.test_findJsonEnd('[["a","b"]]extra', 0), 11)
  })
})

describe('runInPool', () => {
  it('should run the worker over every item and preserve order', async () => {
    const { sandbox } = setupEnvironment()
    const results = await sandbox.test_runInPool([1, 2, 3, 4], 2, async (n) => n * 10)
    assert.deepStrictEqual(results, [10, 20, 30, 40])
  })

  it('should never exceed the concurrency limit', async () => {
    const { sandbox } = setupEnvironment()
    let inFlight = 0
    let peak = 0
    const worker = async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
    }
    await sandbox.test_runInPool([1, 2, 3, 4, 5, 6, 7, 8], 3, worker)
    assert.ok(peak <= 3, `peak concurrency ${peak} should not exceed 3`)
    assert.strictEqual(peak, 3, 'pool should saturate the limit')
  })

  it('should return an empty array for empty input', async () => {
    const { sandbox } = setupEnvironment()
    let called = 0
    const results = await sandbox.test_runInPool([], 5, async () => {
      called++
    })
    assert.deepStrictEqual(results, [])
    assert.strictEqual(called, 0)
  })

  it('should handle a limit larger than the item count', async () => {
    const { sandbox } = setupEnvironment()
    const results = await sandbox.test_runInPool([1, 2], 10, async (n) => n + 1)
    assert.deepStrictEqual(results, [2, 3])
  })

  it('should pass the item index to the worker', async () => {
    const { sandbox } = setupEnvironment()
    const results = await sandbox.test_runInPool(['a', 'b', 'c'], 2, async (item, idx) => `${item}${idx}`)
    assert.deepStrictEqual(results, ['a0', 'b1', 'c2'])
  })

  it('should handle limit = 0 by using a minimum concurrency of 1', async () => {
    const { sandbox } = setupEnvironment()
    const results = await sandbox.test_runInPool([1, 2, 3], 0, async (n) => n * 2)
    assert.deepStrictEqual(results, [2, 4, 6])
  })

  it('should handle non-integer limits by rounding down', async () => {
    const { sandbox } = setupEnvironment()
    const results = await sandbox.test_runInPool([1, 2, 3], 2.9, async (n) => n * 2)
    assert.deepStrictEqual(results, [2, 4, 6])
  })

  it('should propagate worker errors', async () => {
    const { sandbox } = setupEnvironment()
    await assert.rejects(
      sandbox.test_runInPool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('worker failed')
        return n
      }),
      { message: 'worker failed' }
    )
  })

  it('should handle NaN limit by using a minimum concurrency of 1', async () => {
    const { sandbox } = setupEnvironment()
    const results = await sandbox.test_runInPool([1, 2, 3], NaN, async (n) => n * 2)
    assert.deepStrictEqual(results, [2, 4, 6])
  })

  it('should handle negative limit by using a minimum concurrency of 1', async () => {
    const { sandbox } = setupEnvironment()
    const results = await sandbox.test_runInPool([1, 2, 3], -5, async (n) => n * 2)
    assert.deepStrictEqual(results, [2, 4, 6])
  })
})

describe('isSuggestionEnabled', () => {
  it('treats toggle value 2 as enabled', () => {
    const { sandbox } = setupEnvironment()
    assert.strictEqual(sandbox.test_isSuggestionEnabled(['id', [[]], [1], [1], 1, [true, true, [2], [true]]]), true)
  })

  it('treats toggle value 1, null block, or missing block as disabled', () => {
    const { sandbox } = setupEnvironment()
    assert.strictEqual(sandbox.test_isSuggestionEnabled(['id', [[]], [1], [1], 1, [true, true, [1], [true]]]), false)
    assert.strictEqual(sandbox.test_isSuggestionEnabled(['id', [[]], [1], [1], 1, [null, null, [1]]]), false)
    assert.strictEqual(sandbox.test_isSuggestionEnabled(['id', [[]], [1], [1], 1]), false)
  })
})

describe('listSuggestionEnabledSources', () => {
  it('returns only github repos whose Suggestions toggle is ON', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.callBatchExecute = async () => [
      [
        ['github/n24q02m/on-a', [[true, 'on-a', 'n24q02m']], [1], [1], 1, [true, true, [2], [true]]],
        ['github/n24q02m/off-toggle', [[true, 'off-toggle', 'n24q02m']], [1], [1], 1, [true, true, [1], [true]]],
        ['github/n24q02m/off-noblock', [[true, 'off-noblock', 'n24q02m']], [1], [1], 1],
        ['github/n24q02m/on-b', [[true, 'on-b', 'n24q02m']], [1], [1], 1, [true, true, [2], [true]]],
        ['not-a-github-source', [[]], [1], [1], 1, [true, true, [2], [true]]],
        [null, [[]], [1], [1], 1, [true, true, [2], [true]]]
      ]
    ]
    const repos = await sandbox.test_listSuggestionEnabledSources({})
    assert.strictEqual(JSON.stringify(repos), JSON.stringify(['github/n24q02m/on-a', 'github/n24q02m/on-b']))
  })

  it('returns [] when the response has no sources', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.callBatchExecute = async () => null
    // JSON.stringify avoids cross-VM Array realm mismatch in deepStrictEqual.
    assert.strictEqual(JSON.stringify(await sandbox.test_listSuggestionEnabledSources({})), '[]')
  })
})

describe('getDailySessionQuota', () => {
  it('parses KQOO7 into used/limit/remaining', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.callBatchExecute = async () => [13, [86400], 100, 1, 2]
    // JSON.stringify avoids cross-VM realm mismatch in deepStrictEqual.
    assert.strictEqual(
      JSON.stringify(await sandbox.test_getDailySessionQuota({})),
      JSON.stringify({ used: 13, limit: 100, remaining: 87 })
    )
  })

  it('clamps remaining at 0 when over the limit', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.callBatchExecute = async () => [268, [86400], 100]
    assert.strictEqual(
      JSON.stringify(await sandbox.test_getDailySessionQuota({})),
      JSON.stringify({ used: 268, limit: 100, remaining: 0 })
    )
  })

  it('returns null for an unrecognised shape', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.callBatchExecute = async () => null
    assert.strictEqual(await sandbox.test_getDailySessionQuota({}), null)
  })
})

describe('createLimiter', () => {
  it('caps concurrency across independent callers and resolves results', async () => {
    const { sandbox } = setupEnvironment()
    const limit = sandbox.test_createLimiter(2)
    let inFlight = 0
    let peak = 0
    const make = (n) => () =>
      new Promise((resolve) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        setTimeout(() => {
          inFlight--
          resolve(n * 2)
        }, 5)
      })
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => limit(make(n))))
    assert.deepStrictEqual(results, [2, 4, 6, 8, 10])
    assert.ok(peak <= 2, `peak ${peak} should not exceed limiter max 2`)
  })
})

describe('Retry Utilities', () => {
  describe('isRetryable', () => {
    it('matches transient errors', () => {
      const { sandbox } = setupEnvironment()
      assert.strictEqual(sandbox.test_isRetryable('HTTP 500'), true)
      assert.strictEqual(sandbox.test_isRetryable('HTTP 502'), true)
      assert.strictEqual(sandbox.test_isRetryable('HTTP 503'), true)
      assert.strictEqual(sandbox.test_isRetryable('HTTP 504'), true)
      assert.strictEqual(sandbox.test_isRetryable('Failed to fetch'), true)
      assert.strictEqual(sandbox.test_isRetryable('NetworkError'), true)
    })

    it('leaves HTTP 429 to the account pause instead of retrying it blindly', () => {
      const { sandbox } = setupEnvironment()
      assert.strictEqual(sandbox.test_isRetryable('batchexecute Tjmm5c failed: HTTP 429'), false)
    })

    it('is case-insensitive', () => {
      const { sandbox } = setupEnvironment()
      assert.strictEqual(sandbox.test_isRetryable('http 503'), true)
      assert.strictEqual(sandbox.test_isRetryable('networkerror'), true)
      assert.strictEqual(sandbox.test_isRetryable('FAILED TO FETCH'), true)
    })

    it('does not match non-retryable errors', () => {
      const { sandbox } = setupEnvironment()
      assert.strictEqual(sandbox.test_isRetryable('HTTP 404'), false)
      assert.strictEqual(sandbox.test_isRetryable('HTTP 400'), false)
      assert.strictEqual(sandbox.test_isRetryable('Security Error'), false)
      assert.strictEqual(sandbox.test_isRetryable('JSON.parse error'), false)
    })

    it('handles edge case inputs', () => {
      const { sandbox } = setupEnvironment()
      assert.strictEqual(sandbox.test_isRetryable(null), false)
      assert.strictEqual(sandbox.test_isRetryable(undefined), false)
      assert.strictEqual(sandbox.test_isRetryable(''), false)
    })
  })

  describe('withRetry', () => {
    it('executes successfully on the first attempt', async () => {
      const { sandbox } = setupEnvironment()
      let calls = 0
      const result = await sandbox.test_withRetry(async () => {
        calls++
        return 'success'
      })
      assert.strictEqual(calls, 1)
      assert.strictEqual(result, 'success')
    })

    it('retries on retryable error and succeeds', async () => {
      const { sandbox } = setupEnvironment()
      let calls = 0
      sandbox.setTimeout = (fn) => fn() // Instant retry
      const result = await sandbox.test_withRetry(async () => {
        calls++
        if (calls === 1) throw new Error('HTTP 503')
        return 'retry-success'
      })
      assert.strictEqual(calls, 2)
      assert.strictEqual(result, 'retry-success')
    })

    it('exhausts all attempts and throws the last error', async () => {
      const { sandbox } = setupEnvironment()
      let calls = 0
      sandbox.setTimeout = (fn) => fn()
      const attempts = sandbox.test_RETRY_ATTEMPTS
      await assert.rejects(
        sandbox.test_withRetry(async () => {
          calls++
          throw new Error(`HTTP 500 attempt ${calls}`)
        }),
        { message: `HTTP 500 attempt ${attempts}` }
      )
      assert.strictEqual(calls, attempts)
    })

    it('throws immediately on non-retryable error', async () => {
      const { sandbox } = setupEnvironment()
      let calls = 0
      sandbox.setTimeout = (fn) => fn()
      await assert.rejects(
        sandbox.test_withRetry(async () => {
          calls++
          throw new Error('HTTP 404')
        }),
        { message: 'HTTP 404' }
      )
      assert.strictEqual(calls, 1)
    })

    it('verifies exponential backoff delay calculation', async () => {
      const { sandbox } = setupEnvironment()
      const delays = []
      sandbox.setTimeout = (fn, ms) => {
        delays.push(ms)
        fn()
      }
      sandbox.Math.random = () => 0.5 // Constant jitter for testing
      const base = sandbox.test_RETRY_BASE_MS

      let calls = 0
      await sandbox.test_withRetry(async () => {
        calls++
        if (calls < 4) throw new Error('HTTP 503')
        return 'ok'
      })

      assert.strictEqual(delays.length, 3)
      // delay = base * 2^attempt + random * 200
      // attempt 0: base * 1 + 100
      // attempt 1: base * 2 + 100
      // attempt 2: base * 4 + 100
      assert.strictEqual(delays[0], base * 1 + 100)
      assert.strictEqual(delays[1], base * 2 + 100)
      assert.strictEqual(delays[2], base * 4 + 100)
    })
  })
})

describe('archiveTasksWithRetry Integration', () => {
  it('retries on a 503 then succeeds', async () => {
    const { sandbox } = setupEnvironment()
    let calls = 0
    sandbox.archiveTasks = async () => {
      calls++
      if (calls === 1) throw new Error('batchexecute Tjmm5c failed: HTTP 503')
    }
    sandbox.setTimeout = (fn) => fn()
    await sandbox.test_archiveTasksWithRetry(['t1'], {})
    assert.strictEqual(calls, 2)
  })

  it('does not retry a non-retryable error', async () => {
    const { sandbox } = setupEnvironment()
    let calls = 0
    sandbox.archiveTasks = async () => {
      calls++
      throw new Error('HTTP 404')
    }
    await assert.rejects(sandbox.test_archiveTasksWithRetry(['t1'], {}), { message: 'HTTP 404' })
    assert.strictEqual(calls, 1)
  })
})
describe('parseResponse', () => {
  it('should extract payload from batchexecute response', () => {
    const { sandbox } = setupEnvironment()
    const response = ')]}\'\n\n100\n[["wrb.fr","p1Takd","[[\\"task1\\",\\"task2\\"]]",null,null,null,"generic"]]'
    const result = sandbox.test_parseResponse(response, 'p1Takd')
    assert.deepStrictEqual(result, [['task1', 'task2']])
  })

  it('should parse correctly when trailing data follows the JSON array', () => {
    const { sandbox } = setupEnvironment()
    // A second chunk (byte-length line + sibling array) must be ignored by the
    // offset-based boundary scan.
    const response = ')]}\'\n\n55\n[["wrb.fr","Tjmm5c","[[\\"ok\\"]]",null,null,null,"generic"]]\n12\n[["di",99]]'
    const result = sandbox.test_parseResponse(response, 'Tjmm5c')
    assert.deepStrictEqual(result, [['ok']])
  })

  it('should throw when the matching entry carries an RPC error code', () => {
    const { sandbox } = setupEnvironment()
    // Shape verified live: a rejected call answers 200 with [code] at index 5
    // and a null payload instead of a JSON string.
    const response = ')]}\'\n\n60\n[["wrb.fr","Tjmm5c",null,null,null,[3],"generic"]]'
    assert.throws(() => sandbox.test_parseResponse(response, 'Tjmm5c'), /RPC Tjmm5c error code \[3\]/)
  })

  it('should return null when the rpcId is not present', () => {
    const { sandbox } = setupEnvironment()
    const response = ')]}\'\n\n40\n[["wrb.fr","p1Takd","[[]]",null,null,null,"generic"]]'
    assert.strictEqual(sandbox.test_parseResponse(response, 'Rja83d'), null)
  })

  it('should throw when newline is missing after byte length', () => {
    const { sandbox } = setupEnvironment()
    const response = ')]}\' 100 [["wrb.fr","p1Takd","[[]]",null,null,null,"generic"]]'
    assert.throws(() => sandbox.test_parseResponse(response, 'p1Takd'), { message: 'Invalid batchexecute response' })
  })

  it('should throw when JSON boundary is not found', () => {
    const { sandbox } = setupEnvironment()
    const response = ')]}\'\n\n100\n[["wrb.fr","p1Takd","[[]]",null,null,null,"generic"'
    assert.throws(() => sandbox.test_parseResponse(response, 'p1Takd'), {
      message: 'Could not find JSON boundary in response'
    })
  })
})

// =============================================================================
// Task Parser Tests
// =============================================================================

describe('parseTask', () => {
  it('should map array indices to named fields', () => {
    const { sandbox } = setupEnvironment()
    const raw = new Array(31).fill(null)
    raw[0] = '12345'
    raw[1] = 'Short title'
    raw[4] = 'github/owner/repo'
    raw[5] = 3
    raw[26] = 'Display Title'

    const task = sandbox.test_parseTask(raw)
    assert.strictEqual(task.id, '12345')
    assert.strictEqual(task.title, 'Display Title')
    assert.strictEqual(task.source, 'github/owner/repo')
    assert.strictEqual(task.repo, 'owner/repo')
    assert.strictEqual(task.owner, 'owner')
    assert.strictEqual(task.repoName, 'repo')
    assert.strictEqual(task.state, 3)
  })

  it('should fallback to short title when display title is null', () => {
    const { sandbox } = setupEnvironment()
    const raw = new Array(31).fill(null)
    raw[0] = '99999'
    raw[1] = 'Fallback title'
    raw[4] = 'github/a/b'
    raw[5] = 9

    const task = sandbox.test_parseTask(raw)
    assert.strictEqual(task.title, 'Fallback title')
  })

  // Jules leaves both titles empty on some tasks and shows the prompt instead.
  it("falls back to the prompt's first line when both titles are empty", () => {
    const { sandbox } = setupEnvironment()
    const raw = new Array(31).fill(null)
    raw[0] = '22222'
    raw[2] = `\n   \n  You are "Bolt" ⚡ - ${'fast '.repeat(40)}\nSecond line`
    const task = sandbox.test_parseTask(raw)
    assert.match(task.title, /^You are "Bolt" ⚡ - fast/)
    assert.strictEqual(task.title.length, 120)
  })

  // Jules shows a Completed task whose row[12] is true as "Ready for review".
  it('reads the ready-for-review flag', () => {
    const { sandbox } = setupEnvironment()
    const raw = new Array(31).fill(null)
    raw[0] = '33333'
    raw[5] = 3
    assert.strictEqual(sandbox.test_parseTask(raw).awaitingReview, false)
    raw[12] = true
    assert.strictEqual(sandbox.test_parseTask(raw).awaitingReview, true)
  })

  it('should handle missing source gracefully', () => {
    const { sandbox } = setupEnvironment()
    const raw = new Array(31).fill(null)
    raw[0] = '11111'

    const task = sandbox.test_parseTask(raw)
    assert.strictEqual(task.repo, '')
    assert.strictEqual(task.owner, '')
    assert.strictEqual(task.title, '(untitled)')
  })

  it('should include statusCode from index 25', () => {
    const { sandbox } = setupEnvironment()
    const raw = new Array(31).fill(null)
    raw[0] = '55555'
    raw[5] = 3
    raw[25] = 6

    const task = sandbox.test_parseTask(raw)
    assert.strictEqual(task.statusCode, 6)
  })
})

describe('processTab archives the chosen item', () => {
  const TAB = { id: 1, url: 'https://jules.google.com/u/0/' }

  function setupArchiveEnv(tasks) {
    const { sandbox } = setupEnvironment()
    sandbox.getTabConfig = async () => ({ at: 'at', bl: 'bl_v1', fsid: 'fsid', accountNum: '0' })
    sandbox.listTasks = async () => tasks
    sandbox.getOpenPRs = async () => []
    const archived = []
    sandbox.archiveTasks = async (ids) => {
      archived.push(...ids)
    }
    return { sandbox, archived }
  }

  const tasks = [
    { id: 'waiting', title: 'T', state: 12, source: 'github/o/r' },
    { id: 'running', title: 'T', state: 2, source: 'github/o/r' },
    { id: 'done', title: 'T', state: 3, source: 'github/o/r' },
    { id: 'done7', title: 'T', state: 7, source: 'github/o/r' },
    { id: 'nostate', title: 'T', state: null, source: 'github/o/r' },
    { id: 'new', title: 'T', state: 99, source: 'github/o/r' }
  ]

  it('archives only the tasks in the chosen state', async () => {
    const { sandbox, archived } = setupArchiveEnv(tasks)
    await sandbox.processTab(TAB, { item: sandbox.resolveItem('Waiting on You (12)'), dryRun: false })
    assert.deepStrictEqual(archived, ['waiting'])
  })

  it('archives every task for All, whatever its state', async () => {
    const { sandbox, archived } = setupArchiveEnv(tasks)
    await sandbox.processTab(TAB, { item: sandbox.resolveItem('All'), dryRun: false })
    assert.deepStrictEqual(archived.sort(), ['done', 'done7', 'new', 'nostate', 'running', 'waiting'])
  })

  it('archives only finished tasks (3, 7 and no state) for Completed', async () => {
    const { sandbox, archived } = setupArchiveEnv(tasks)
    await sandbox.processTab(TAB, { item: sandbox.resolveItem('Completed'), dryRun: false })
    assert.deepStrictEqual(archived.sort(), ['done', 'done7', 'nostate'])
  })

  it('refuses to archive when no item is given', async () => {
    const { sandbox, archived } = setupArchiveEnv(tasks)
    await assert.rejects(sandbox.processTab(TAB, { dryRun: false }), /Archive needs an item/)
    assert.deepStrictEqual(archived, [])
  })

  it('logs how many tasks match the item, per state', async () => {
    const { sandbox } = setupArchiveEnv(tasks)
    await sandbox.processTab(TAB, { item: sandbox.resolveItem('Completed'), dryRun: true })
    const log = sandbox.test_state().log
    assert.ok(log.some((l) => l.includes('6 tasks, 3 match "Completed": 2 Completed (3), 1 Completed (7)')))
  })

  it('skips a task with a matching open PR', async () => {
    const prTask = { id: 'x', title: 'Fix the bug', state: 12, source: 'github/o/r', owner: 'o', repoName: 'r' }
    const { sandbox, archived } = setupArchiveEnv([prTask])
    sandbox.getOpenPRs = async () => [{ title: 'Fix the bug', titleLower: 'fix the bug', branch: 'b' }]
    await sandbox.processTab(TAB, { item: sandbox.resolveItem('All'), dryRun: false })
    assert.deepStrictEqual(archived, [])
  })

  it("skips a repo's tasks when its open PRs can't be read", async () => {
    const prTask = { id: 'x', title: 'Fix the bug', state: 3, source: 'github/o/r', owner: 'o', repoName: 'r' }
    const { sandbox, archived } = setupArchiveEnv([prTask])
    sandbox.getOpenPRs = async () => null
    await sandbox.processTab(TAB, { item: sandbox.resolveItem('Completed'), dryRun: false })
    assert.deepStrictEqual(archived, [])
    const log = sandbox.test_state().log
    assert.ok(log.some((l) => l.includes("SKIP [x] Fix the bug (couldn't check its open PRs)")))
    assert.ok(log.some((l) => l.includes('Nothing to archive: every task was skipped by the open-PR check.')))
  })

  it('Force archives a task even when it has a matching open PR', async () => {
    const prTask = { id: 'x', title: 'Fix the bug', state: 12, source: 'github/o/r', owner: 'o', repoName: 'r' }
    const { sandbox, archived } = setupArchiveEnv([prTask])
    let prChecks = 0
    sandbox.getOpenPRs = async () => {
      prChecks++
      return [{ title: 'Fix the bug', titleLower: 'fix the bug', branch: 'b' }]
    }
    await sandbox.processTab(TAB, { item: sandbox.resolveItem('All'), force: true, dryRun: false })
    assert.deepStrictEqual(archived, ['x'])
    assert.strictEqual(prChecks, 0, 'Force skips the PR lookup entirely')
  })

  it('Force does not widen the chosen item', async () => {
    const { sandbox, archived } = setupArchiveEnv(tasks)
    await sandbox.processTab(TAB, { item: sandbox.resolveItem('Error (4)'), force: true, dryRun: false })
    assert.deepStrictEqual(archived, [])
    assert.ok(sandbox.test_state().log.some((l) => l.includes('Nothing to archive.')))
  })

  it('a dry run lists the tasks and archives nothing', async () => {
    const { sandbox, archived } = setupArchiveEnv(tasks)
    const count = await sandbox.processTab(TAB, { item: sandbox.resolveItem('In Progress (2)'), dryRun: true })
    assert.strictEqual(count, 0)
    assert.deepStrictEqual(archived, [])
    assert.ok(sandbox.test_state().log.some((l) => l.includes('DRY RUN - would archive 1 tasks')))
  })
})

// =============================================================================
// Suggestion Parser Tests
// =============================================================================

// =============================================================================
// Constants + Helpers Tests (#50, #52)
// =============================================================================

describe('JULES_ORIGIN', () => {
  it('should be the Jules base URL', () => {
    const { sandbox } = setupEnvironment()
    assert.strictEqual(sandbox.test_JULES_ORIGIN, 'https://jules.google.com')
  })
})

describe('extractAccountNum', () => {
  it('should extract account number from /u/N paths', () => {
    const { sandbox } = setupEnvironment()
    assert.strictEqual(sandbox.test_extractAccountNum('https://jules.google.com/u/3/session'), '3')
    assert.strictEqual(sandbox.test_extractAccountNum('https://jules.google.com/u/0/repo'), '0')
    assert.strictEqual(sandbox.test_extractAccountNum('https://jules.google.com/u/12/session'), '12')
  })

  it('should return 0 for URLs without /u/N', () => {
    const { sandbox } = setupEnvironment()
    assert.strictEqual(sandbox.test_extractAccountNum('https://jules.google.com/session'), '0')
    assert.strictEqual(sandbox.test_extractAccountNum('https://example.com'), '0')
  })
})

// =============================================================================
// Tab Management Tests (#53)
// =============================================================================

describe('getTabLabel', () => {
  it('should return u/N for account tabs', () => {
    const { sandbox } = setupEnvironment()
    assert.strictEqual(sandbox.test_getTabLabel({ url: 'https://jules.google.com/u/1/session' }), 'u/1')
    assert.strictEqual(sandbox.test_getTabLabel({ url: 'https://jules.google.com/u/4/session?pageId=none' }), 'u/4')
  })

  it('should return default for tabs without account number', () => {
    const { sandbox } = setupEnvironment()
    assert.strictEqual(sandbox.test_getTabLabel({ url: 'https://jules.google.com/session' }), 'default')
  })
})

// =============================================================================
// GitHub PR Check Tests (#54)
// =============================================================================

describe('getOpenPRs', () => {
  it('should return mapped PR titles and branches', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.fetch = async () => ({
      ok: true,
      text: async () =>
        JSON.stringify([
          { title: 'Fix bug', head: { ref: 'fix/bug-123' } },
          { title: 'Add feature', head: { ref: 'feat/feature-456' } }
        ])
    })
    const prs = await sandbox.test_getOpenPRs('owner', 'repo', null)
    assert.strictEqual(prs.length, 2)
    assert.strictEqual(prs[0].title, 'Fix bug')
    assert.strictEqual(prs[0].branch, 'fix/bug-123')
    assert.strictEqual(prs[1].title, 'Add feature')
  })

  it('should return cached value on cache hit', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.fetch = async () => ({
      ok: true,
      text: async () => JSON.stringify([{ title: 'PR1', head: { ref: 'branch1' } }])
    })
    const first = await sandbox.test_getOpenPRs('cacheOwner', 'cacheRepo', null)
    assert.strictEqual(first.length, 1)

    sandbox.fetch = async () => {
      throw new Error('should not be called')
    }
    const second = await sandbox.test_getOpenPRs('cacheOwner', 'cacheRepo', null)
    assert.strictEqual(second.length, 1)
  })

  function githubEnv(replies) {
    const { sandbox } = setupEnvironment()
    const calls = []
    sandbox.jFetch = async (_url, opts) => {
      calls.push(opts.timeout)
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)]
      if (reply instanceof Error) throw reply
      if (reply.status !== 200) throw Object.assign(new Error(`HTTP ${reply.status}`), { status: reply.status })
      return { ok: true, status: 200, json: async () => reply.prs }
    }
    const waits = []
    sandbox.pause = async (ms) => {
      waits.push(ms)
    }
    sandbox.burstDelayMs = () => 1234
    return { sandbox, calls, waits }
  }

  it('gives up on a PR list whose body stops arriving', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.setTimeout = (fn, ms) => setTimeout(fn, ms === 30000 ? 5 : ms)
    sandbox.fetch = async (_url, opts) => {
      const stall = () =>
        new Promise((_r, reject) => {
          opts.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          )
        })
      return { ok: true, status: 200, text: stall, json: stall }
    }
    assert.strictEqual(await sandbox.test_getOpenPRs('slow', 'body', null), null)
  })

  it('retries a 404 once, after a random wait and with one more second to answer', async () => {
    const { sandbox, calls, waits } = githubEnv([{ status: 404 }, { status: 200, prs: [{ title: 'A' }] }])
    await sandbox.test_settingsReady()
    sandbox.test_settings().requestTimeoutSec = 30
    const prs = await sandbox.test_getOpenPRs('o404', 'r404', null)
    assert.strictEqual(prs.length, 1)
    assert.deepStrictEqual(calls, [undefined, 31000])
    assert.deepStrictEqual(waits, [1234])
  })

  it('returns null (unknown) when the 404 repeats', async () => {
    const { sandbox, calls } = githubEnv([{ status: 404 }])
    const prs = await sandbox.test_getOpenPRs('err1', 'err1', null)
    assert.strictEqual(prs, null)
    assert.strictEqual(calls.length, 2)
    assert.ok(sandbox.test_state().log.some((l) => l.includes('Could not check PRs for err1/err1: HTTP 404')))
  })

  it('returns null without a retry on a network error or another status', async () => {
    for (const reply of [new Error('network error'), { status: 500 }, { status: 403 }]) {
      const { sandbox, calls } = githubEnv([reply])
      assert.strictEqual(await sandbox.test_getOpenPRs('err2', 'err2', null), null)
      assert.strictEqual(calls.length, 1)
    }
  })

  it('should encode owner and repo in URL', async () => {
    const { sandbox } = setupEnvironment()
    let capturedUrl = ''
    sandbox.fetch = async (url) => {
      capturedUrl = url
      return { ok: true, json: async () => [] }
    }
    await sandbox.test_getOpenPRs('owner/evil', 'repo name', null)
    assert.ok(capturedUrl.includes('owner%2Fevil'))
    assert.ok(capturedUrl.includes('repo%20name'))
  })

  it('should reject tokens with newlines', async () => {
    const { sandbox } = setupEnvironment()
    let sent = 0
    sandbox.fetch = async () => {
      sent++
      return { ok: true, json: async () => [] }
    }
    const prs = await sandbox.test_getOpenPRs('own5', 'rep5', 'token\r\nEvil: header')
    assert.strictEqual(prs, null, 'no check ran, so the open PRs are unknown')
    assert.strictEqual(sent, 0)
  })

  it('should use Authorization header when token is provided', async () => {
    const { sandbox } = setupEnvironment()
    let capturedHeaders = {}
    sandbox.fetch = async (_url, options) => {
      capturedHeaders = options.headers
      return { ok: true, json: async () => [] }
    }
    await sandbox.test_getOpenPRs('own', 'rep', 'secret-token')
    assert.strictEqual(capturedHeaders.Authorization, 'token secret-token')
  })

  it('should handle prCache correctly (integration check)', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.fetch = async () => ({
      ok: true,
      text: async () => JSON.stringify([{ title: 'PR', head: { ref: 'b' } }])
    })

    // Clear cache first just in case
    sandbox.test_prCache.clear()

    const key = 'own/rep'
    assert.strictEqual(sandbox.test_prCache.has(key), false)

    await sandbox.test_getOpenPRs('own', 'rep', null)

    assert.strictEqual(sandbox.test_prCache.has(key), true)
    const cached = await sandbox.test_prCache.get(key)
    assert.strictEqual(cached.length, 1)
    assert.strictEqual(cached[0].title, 'PR')
  })
  it('returns null (unknown) and logs a warning on invalid input types', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.test_prCache.clear()

    // Test null owner
    let prs = await sandbox.test_getOpenPRs(null, 'repo', null)
    assert.strictEqual(prs, null)
    assert.ok(sandbox.test_state().log.some((msg) => msg.includes('Owner and repo must be strings')))

    // Test undefined repo
    prs = await sandbox.test_getOpenPRs('owner', undefined, null)
    assert.strictEqual(prs, null)

    // Test null repo
    prs = await sandbox.test_getOpenPRs('owner', null, null)
    assert.strictEqual(prs, null)

    // Test number repo
    prs = await sandbox.test_getOpenPRs('owner', 123, null)
    assert.strictEqual(prs, null)

    // Test object owner
    prs = await sandbox.test_getOpenPRs({}, 'repo', null)
    assert.strictEqual(prs, null)
  })
})

describe('taskHasOpenPR', () => {
  it('should match when PR title contains task title', () => {
    const { sandbox } = setupEnvironment()
    const task = { title: 'Fix ReDoS vulnerability' }
    const prs = [
      {
        title: '[SECURITY] Fix ReDoS vulnerability',
        titleLower: '[security] fix redos vulnerability',
        branch: 'fix/redos-123'
      }
    ]
    assert.strictEqual(sandbox.test_taskHasOpenPR(task, prs), true)
  })

  it('should match when task title contains PR title', () => {
    const { sandbox } = setupEnvironment()
    const task = { title: 'Unused return value from loadAllTasks' }
    const prs = [
      {
        title: 'Unused return value from loadAllTasks',
        titleLower: 'unused return value from loadalltasks',
        branch: 'fix-unused-123'
      }
    ]
    assert.strictEqual(sandbox.test_taskHasOpenPR(task, prs), true)
  })

  it('should not match unrelated PR titles', () => {
    const { sandbox } = setupEnvironment()
    const task = { title: 'Fix SQL injection' }
    const prs = [
      { title: 'Add unit tests', titleLower: 'add unit tests', branch: 'test/unit' },
      { title: 'Update README', titleLower: 'update readme', branch: 'docs/readme' }
    ]
    assert.strictEqual(sandbox.test_taskHasOpenPR(task, prs), false)
  })

  it('should return false for empty PR list', () => {
    const { sandbox } = setupEnvironment()
    assert.strictEqual(sandbox.test_taskHasOpenPR({ title: 'Any task' }, []), false)
  })

  it('should return false for untitled tasks', () => {
    const { sandbox } = setupEnvironment()
    const prs = [{ title: 'Some PR', titleLower: 'some pr', branch: 'branch' }]
    assert.strictEqual(sandbox.test_taskHasOpenPR({ title: '(untitled)' }, prs), false)
    assert.strictEqual(sandbox.test_taskHasOpenPR({ title: '' }, prs), false)
  })

  it('should be case-insensitive', () => {
    const { sandbox } = setupEnvironment()
    const task = { title: 'fix REDOS Vulnerability' }
    const prs = [
      {
        title: '[Security] Fix ReDoS vulnerability',
        titleLower: '[security] fix redos vulnerability',
        branch: 'fix-123'
      }
    ]
    assert.strictEqual(sandbox.test_taskHasOpenPR(task, prs), true)
  })
})

// =============================================================================
// Suggestion Parser Tests
// =============================================================================

describe('parseSuggestion', () => {
  it('should parse suggestion from hQP40d response', () => {
    const { sandbox } = setupEnvironment()
    const raw = [
      '8729015370503451291',
      [
        'Potential Regex Denial of Service (ReDoS)',
        'The regex contains nested quantifiers...',
        'https://github.com/n24q02m/better-godot-mcp/blob/...',
        'src/godot/detector.ts',
        18,
        1,
        'The regex can be simplified...',
        'export function parseGodotVersion...',
        'typescript',
        'input-validation',
        3
      ],
      1,
      ['16668581076813822918'],
      3
    ]

    const result = sandbox.test_parseSuggestion(raw)
    assert.strictEqual(result.id, '8729015370503451291')
    assert.strictEqual(result.title, 'Potential Regex Denial of Service (ReDoS)')
    assert.strictEqual(result.description, 'The regex contains nested quantifiers...')
    assert.strictEqual(result.filePath, 'src/godot/detector.ts')
    assert.strictEqual(result.line, 18)
    assert.strictEqual(result.confidence, 1)
    assert.strictEqual(result.rationale, 'The regex can be simplified...')
    assert.strictEqual(result.codeSnippet, 'export function parseGodotVersion...')
    assert.strictEqual(result.language, 'typescript')
    assert.strictEqual(result.categorySlug, 'input-validation')
    assert.strictEqual(result.priority, 3)
    assert.strictEqual(result.status, 1)
    assert.strictEqual(result.categoryTab, 3)
  })

  it('should return null for null input', () => {
    const { sandbox } = setupEnvironment()
    assert.strictEqual(sandbox.test_parseSuggestion(null), null)
  })

  it('should return null for empty array', () => {
    const { sandbox } = setupEnvironment()
    assert.strictEqual(sandbox.test_parseSuggestion([]), null)
  })

  it('should return null when details array is missing', () => {
    const { sandbox } = setupEnvironment()
    assert.strictEqual(sandbox.test_parseSuggestion(['id-123']), null)
  })
})

// =============================================================================
// Prompt Builder Tests
// =============================================================================

describe('buildSuggestionPrompt', () => {
  it('should build security prompt for input-validation category', () => {
    const { sandbox } = setupEnvironment()
    const suggestion = {
      title: 'Potential ReDoS',
      filePath: 'src/detector.ts',
      line: 18,
      language: 'typescript',
      codeSnippet: 'const match = str.match(/regex/)',
      rationale: 'Simplify the regex',
      categorySlug: 'input-validation'
    }

    const prompt = sandbox.test_buildSuggestionPrompt(suggestion)
    assert.ok(prompt.includes('[SECURITY] Security Vulnerability Fix Task'))
    assert.ok(prompt.includes('src/detector.ts:18'))
    assert.ok(prompt.includes('Potential ReDoS'))
    assert.ok(prompt.includes('const match = str.match(/regex/)'))
    assert.ok(prompt.includes('security-focused'))
    assert.ok(prompt.includes('Vulnerable Code'))
  })

  it('should build testing prompt for untested-function category', () => {
    const { sandbox } = setupEnvironment()
    const suggestion = {
      title: 'Untested function: foo',
      filePath: 'src/utils.ts',
      line: 42,
      language: 'typescript',
      codeSnippet: 'export function foo() {}',
      rationale: 'Easy to test',
      categorySlug: 'untested-function'
    }

    const prompt = sandbox.test_buildSuggestionPrompt(suggestion)
    assert.ok(prompt.includes('[TEST] Test Coverage Task'))
    assert.ok(prompt.includes('Untested Code'))
    assert.ok(prompt.includes('testing-focused'))
  })

  it('should build performance prompt for async-io category', () => {
    const { sandbox } = setupEnvironment()
    const suggestion = {
      title: 'Sequential awaits',
      filePath: 'src/api.ts',
      line: 10,
      language: 'typescript',
      codeSnippet: 'await a(); await b()',
      rationale: 'Use Promise.all',
      categorySlug: 'async-io'
    }

    const prompt = sandbox.test_buildSuggestionPrompt(suggestion)
    assert.ok(prompt.includes('[PERF] Performance Optimization Task'))
    assert.ok(prompt.includes('Inefficient Code'))
  })

  it('should build cleanup prompt for dead-code category', () => {
    const { sandbox } = setupEnvironment()
    const suggestion = {
      title: 'Unused import',
      filePath: 'src/main.ts',
      line: 1,
      language: 'typescript',
      codeSnippet: 'import { unused } from "lib"',
      rationale: 'Remove unused',
      categorySlug: 'dead-code'
    }

    const prompt = sandbox.test_buildSuggestionPrompt(suggestion)
    assert.ok(prompt.includes('[CLEANUP] Code Cleanup Task'))
    assert.ok(prompt.includes('Code to Clean'))
  })

  it('should use default config for unknown category', () => {
    const { sandbox } = setupEnvironment()
    const suggestion = {
      title: 'Some issue',
      filePath: 'src/main.ts',
      line: 1,
      language: 'typescript',
      codeSnippet: '// code',
      rationale: 'Fix it',
      categorySlug: 'unknown-category'
    }

    const prompt = sandbox.test_buildSuggestionPrompt(suggestion)
    assert.ok(prompt.includes('[FIX] Code Improvement Task'))
    assert.ok(prompt.includes('engineering-focused'))
  })
})

// =============================================================================
// StartSuggestion Payload Tests
// =============================================================================

describe('buildStartPayload', () => {
  it('should build correct Rja83d payload structure', () => {
    const { sandbox } = setupEnvironment()
    const suggestion = {
      id: 'test-123',
      title: 'Fix bug',
      filePath: 'src/a.ts',
      line: 1,
      language: 'typescript',
      codeSnippet: 'code',
      rationale: 'reason',
      categorySlug: 'dead-code'
    }
    const repo = 'github/owner/repo'
    const config = { modelId: null }
    const startConfig = {
      modelConfig: [null, 'beyond:models/test-model'],
      experimentIds: [12345],
      featureFlags: [['flag1', 1]]
    }

    const payload = sandbox.test_buildStartPayload(suggestion, repo, config, startConfig)

    // payload[0] is the prompt
    assert.ok(payload[0].includes('Fix bug'))
    assert.ok(payload[0].includes('[CLEANUP] Code Cleanup Task'))

    // payload[2] is model config
    assert.strictEqual(payload[2][1], 'beyond:models/test-model')

    // payload[4] is repo
    assert.strictEqual(payload[4], 'github/owner/repo')

    // payload[9] is experiment/suggestion metadata
    assert.deepStrictEqual(payload[9][4], [12345])
    assert.strictEqual(payload[9][11][1], 'test-123')

    // payload[14] = 1 (start flag)
    assert.strictEqual(payload[14], 1)
  })

  it('should use config.modelId over startConfig when available', () => {
    const { sandbox } = setupEnvironment()
    const suggestion = {
      id: 's1',
      title: 'T',
      filePath: 'f',
      line: 1,
      language: 'ts',
      codeSnippet: 'c',
      rationale: 'r',
      categorySlug: 'other'
    }
    const config = { modelId: 'beyond:models/direct-model' }
    const startConfig = { modelConfig: [null, 'beyond:models/fallback-model'] }

    const payload = sandbox.test_buildStartPayload(suggestion, 'repo', config, startConfig)
    assert.strictEqual(payload[2][1], 'beyond:models/direct-model')
  })

  it('should use default feature flags when startConfig is null', () => {
    const { sandbox } = setupEnvironment()
    const suggestion = {
      id: 's1',
      title: 'T',
      filePath: 'f',
      line: 1,
      language: 'ts',
      codeSnippet: 'c',
      rationale: 'r',
      categorySlug: 'other'
    }

    const payload = sandbox.test_buildStartPayload(suggestion, 'repo', {}, null)
    // Should have default feature flags
    const flags = payload[2][10]
    assert.ok(flags.length > 0)
    // Compare via JSON to avoid cross-VM reference issues
    assert.strictEqual(JSON.stringify(flags[0]), JSON.stringify(['enable_bash_session_tool', 1]))
  })
})

describe('startSuggestion', () => {
  it('should call callBatchExecute with the correct RPC ID and payload', async () => {
    const { sandbox } = setupEnvironment()
    let capturedId = null
    let capturedPayload = null
    let capturedConfig = null

    sandbox.callBatchExecute = async (id, payload, config) => {
      capturedId = id
      capturedPayload = payload
      capturedConfig = config
      return { success: true }
    }

    const suggestion = {
      id: 'test-123',
      title: 'Fix bug',
      filePath: 'src/a.ts',
      line: 1,
      language: 'typescript',
      codeSnippet: 'code',
      rationale: 'reason',
      categorySlug: 'dead-code'
    }
    const repo = 'github/owner/repo'
    const config = { modelId: 'test-model' }
    const startConfig = { featureFlags: [] }

    const result = await sandbox.test_startSuggestion(suggestion, repo, config, startConfig)

    assert.strictEqual(capturedId, 'Rja83d')
    assert.deepStrictEqual(result, { success: true })
    assert.strictEqual(capturedConfig, config)

    // Verify payload is what buildStartPayload would produce
    const expectedPayload = sandbox.test_buildStartPayload(suggestion, repo, config, startConfig)
    assert.deepStrictEqual(capturedPayload, expectedPayload)
  })
})

// =============================================================================
// State Management Tests
// =============================================================================

describe('state management', () => {
  it('should initialize cleanly without existing state', async () => {
    const { sandbox } = setupEnvironment({})
    await sandbox.test_stateReadyPromise
    const state = sandbox.test_state()
    assert.strictEqual(state.status, 'idle')
    assert.strictEqual(state.log.length, 0)
  })

  it('should handle interrupted running state', async () => {
    const existingState = { status: 'running', log: ['Started...'] }
    const { sandbox, sessionSetData } = setupEnvironment({ archiveState: existingState })
    await sandbox.test_stateReadyPromise
    await new Promise((resolve) => setTimeout(resolve, 10))

    const state = sandbox.test_state()
    assert.strictEqual(state.status, 'error')
    assert.strictEqual(state.error, 'Operation interrupted (browser killed service worker)')
    assert.strictEqual(sessionSetData.length, 1)
  })

  it('should persist state on update', async () => {
    const { sandbox, sessionSetData } = setupEnvironment({})
    await sandbox.test_stateReadyPromise
    await new Promise((resolve) => setTimeout(resolve, 10))
    sessionSetData.length = 0

    sandbox.test_updateState({ status: 'done', currentTab: 'u/0' })
    assert.strictEqual(sandbox.test_state().status, 'done')
    assert.strictEqual(sessionSetData.length, 1)
  })

  it('should add log messages and persist state (coalesced)', async () => {
    const { sandbox, sessionSetData } = setupEnvironment({})
    await sandbox.test_stateReadyPromise
    await new Promise((resolve) => setTimeout(resolve, 10))
    sessionSetData.length = 0

    sandbox.test_addLog('Processing task 1')
    const state = sandbox.test_state()
    // In-memory state updates immediately...
    assert.strictEqual(state.log.length, 1)
    assert.strictEqual(state.log[0], 'Processing task 1')
    // ...but the storage write is coalesced into a deferred flush.
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.strictEqual(sessionSetData.length, 1)
    // Use JSON.stringify to avoid cross-VM reference issues with deepStrictEqual
    assert.strictEqual(JSON.stringify(sessionSetData[0].archiveState.log), JSON.stringify(['Processing task 1']))
  })

  it('caps the retained log at MAX_LOG_LINES, dropping the oldest lines', () => {
    const { sandbox } = setupEnvironment({})
    for (let i = 0; i < 2501; i++) sandbox.test_addLog(`line ${i}`)
    const log = sandbox.test_state().log
    assert.strictEqual(log.length, 2000)
    assert.strictEqual(log[log.length - 1], 'line 2500')
    assert.strictEqual(log[0], 'line 501') // oldest 501 lines dropped
  })

  it('coalesces a storm of log writes into a single storage write', async () => {
    const { sandbox, sessionSetData } = setupEnvironment({})
    await sandbox.test_stateReadyPromise
    await new Promise((resolve) => setTimeout(resolve, 10))
    sessionSetData.length = 0

    for (let i = 0; i < 500; i++) sandbox.test_addLog(`line ${i}`)
    // No synchronous write-per-line storm (the O(n^2) freeze).
    assert.strictEqual(sessionSetData.length, 0)
    await new Promise((resolve) => setTimeout(resolve, 200))
    // 500 rapid log lines collapse into one deferred flush.
    assert.strictEqual(sessionSetData.length, 1)
    assert.strictEqual(sessionSetData[0].archiveState.log.length, 500)
  })
})

// =============================================================================
// Tab Label Parsing & Management Tests
// =============================================================================

describe('extractAccountNum', () => {
  it('should extract account number from /u/X/ format', () => {
    const { sandbox } = setupEnvironment()
    assert.strictEqual(sandbox.test_extractAccountNum('https://jules.google.com/u/1/session'), '1')
    assert.strictEqual(sandbox.test_extractAccountNum('https://jules.google.com/u/123/tasks'), '123')
  })

  it('should return "0" for URLs without /u/X/ segment', () => {
    const { sandbox } = setupEnvironment()
    assert.strictEqual(sandbox.test_extractAccountNum('https://jules.google.com/tasks'), '0')
    assert.strictEqual(sandbox.test_extractAccountNum('https://google.com'), '0')
    assert.strictEqual(sandbox.test_extractAccountNum(''), '0')
  })

  it('should handle null, undefined, and malformed URLs gracefully', () => {
    const { sandbox } = setupEnvironment()
    assert.strictEqual(sandbox.test_extractAccountNum(null), '0')
    assert.strictEqual(sandbox.test_extractAccountNum(undefined), '0')
    assert.strictEqual(sandbox.test_extractAccountNum('not-a-url'), '0')
  })
})

describe('getTabLabel', () => {
  it('should return "default" for account 0', () => {
    const { sandbox } = setupEnvironment()
    assert.strictEqual(sandbox.test_getTabLabel({ url: 'https://jules.google.com/u/0/session' }), 'default')
    assert.strictEqual(sandbox.test_getTabLabel({ url: 'https://jules.google.com/tasks' }), 'default')
  })

  it('should return "u/X" for other account numbers', () => {
    const { sandbox } = setupEnvironment()
    assert.strictEqual(sandbox.test_getTabLabel({ url: 'https://jules.google.com/u/1/session' }), 'u/1')
    assert.strictEqual(sandbox.test_getTabLabel({ url: 'https://jules.google.com/u/42/tasks' }), 'u/42')
  })
})

describe('getJulesTabs', () => {
  it('should filter out accounts.google tabs and sort by account number', async () => {
    const { sandbox } = setupEnvironment()
    const mockTabs = [
      { id: 1, url: 'https://jules.google.com/u/2/session' },
      { id: 2, url: 'https://jules.google.com/u/0/session' },
      { id: 3, url: 'https://accounts.google.com/ServiceLogin' },
      { id: 4, url: 'https://jules.google.com/u/1/session' }
    ]
    sandbox.chrome.tabs.query = async () => mockTabs

    const tabs = await sandbox.test_getJulesTabs()
    assert.strictEqual(tabs.length, 3)
    assert.strictEqual(sandbox.test_extractAccountNum(tabs[0].url), '0')
    assert.strictEqual(sandbox.test_extractAccountNum(tabs[1].url), '1')
    assert.strictEqual(sandbox.test_extractAccountNum(tabs[2].url), '2')
  })

  it('should handle tabs without account segments correctly (as 0)', async () => {
    const { sandbox } = setupEnvironment()
    const mockTabs = [
      { id: 1, url: 'https://jules.google.com/u/1/session' },
      { id: 2, url: 'https://jules.google.com/tasks' }
    ]
    sandbox.chrome.tabs.query = async () => mockTabs

    const tabs = await sandbox.test_getJulesTabs()
    assert.strictEqual(tabs.length, 2)
    assert.strictEqual(sandbox.test_extractAccountNum(tabs[0].url), '0')
    assert.strictEqual(sandbox.test_extractAccountNum(tabs[1].url), '1')
  })
})

// =============================================================================
// startOperation Refactor Tests
// =============================================================================

describe('startOperation refactoring', () => {
  it('initOperationState should initialize state correctly', () => {
    const { sandbox } = setupEnvironment()
    const options = { opMode: 'archive', dryRun: false, force: false }
    const isSuggestions = sandbox.test_initOperationState(options)

    assert.strictEqual(isSuggestions, false)
    const state = sandbox.test_state()
    assert.strictEqual(state.status, 'running')
    assert.strictEqual(state.log.length, 2) // Archive mode + v2 API
    assert.ok(state.log[0].includes('ARCHIVE MODE'))
  })

  it('initOperationState should log the batch agent header for agent_batch runs', () => {
    const { sandbox } = setupEnvironment()
    sandbox.test_initOperationState({ opMode: 'agent_batch', dryRun: false, force: false })

    assert.strictEqual(sandbox.test_state().log[0], '=== BATCH AGENT MODE ===')
  })

  it("initOperationState should drop the previous run's exportData", () => {
    const { sandbox } = setupEnvironment()
    sandbox.test_updateState({ status: 'done', exportData: { totalSuggestions: 3, repositories: [] } })
    sandbox.test_initOperationState({ opMode: 'archive', dryRun: false, force: false })

    assert.strictEqual(sandbox.test_state().exportData, null)
  })

  it('discoverTabs should handle no tabs found', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.chrome.tabs.query = async () => []
    const tabs = await sandbox.test_discoverTabs({})

    assert.strictEqual(tabs, null)
    assert.strictEqual(sandbox.test_state().status, 'error')
    assert.strictEqual(sandbox.test_state().error, 'No Jules tabs found')
  })

  // Tabs run in parallel; two tabs on one account would each read the same
  // remaining daily quota and could start twice the limit.
  it('discoverTabs should keep one tab per account', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.chrome.tabs.query = async () => [
      { id: 1, url: 'https://jules.google.com/u/0/session/a' },
      { id: 2, url: 'https://jules.google.com/u/1/' },
      { id: 3, url: 'https://jules.google.com/u/0/repo/x' },
      { id: 4, url: 'https://jules.google.com/tasks' }
    ]
    const tabs = await sandbox.test_discoverTabs({ scope: 'all' })

    assert.deepStrictEqual(
      Array.from(tabs, (t) => t.id),
      [1, 2]
    )
    assert.ok(sandbox.test_state().log.some((l) => l.includes('Skipping 2 duplicate tab(s)')))
  })

  it('discoverTabs should keep the active tab for current scope even when the account has another tab', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.chrome.tabs.query = async () => [
      { id: 1, url: 'https://jules.google.com/u/0/session/a' },
      { id: 3, url: 'https://jules.google.com/u/0/repo/x' }
    ]
    const tabs = await sandbox.test_discoverTabs({ scope: 'current', activeTabId: 3 })

    assert.deepStrictEqual(
      Array.from(tabs, (t) => t.id),
      [3]
    )
  })

  it('discoverTabs should return filtered tabs', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.chrome.tabs.query = async () => [
      { id: 1, url: 'https://jules.google.com/u/0/session' },
      { id: 2, url: 'https://jules.google.com/u/1/session' }
    ]
    const tabs = await sandbox.test_discoverTabs({ scope: 'current', activeTabId: 2 })

    assert.strictEqual(tabs.length, 1)
    assert.strictEqual(tabs[0].id, 2)
  })

  it('finalizeOperation should update status to done and log summary', () => {
    const { sandbox } = setupEnvironment()
    const results = [{ label: 'u/0', count: 5 }]
    sandbox.test_finalizeOperation(results, false)

    const state = sandbox.test_state()
    assert.strictEqual(state.status, 'done')
    assert.deepStrictEqual(state.results, results)
    assert.ok(state.log.some((l) => l.includes('GRAND TOTAL: 5 tasks archived')))
  })

  it('handleOperationError should log error and update status', () => {
    const { sandbox } = setupEnvironment()
    sandbox.test_handleOperationError(new Error('Test error'))

    const state = sandbox.test_state()
    assert.strictEqual(state.status, 'error')
    assert.strictEqual(state.error, 'Test error')
    assert.ok(state.log.some((l) => l.includes('FATAL ERROR: Test error')))
  })

  it('handleOperationError should handle non-Error objects gracefully', () => {
    const { sandbox } = setupEnvironment()
    sandbox.test_handleOperationError('String error message')

    const state = sandbox.test_state()
    assert.strictEqual(state.status, 'error')
    assert.strictEqual(state.error, 'String error message')
    assert.ok(state.log.some((l) => l.includes('FATAL ERROR: String error message')))
  })

  it('startOperation should orchestrate successfully', async () => {
    const { sandbox } = setupEnvironment()
    const options = { action: 'archive', item: 'Completed' }

    // Mock helpers
    sandbox.chrome.tabs.query = async () => [{ id: 1, url: 'https://jules.google.com/u/0/session' }]
    sandbox.processTab = async () => 3

    await sandbox.test_startOperation(options)

    const state = sandbox.test_state()
    assert.strictEqual(state.status, 'done')
    assert.strictEqual(state.results[0].count, 3)
  })
})

// =============================================================================
// jFetch Tests
// =============================================================================

describe('jFetch', () => {
  it('should not mutate original options.headers without token and headers', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.fetch = async () => ({ ok: true })
    const options = {}
    await sandbox.test_jFetch('https://api.github.com/api/test', options)
    assert.deepStrictEqual(options.headers, undefined)
  })

  it('should not mutate original options.headers without token', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.fetch = async () => ({ ok: true })
    const sharedHeaders = { 'X-Custom': '1' }
    const options = { headers: sharedHeaders }
    await sandbox.test_jFetch('https://api.github.com/api/test', options)
    assert.deepStrictEqual(sharedHeaders, { 'X-Custom': '1' })
  })

  it('should not mutate original options.headers', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.fetch = async () => ({ ok: true })
    const sharedHeaders = { 'X-Custom': '1' }
    const options = { token: 'secret', headers: sharedHeaders }
    await sandbox.test_jFetch('https://api.github.com/api/test', options)
    assert.strictEqual(sharedHeaders.Authorization, undefined)
  })

  it('should throw an error for non-OK HTTP responses', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.fetch = async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found'
    })

    await assert.rejects(() => sandbox.test_jFetch('https://jules.google.com/api/test'), {
      name: 'Error',
      message: 'HTTP 404'
    })
  })

  it('should return the response for successful HTTP requests', async () => {
    const { sandbox } = setupEnvironment()
    const mockResponse = { ok: true, status: 200 }
    sandbox.fetch = async () => mockResponse

    const res = await sandbox.test_jFetch('https://jules.google.com/api/test')
    assert.strictEqual(res, mockResponse)
  })

  it('should throw an error for disallowed fetch origins', async () => {
    const { sandbox } = setupEnvironment()

    await assert.rejects(
      () => sandbox.test_jFetch('https://malicious.com/api/test', { headers: { 'X-Test': '1' }, token: '1' }),
      {
        name: 'Error',
        message: 'Security Error: Disallowed fetch origin'
      }
    )
  })

  it('should throw an error if token is not a string', async () => {
    const { sandbox } = setupEnvironment()

    await assert.rejects(() => sandbox.test_jFetch('https://api.github.com/api/test', { token: 123 }), {
      name: 'Error',
      message: 'Token must be a string'
    })
  })

  it('should throw an error if token contains newlines', async () => {
    const { sandbox } = setupEnvironment()

    await assert.rejects(() => sandbox.test_jFetch('https://api.github.com/api/test', { token: 'invalid\ntoken' }), {
      name: 'Error',
      message: 'Invalid token: contains newline'
    })
  })

  it('should include Authorization header when token is provided', async () => {
    const { sandbox } = setupEnvironment()
    let capturedHeaders = null
    sandbox.fetch = async (_url, options) => {
      capturedHeaders = options.headers
      return { ok: true }
    }

    await sandbox.test_jFetch('https://api.github.com/api/test', { token: 'valid-token' })
    assert.strictEqual(capturedHeaders.Authorization, 'token valid-token')
  })

  it('should throw an error for HTTP 500 status code', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.fetch = async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error'
    })

    await assert.rejects(() => sandbox.test_jFetch('https://jules.google.com/api/test'), {
      name: 'Error',
      message: 'HTTP 500'
    })
  })

  it('should throw an error if fetch throws a network error', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.fetch = async () => {
      throw new Error('Network failure')
    }

    await assert.rejects(() => sandbox.test_jFetch('https://jules.google.com/api/test'), {
      name: 'Error',
      message: 'Network failure'
    })
  })

  it('should pass custom options correctly to fetch', async () => {
    const { sandbox } = setupEnvironment()
    let capturedOptions = null
    sandbox.fetch = async (_url, options) => {
      capturedOptions = options
      return { ok: true }
    }

    await sandbox.test_jFetch('https://jules.google.com/api/test', {
      method: 'POST',
      body: 'test-body',
      headers: { 'X-Custom': 'value' }
    })

    assert.strictEqual(capturedOptions.method, 'POST')
    assert.strictEqual(capturedOptions.body, 'test-body')
    assert.strictEqual(capturedOptions.headers['X-Custom'], 'value')
  })
})

// =============================================================================
// KeepAlive Tests
// =============================================================================

describe('KeepAlive', () => {
  it('startKeepAlive should set a 25s interval', () => {
    const { sandbox } = setupEnvironment()
    sandbox.test_startKeepAlive()

    assert.strictEqual(sandbox.test_activeTimers.length, 1)
    assert.strictEqual(sandbox.test_activeTimers[0].ms, 25000)
    assert.ok(sandbox.test_getKeepAliveInterval() !== null)
  })

  it('startKeepAlive should call chrome.runtime.getPlatformInfo periodically', async () => {
    const { sandbox } = setupEnvironment()
    let called = false
    sandbox.chrome.runtime.getPlatformInfo = async () => {
      called = true
    }

    sandbox.test_startKeepAlive()
    // Manually trigger the interval callback
    await sandbox.test_activeTimers[0].fn()
    assert.ok(called)
  })

  it('startKeepAlive should be idempotent', () => {
    const { sandbox } = setupEnvironment()
    sandbox.test_startKeepAlive()
    sandbox.test_startKeepAlive()

    assert.strictEqual(sandbox.test_activeTimers.length, 1)
  })

  it('stopKeepAlive should clear the interval and reset state', () => {
    const { sandbox } = setupEnvironment()
    sandbox.test_startKeepAlive()
    const intervalId = sandbox.test_getKeepAliveInterval()
    assert.ok(intervalId !== null)

    sandbox.test_stopKeepAlive()
    assert.strictEqual(sandbox.test_clearedTimers.length, 1)
    assert.strictEqual(sandbox.test_clearedTimers[0], intervalId)
    assert.strictEqual(sandbox.test_getKeepAliveInterval(), null)
  })
})

describe('callBatchExecute', () => {
  it('should throw error when jFetch fails with HTTP error', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.fetch = async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error'
    })

    const config = { accountNum: '0' }
    await assert.rejects(sandbox.test_callBatchExecute('rpcId', {}, config), {
      message: 'batchexecute rpcId failed: HTTP 500'
    })
  })

  it('should throw error when fetch throws network error', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.fetch = async () => {
      throw new Error('Network Error')
    }

    const config = { accountNum: '0' }
    await assert.rejects(sandbox.test_callBatchExecute('rpcId', {}, config), {
      message: 'batchexecute rpcId failed: Network Error'
    })
  })
})

// =============================================================================
// Suggestion Operations Tests
// =============================================================================

describe('listSuggestions', () => {
  it('should return an empty array if callBatchExecute returns null', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.callBatchExecute = async () => null

    const result = await sandbox.test_listSuggestions('repo', {})
    assert.strictEqual(result.length, 0)
  })

  it('should return an empty array if callBatchExecute returns an empty array', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.callBatchExecute = async () => []

    const result = await sandbox.test_listSuggestions('repo', {})
    assert.strictEqual(result.length, 0)
  })

  it('should return an empty array if callBatchExecute returns [null]', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.callBatchExecute = async () => [null]

    const result = await sandbox.test_listSuggestions('repo', {})
    assert.strictEqual(result.length, 0)
  })

  it('should return an empty array if callBatchExecute returns [[]]', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.callBatchExecute = async () => [[]]

    const result = await sandbox.test_listSuggestions('repo', {})
    assert.strictEqual(result.length, 0)
  })

  it('should return parsed suggestions for valid response data', async () => {
    const { sandbox } = setupEnvironment()
    const mockResponse = [[['s1', ['Title', 'Desc', 'url', 'path', 1, 0.9, 'rat', 'code', 'js', 'slug', 1], 1, [], 0]]]
    sandbox.callBatchExecute = async () => mockResponse

    const result = await sandbox.test_listSuggestions('repo', {})
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0].id, 's1')
    assert.strictEqual(result[0].title, 'Title')
    assert.strictEqual(result[0].confidence, 0.9)
  })

  it('should filter out null/invalid suggestions', async () => {
    const { sandbox } = setupEnvironment()
    const mockResponse = [
      [
        ['s1', ['Title', 'Desc', 'url', 'path', 1, 0.9, 'rat', 'code', 'js', 'slug', 1], 1, [], 0],
        null,
        ['s2', null, 1, [], 0] // parseSuggestion returns null if details is missing
      ]
    ]
    sandbox.callBatchExecute = async () => mockResponse

    const result = await sandbox.test_listSuggestions('repo', {})
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0].id, 's1')
  })
})

describe('getStartConfig', () => {
  it('should return the config object when it exists in session storage', async () => {
    const mockConfig = { modelId: 'test-model', features: ['a', 'b'] }
    const { sandbox } = setupEnvironment({ startConfig: mockConfig })

    const result = await sandbox.test_getStartConfig()
    assert.deepStrictEqual(result, mockConfig)
  })

  it('should return null when no config exists in session storage', async () => {
    const { sandbox } = setupEnvironment({}) // empty storage

    const result = await sandbox.test_getStartConfig()
    assert.strictEqual(result, null)
  })
})

// =============================================================================
// getTabConfig Tests
// =============================================================================

describe('getTabConfig', () => {
  it('should return config and accountNum on success', async () => {
    const { sandbox } = setupEnvironment()
    const result = await sandbox.test_getTabConfig(1)
    assert.strictEqual(result.at, 'token')
    assert.strictEqual(result.bl, 'build')
    assert.strictEqual(result.fsid, '123')
    assert.strictEqual(result.accountNum, '0')
  })

  it('should throw error when "at" property is missing', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.chrome.tabs.sendMessage = async () => ({
      config: { bl: 'build', fsid: '123' },
      accountNum: '0'
    })
    await assert.rejects(sandbox.test_getTabConfig(1), {
      message: 'Could not extract page config (XSRF token missing). Try refreshing the Jules tab.'
    })
  })

  it('should throw security error for invalid accountNum format', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.chrome.tabs.sendMessage = async () => ({
      config: { at: 'token', bl: 'build', fsid: '123' },
      accountNum: 'invalid-123'
    })
    await assert.rejects(sandbox.test_getTabConfig(1), { message: 'Security Error: Invalid account number format' })
  })

  it('should handle missing accountNum by defaulting to "0"', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.chrome.tabs.sendMessage = async () => ({
      config: { at: 'token', bl: 'build', fsid: '123' }
    })
    const result = await sandbox.test_getTabConfig(1)
    assert.strictEqual(result.accountNum, '0')
  })
})

// =============================================================================
// ensureContentScript Tests
// =============================================================================

describe('ensureContentScript', () => {
  it('should return documentId when initial PING succeeds', async () => {
    const { sandbox } = setupEnvironment()
    const tabId = 123
    let messageSent = null

    sandbox.chrome.tabs.sendMessage = async (id, msg, options) => {
      if (msg.action === 'PING') {
        messageSent = { id, msg, options }
        return { ok: true }
      }
      return null
    }

    const docId = await sandbox.test_ensureContentScript(tabId)
    assert.strictEqual(docId, 'doc1')
    assert.strictEqual(messageSent.id, tabId)
    assert.strictEqual(messageSent.msg.action, 'PING')
    assert.strictEqual(messageSent.options.documentId, 'doc1')
  })

  it('should inject script and retry when initial PING fails', async () => {
    const { sandbox } = setupEnvironment()
    const tabId = 123
    let pings = 0
    let scriptInjected = false

    sandbox.chrome.tabs.sendMessage = async () => {
      pings++
      if (pings === 1) throw new Error('Could not establish connection')
      return { ok: true }
    }

    sandbox.chrome.scripting.executeScript = async (opts) => {
      assert.strictEqual(opts.target.tabId, tabId)
      // Use JSON.stringify to avoid cross-VM reference issues with deepStrictEqual
      assert.strictEqual(JSON.stringify(opts.files), JSON.stringify(['content.js']))
      scriptInjected = true
    }

    // Mock setTimeout to resolve immediately
    sandbox.setTimeout = (fn) => {
      fn()
      return 0
    }

    const docId = await sandbox.test_ensureContentScript(tabId)
    assert.strictEqual(docId, 'doc1')
    assert.strictEqual(scriptInjected, true)
    assert.strictEqual(pings, 2)
  })

  it('should throw security error if frame URL is missing', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.chrome.webNavigation.getFrame = async () => ({ url: null, documentId: 'doc1' })

    await assert.rejects(sandbox.test_ensureContentScript(123), {
      message: 'Security Error: Cannot verify tab origin'
    })
  })

  it('should throw security error if origin is invalid', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.chrome.webNavigation.getFrame = async () => ({ url: 'https://example.com', documentId: 'doc1' })

    await assert.rejects(sandbox.test_ensureContentScript(123), {
      message: 'Security Error: Cannot inject script into non-Jules tab'
    })
  })

  it('should throw error if content script fails to initialize within 3s', async () => {
    const { sandbox } = setupEnvironment()
    const tabId = 123
    let now = 1000

    sandbox.chrome.tabs.sendMessage = async () => {
      throw new Error('Still not ready')
    }

    sandbox.Date.now = () => now
    sandbox.setTimeout = (fn) => {
      now += 500 // Advance time by 500ms on each retry (loop has 100ms sleep)
      fn()
      return 0
    }

    await assert.rejects(sandbox.test_ensureContentScript(tabId), {
      message: 'Content script failed to initialize within 3s'
    })
  })
})

describe('groupTasksByRepo Internal', () => {
  it('should correctly group tasks using the internal function', () => {
    const { sandbox } = setupEnvironment()
    const tasks = [
      { id: '1', repo: 'repo-1' },
      { id: '2', repo: 'repo-2' },
      { id: '3', repo: 'repo-1' }
    ]
    const result = sandbox.test_groupTasksByRepo(tasks)
    assert.strictEqual(result.size, 2)
    assert.strictEqual(result.get('repo-1').length, 2)
    assert.strictEqual(result.get('repo-2').length, 1)
  })
})

describe('safeListTasks', () => {
  it('should return tasks when listTasks succeeds with non-empty list', async () => {
    const { sandbox } = setupEnvironment()
    const mockTasks = [
      ['task-1', 'Title 1', null, null, 'github/owner/repo', 2],
      ['task-2', 'Title 2', null, null, 'github/owner/repo2', 4]
    ]
    sandbox.callBatchExecute = async () => [mockTasks]

    const result = await sandbox.test_safeListTasks('test-label', {})
    assert.strictEqual(result.length, 2)
    assert.strictEqual(result[0].id, 'task-1')
    assert.strictEqual(result[1].id, 'task-2')
  })

  it('should return null and log message when listTasks returns an empty array', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.callBatchExecute = async () => [[]]

    const result = await sandbox.test_safeListTasks('test-label', {})
    assert.strictEqual(result, null)
    const state = sandbox.test_state()
    assert.ok(state.log.some((l) => l.includes('[test-label] No tasks found.')))
  })

  it('should return null and log error when listTasks throws', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.callBatchExecute = async () => {
      throw new Error('Network error')
    }

    const result = await sandbox.test_safeListTasks('test-label', {})
    assert.strictEqual(result, null)
    const state = sandbox.test_state()
    assert.ok(state.log.some((l) => l.includes('[test-label] ERROR listing tasks: Network error')))
  })
})

describe('safeListSources', () => {
  it('should return sources when listSuggestionEnabledSources succeeds with non-empty list', async () => {
    const { sandbox } = setupEnvironment()
    const mockSources = [
      ['github/owner/repo', null, null, null, null, [true, true, [2], [true]]],
      ['github/owner/repo2', null, null, null, null, [true, true, [2], [true]]]
    ]
    sandbox.callBatchExecute = async () => [mockSources]

    const result = await sandbox.test_safeListSources('test-label', {})
    assert.strictEqual(result.length, 2)
    assert.strictEqual(JSON.stringify(result), JSON.stringify(['github/owner/repo', 'github/owner/repo2']))
  })

  it('should return null and log message when no repos have Suggestions enabled', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.callBatchExecute = async () => [[]]

    const result = await sandbox.test_safeListSources('test-label', {})
    assert.strictEqual(result, null)
    const state = sandbox.test_state()
    assert.ok(state.log.some((l) => l.includes('[test-label] No repos have Suggestions enabled.')))
  })

  it('should return null and log error when listSuggestionEnabledSources throws', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.callBatchExecute = async () => {
      throw new Error('API error')
    }

    const result = await sandbox.test_safeListSources('test-label', {})
    assert.strictEqual(result, null)
    const state = sandbox.test_state()
    assert.ok(state.log.some((l) => l.includes('[test-label] ERROR listing sources: API error')))
  })
})

describe('trimLog Internal', () => {
  it('should not trim if log length is equal to MAX_LOG_LINES', () => {
    const { sandbox } = setupEnvironment()
    const max = sandbox.test_MAX_LOG_LINES
    const buffer = sandbox.test_LOG_BUFFER
    const state = sandbox.test_state()
    state.log = Array.from({ length: max + buffer }, (_, i) => `line ${i}`)

    sandbox.test_trimLog()

    assert.strictEqual(state.log.length, max + buffer)
    assert.strictEqual(state.log[0], 'line 0')
    assert.strictEqual(state.log[max + buffer - 1], `line ${max + buffer - 1}`)
  })

  it('should trim oldest entries if log length exceeds MAX_LOG_LINES', () => {
    const { sandbox } = setupEnvironment()
    const max = sandbox.test_MAX_LOG_LINES
    const buffer = sandbox.test_LOG_BUFFER
    const state = sandbox.test_state()
    // Create max + buffer + 1 entries
    state.log = Array.from({ length: max + buffer + 1 }, (_, i) => `line ${i}`)

    sandbox.test_trimLog()

    assert.strictEqual(state.log.length, max)
    // Should have removed the first buffer + 1 entries
    assert.strictEqual(state.log[0], `line ${buffer + 1}`)
    assert.strictEqual(state.log[max - 1], `line ${max + buffer}`)
  })
})

describe('Prompt Builder', () => {
  it('createRoleConfig should return a valid config object', () => {
    const { sandbox } = setupEnvironment()
    const icon = '[ICON]'
    const name = 'Name'
    const role = 'role'
    const codeLabel = 'label'

    const config = sandbox.test_createRoleConfig(icon, name, role, codeLabel)

    assert.strictEqual(config.icon, icon)
    assert.strictEqual(config.name, name)
    assert.strictEqual(config.role, role)
    assert.strictEqual(config.codeLabel, codeLabel)
  })

  it('predefined configs should be correctly initialized', () => {
    const { sandbox } = setupEnvironment()

    assert.strictEqual(sandbox.test_SECURITY_CONFIG.icon, '[SECURITY]')
    assert.strictEqual(sandbox.test_PERFORMANCE_CONFIG.icon, '[PERF]')
    assert.strictEqual(sandbox.test_CLEANUP_CONFIG.icon, '[CLEANUP]')
    assert.strictEqual(sandbox.test_TESTING_CONFIG.icon, '[TEST]')
    assert.strictEqual(sandbox.test_DEFAULT_CATEGORY.icon, '[FIX]')
  })

  it('CATEGORY_CONFIG should map categories to correct configs', () => {
    const { sandbox } = setupEnvironment()
    const categoryConfig = sandbox.test_CATEGORY_CONFIG

    assert.strictEqual(categoryConfig['input-validation'], sandbox.test_SECURITY_CONFIG)
    assert.strictEqual(categoryConfig['async-io'], sandbox.test_PERFORMANCE_CONFIG)
    assert.strictEqual(categoryConfig['dead-code'], sandbox.test_CLEANUP_CONFIG)
    assert.strictEqual(categoryConfig['untested-function'], sandbox.test_TESTING_CONFIG)
  })
})

describe('executeArchive', () => {
  it('should batch task IDs and execute archiveTasksWithRetry', async () => {
    const { sandbox } = setupEnvironment()
    const mockTasks = Array.from({ length: 120 }, (_, i) => ({ id: `id-${i}`, repo: 'owner/repo' }))
    const batches = []

    sandbox.archiveTasksWithRetry = async (ids, _config) => {
      batches.push(ids)
    }

    const config = { at: 'token' }
    const grandTotal = await sandbox.test_executeArchive('test-label', mockTasks, config)

    assert.strictEqual(grandTotal, 120)
    assert.strictEqual(batches.length, 3)
    assert.strictEqual(batches[0].length, 50)
    assert.strictEqual(batches[1].length, 50)
    assert.strictEqual(batches[2].length, 20)
    assert.strictEqual(batches[0][0], 'id-0')
    assert.strictEqual(batches[2][19], 'id-119')
  })

  // Live run (2026-10-19): 2 of 147 fifty-id Tjmm5c batches came back with
  // RPC error code [4]; the same ids then archived fine in chunks of 10.
  // These go through the real callBatchExecute/parseResponse path, so the
  // error carries callBatchExecute's "batchexecute Tjmm5c failed:" prefix.
  const RPC_REJECTED = ')]}\'\n\n60\n[["wrb.fr","Tjmm5c",null,null,null,[4],"generic"]]'
  const RPC_OK = ')]}\'\n\n55\n[["wrb.fr","Tjmm5c","[[\\"ok\\"]]",null,null,null,"generic"]]'

  function mockTjmm5c(sandbox, rejects) {
    const calls = []
    sandbox.postBatchExecute = async (_rpcId, payload) => {
      const ids = payload.find(Array.isArray)
      calls.push(ids)
      return { ok: true, status: 200, text: async () => (rejects(ids) ? RPC_REJECTED : RPC_OK) }
    }
    return calls
  }

  it('should retry a batch rejected with an RPC error code in smaller chunks', async () => {
    const { sandbox } = setupEnvironment()
    const mockTasks = Array.from({ length: 60 }, (_, i) => ({ id: `id-${i}`, title: `T${i}`, repo: 'owner/repo' }))
    const calls = mockTjmm5c(sandbox, (ids) => ids.length === 50)

    const grandTotal = await sandbox.test_executeArchive('test-label', mockTasks, { at: 'token' })

    assert.strictEqual(grandTotal, 60)
    assert.strictEqual(sandbox.test_state().progress.archived, 60)
    const retried = calls.filter((ids) => ids.length === 10 && ids[0] !== 'id-50')
    assert.strictEqual(retried.length, 5)
    assert.deepStrictEqual(
      retried.flat().sort(),
      mockTasks
        .slice(0, 50)
        .map((t) => t.id)
        .sort()
    )
  })

  it('should drop only the chunk that still fails after splitting', async () => {
    const { sandbox } = setupEnvironment()
    const mockTasks = Array.from({ length: 50 }, (_, i) => ({ id: `id-${i}`, title: `T${i}`, repo: 'owner/repo' }))
    mockTjmm5c(sandbox, (ids) => ids.length === 50 || ids.includes('id-23'))

    const grandTotal = await sandbox.test_executeArchive('test-label', mockTasks, { at: 'token' })

    assert.strictEqual(grandTotal, 40)
    const log = sandbox.test_state().log
    assert.ok(log.some((l) => l.includes('retrying in chunks of 10')))
    assert.ok(log.some((l) => l.includes('ERROR [test-label] archiving batch:') && l.includes('error code [4]')))
    assert.ok(!log.some((l) => l.includes('[id-23]')), 'the failed chunk must not be logged as archived')
  })

  it('should not split a batch that failed at the HTTP layer', async () => {
    const { sandbox } = setupEnvironment()
    const mockTasks = Array.from({ length: 50 }, (_, i) => ({ id: `id-${i}`, title: `T${i}`, repo: 'owner/repo' }))
    const calls = []
    sandbox.postBatchExecute = async (_rpcId, payload) => {
      calls.push(payload.find(Array.isArray))
      const err = new Error('HTTP 401')
      err.status = 401
      throw err
    }

    const grandTotal = await sandbox.test_executeArchive('test-label', mockTasks, { at: 'token' })

    assert.strictEqual(grandTotal, 0)
    assert.strictEqual(calls.length, 1, 'an auth failure would fail every chunk too')
  })
})

describe('listTasks', () => {
  it('should parse valid list tasks response successfully with pre-allocated array logic', async () => {
    const { sandbox } = setupEnvironment()
    const mockTaskRow1 = [
      1,
      't1',
      null,
      null,
      'github/owner/repo1',
      2,
      0,
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      200,
      'T1 Title'
    ]
    const mockTaskRow2 = [
      2,
      't2',
      null,
      null,
      'github/owner/repo2',
      4,
      0,
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      200,
      'T2 Title'
    ]

    sandbox.callBatchExecute = async () => [[mockTaskRow1, mockTaskRow2]]
    const tasks = await sandbox.test_listTasks('filter', {})

    assert.strictEqual(tasks.length, 2)
    assert.strictEqual(tasks[0].id, 1)
    assert.strictEqual(tasks[0].title, 'T1 Title')
    assert.strictEqual(tasks[0].repo, 'owner/repo1')
    assert.strictEqual(tasks[1].id, 2)
    assert.strictEqual(tasks[1].title, 'T2 Title')
    assert.strictEqual(tasks[1].repo, 'owner/repo2')
  })
})

// =============================================================================
// Scheduling Tests (chrome.alarms)
// =============================================================================

describe('normalizeSchedule', () => {
  it('returns safe defaults for empty/missing storage', () => {
    const { sandbox } = setupEnvironment()
    const cfg = sandbox.test_normalizeSchedule({})
    assert.strictEqual(cfg.schedEnabled, false)
    assert.strictEqual(cfg.schedIntervalMin, 60)
    assert.strictEqual(cfg.schedStartSuggestions, false)
    assert.strictEqual(cfg.schedMaxStarts, 20)
  })

  it('clamps interval and max-starts into bounds', () => {
    const { sandbox } = setupEnvironment()
    const low = sandbox.test_normalizeSchedule({ schedEnabled: true, schedIntervalMin: 0, schedMaxStarts: 0 })
    assert.strictEqual(low.schedIntervalMin, 1)
    assert.strictEqual(low.schedMaxStarts, 1)

    const high = sandbox.test_normalizeSchedule({ schedIntervalMin: 99999, schedMaxStarts: 99999 })
    assert.strictEqual(high.schedIntervalMin, 1440)
    assert.strictEqual(high.schedMaxStarts, 500)
  })

  it('falls back on non-numeric values instead of producing NaN', () => {
    const { sandbox } = setupEnvironment()
    const cfg = sandbox.test_normalizeSchedule({ schedIntervalMin: 'abc', schedMaxStarts: null })
    assert.strictEqual(cfg.schedIntervalMin, 60)
    assert.strictEqual(cfg.schedMaxStarts, 20)
  })

  it('only accepts strict true for toggles', () => {
    const { sandbox } = setupEnvironment()
    const cfg = sandbox.test_normalizeSchedule({ schedEnabled: 'yes', schedStartSuggestions: 1 })
    assert.strictEqual(cfg.schedEnabled, false)
    assert.strictEqual(cfg.schedStartSuggestions, false)
  })
})

describe('getScheduleConfig', () => {
  it('merges persisted values over defaults', async () => {
    const { sandbox } = setupEnvironment({}, { schedEnabled: true, schedIntervalMin: 30 })
    const cfg = await sandbox.test_getScheduleConfig()
    assert.strictEqual(cfg.schedEnabled, true)
    assert.strictEqual(cfg.schedIntervalMin, 30)
    assert.strictEqual(cfg.schedStartSuggestions, false)
    assert.strictEqual(cfg.schedMaxStarts, 20)
  })
})

describe('syncScheduleAlarm', () => {
  it('creates the periodic alarm when enabled', async () => {
    const { sandbox, alarmsStore } = setupEnvironment({}, { schedEnabled: true, schedIntervalMin: 45 })
    // Startup reconciliation is async; let the microtask chain settle.
    await new Promise((r) => setImmediate(r))
    const alarm = alarmsStore.get(sandbox.test_SCHEDULE_ALARM_NAME)
    assert.ok(alarm, 'alarm should exist')
    assert.strictEqual(alarm.periodInMinutes, 45)
    assert.strictEqual(alarm.delayInMinutes, 45)
  })

  it('does not create an alarm when disabled', async () => {
    const { sandbox, alarmsStore } = setupEnvironment()
    await sandbox.test_syncScheduleAlarm()
    assert.strictEqual(alarmsStore.has(sandbox.test_SCHEDULE_ALARM_NAME), false)
  })

  it('clears an existing alarm when toggled off', async () => {
    const { sandbox, alarmsStore, getSyncStorage } = setupEnvironment({}, { schedEnabled: true, schedIntervalMin: 60 })
    await new Promise((r) => setImmediate(r)) // startup reconcile ran async
    assert.ok(alarmsStore.get(sandbox.test_SCHEDULE_ALARM_NAME), 'alarm should exist before toggle-off')
    // Simulate the popup writing schedEnabled=false via chrome.storage.sync.set
    await sandbox.chrome.storage.sync.set({ schedEnabled: false })
    await new Promise((r) => setImmediate(r)) // let the onChanged->sync microtask settle
    assert.strictEqual(alarmsStore.has(sandbox.test_SCHEDULE_ALARM_NAME), false)
    assert.strictEqual(getSyncStorage().schedEnabled, false)
  })

  it('re-creates the alarm when the interval changes', async () => {
    const { sandbox, alarmsStore } = setupEnvironment({}, { schedEnabled: true, schedIntervalMin: 60 })
    await sandbox.chrome.storage.sync.set({ schedIntervalMin: 15 })
    await new Promise((r) => setImmediate(r))
    const alarm = alarmsStore.get(sandbox.test_SCHEDULE_ALARM_NAME)
    assert.strictEqual(alarm.periodInMinutes, 15)
  })

  it('leaves a matching alarm untouched on restart reconcile', async () => {
    const { sandbox, alarmsStore } = setupEnvironment({}, { schedEnabled: true, schedIntervalMin: 60 })
    await new Promise((r) => setImmediate(r)) // startup reconcile ran async
    // Mutate a marker on the stored object — a re-create would overwrite it.
    const original = alarmsStore.get(sandbox.test_SCHEDULE_ALARM_NAME)
    original.marker = 'kept'
    await sandbox.test_syncScheduleAlarm()
    assert.strictEqual(alarmsStore.get(sandbox.test_SCHEDULE_ALARM_NAME).marker, 'kept')
  })
})

describe('runScheduledTick', () => {
  it('does nothing when disabled', async () => {
    const { sandbox } = setupEnvironment()
    await sandbox.test_runScheduledTick()
    assert.strictEqual(sandbox.test_state().status, 'idle')
  })

  it('runs an archive operation (all tabs) when enabled', async () => {
    const { sandbox } = setupEnvironment({}, { schedEnabled: true, schedIntervalMin: 60 })
    await sandbox.test_runScheduledTick()
    // Mock has no Jules tabs -> archive op ends in error state with a clear message.
    const state = sandbox.test_state()
    assert.strictEqual(state.status, 'error')
    assert.strictEqual(state.error, 'No Jules tabs found')
    assert.ok(state.log.some((l) => l.includes('SCHEDULED (chrome.alarms)')))
    assert.ok(state.log.some((l) => l.includes('ARCHIVE MODE')))
  })

  it('also runs a capped suggestions pass when schedStartSuggestions is on', async () => {
    const { sandbox } = setupEnvironment(
      {},
      { schedEnabled: true, schedIntervalMin: 60, schedStartSuggestions: true, schedMaxStarts: 3 }
    )
    await sandbox.test_runScheduledTick()
    const state = sandbox.test_state()
    // Final state comes from the suggestions pass (no tabs -> error), and both
    // banners appear in order in the log.
    const log = state.log.join('\n')
    assert.ok(log.indexOf('ARCHIVE MODE') < log.indexOf('SUGGESTIONS MODE'), 'archive runs before suggestions')
  })

  it('skips the tick while a manual operation is running', async () => {
    const { sandbox } = setupEnvironment({}, { schedEnabled: true })
    sandbox.test_updateState({ status: 'running' })
    const logLenBefore = sandbox.test_state().log.length
    await sandbox.test_runScheduledTick()
    const state = sandbox.test_state()
    assert.strictEqual(state.status, 'running', 'manual run is not clobbered')
    assert.strictEqual(state.log.length, logLenBefore, 'no tick banner is logged on skip')
  })
})

describe('suggestion per-tick cap', () => {
  it('initOperationState converts maxSuggestions into a shared budget', () => {
    const { sandbox } = setupEnvironment()
    const options = { opMode: 'suggestions', maxSuggestions: 7 }
    const isSuggestions = sandbox.test_initOperationState(options)
    assert.strictEqual(isSuggestions, true)
    assert.strictEqual(options._remainingStarts, 7)
  })

  it('leaves budget unset for manual runs without maxSuggestions', () => {
    const { sandbox } = setupEnvironment()
    const options = { opMode: 'suggestions' }
    sandbox.test_initOperationState(options)
    assert.strictEqual(options._remainingStarts, undefined)
  })

  it('processSuggestionsForTab bails early when the budget is spent', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.test_updateState({ status: 'running' })
    const options = { opMode: 'suggestions', _remainingStarts: 0 }
    const tab = { id: 1, url: 'https://jules.google.com/u/0/session' }
    const started = await sandbox.test_processSuggestionsForTab(tab, options)
    assert.strictEqual(started, 0)
    const log = sandbox.test_state().log.join('\n')
    assert.ok(log.includes('cap already spent'))
  })

  it('clamps a negative maxSuggestions to zero budget', () => {
    const { sandbox } = setupEnvironment()
    const options = { opMode: 'suggestions', maxSuggestions: -5 }
    sandbox.test_initOperationState(options)
    assert.strictEqual(options._remainingStarts, 0)
  })
})

describe('alarm listener wiring', () => {
  it('registers an onAlarm listener that ignores foreign alarm names', async () => {
    const { sandbox, alarmListeners } = setupEnvironment({}, { schedEnabled: true })
    assert.strictEqual(alarmListeners.length, 1)
    // Foreign alarm: must not touch state.
    alarmListeners[0]({ name: 'someone-elses-alarm' })
    await new Promise((r) => setImmediate(r))
    assert.strictEqual(sandbox.test_state().status, 'idle')
  })
})

describe('matchesRepoFilter', () => {
  const { sandbox } = setupEnvironment()

  it('matches owner/repo exactly, case-insensitively, with or without the github/ prefix', () => {
    assert.strictEqual(sandbox.matchesRepoFilter('Owner/Plate', 'github/owner/plate'), true)
    assert.strictEqual(sandbox.matchesRepoFilter('owner/plate', 'owner/plate'), true)
    assert.strictEqual(sandbox.matchesRepoFilter('github/owner/plate', 'github/owner/plate'), true)
    assert.strictEqual(sandbox.matchesRepoFilter(' owner/plate ', 'github/owner/plate'), true)
  })

  it('does not treat owner/repo as a substring pattern', () => {
    assert.strictEqual(sandbox.matchesRepoFilter('owner/plate', 'github/owner/plate-docs'), false)
    assert.strictEqual(sandbox.matchesRepoFilter('owner/plate', 'github/other-owner/plate'), false)
    assert.strictEqual(sandbox.matchesRepoFilter('owner/pla', 'github/owner/plate'), false)
  })

  it('matches a bare name against the repo segment only', () => {
    assert.strictEqual(sandbox.matchesRepoFilter('plate', 'github/owner/plate'), true)
    assert.strictEqual(sandbox.matchesRepoFilter('plate', 'github/owner/plate-docs'), false)
    assert.strictEqual(sandbox.matchesRepoFilter('owner', 'github/owner/plate'), false)
  })

  it('checks every candidate and skips empty ones', () => {
    assert.strictEqual(sandbox.matchesRepoFilter('o/r', undefined, '', 'o/r'), true)
    assert.strictEqual(sandbox.matchesRepoFilter('o/r', undefined, ''), false)
  })
})

describe('processTab repository filtering', () => {
  const TAB = { id: 1, url: 'https://jules.google.com/u/0/' }

  function setupArchiveEnv(tasks) {
    const { sandbox } = setupEnvironment()
    sandbox.getTabConfig = async () => ({ at: 'at', bl: 'bl_v1', fsid: 'fsid', accountNum: '0' })
    sandbox.listTasks = async () => tasks
    sandbox.getOpenPRs = async () => []
    const archived = []
    sandbox.archiveTasks = async (ids) => {
      archived.push(...ids)
    }
    return { sandbox, archived }
  }

  it('filters tasks by exact repo name in repoFilter', async () => {
    const tasks = [
      { id: 'a', title: 'T1', state: 12, source: 'github/tommyzed/adventures', repo: 'tommyzed/adventures' },
      { id: 'b', title: 'T2', state: 12, source: 'github/tommyzed/add-to-calendar', repo: 'tommyzed/add-to-calendar' }
    ]
    const { sandbox, archived } = setupArchiveEnv(tasks)
    await sandbox.processTab(TAB, {
      item: sandbox.resolveItem('All'),
      force: true,
      dryRun: false,
      repoFilter: 'tommyzed/adventures'
    })
    assert.deepStrictEqual(archived, ['a'])
  })

  it('matches the repo filter exactly and case-insensitively, never as a substring', async () => {
    const tasks = [
      { id: 'a', title: 'T1', state: 12, source: 'github/tommyzed/adventures', repo: 'tommyzed/adventures' },
      { id: 'b', title: 'T2', state: 12, source: 'github/tommyzed/adventures-2', repo: 'tommyzed/adventures-2' },
      { id: 'c', title: 'T3', state: 12, source: 'github/not-tommyzed/adventures', repo: 'not-tommyzed/adventures' }
    ]
    const { sandbox, archived } = setupArchiveEnv(tasks)
    await sandbox.processTab(TAB, {
      item: sandbox.resolveItem('All'),
      force: true,
      dryRun: false,
      repoFilter: 'TommyZed/Adventures'
    })
    assert.deepStrictEqual(archived, ['a'], 'adventures-2 and not-tommyzed/adventures must not be archived')
  })

  it('does not archive anything for a partial repo name', async () => {
    const tasks = [
      { id: 'b', title: 'T2', state: 12, source: 'github/tommyzed/add-to-calendar', repo: 'tommyzed/add-to-calendar' }
    ]
    const { sandbox, archived } = setupArchiveEnv(tasks)
    const result = await sandbox.processTab(TAB, {
      item: sandbox.resolveItem('All'),
      force: true,
      dryRun: false,
      repoFilter: 'Calendar'
    })
    assert.strictEqual(result, 0)
    assert.deepStrictEqual(archived, [])
  })

  it('returns 0 and logs message if no tasks match repoFilter', async () => {
    const tasks = [
      { id: 'a', title: 'T1', state: 12, source: 'github/tommyzed/adventures', repo: 'tommyzed/adventures' }
    ]
    const { sandbox, archived } = setupArchiveEnv(tasks)
    const result = await sandbox.processTab(TAB, {
      item: sandbox.resolveItem('All'),
      force: true,
      dryRun: false,
      repoFilter: 'other-repo'
    })
    assert.strictEqual(result, 0)
    assert.strictEqual(archived.length, 0)
    const state = sandbox.test_state()
    assert.ok(state.log.some((l) => l.includes('Nothing to archive.')))
  })

  it('keeps the item filter and PR check when a repoFilter is set (no implicit force)', async () => {
    const tasks = [
      { id: 'done', title: 'Finished', state: 12, source: 'github/o/r', repo: 'o/r', owner: 'o', repoName: 'r' },
      { id: 'busy', title: 'Running', state: 1, source: 'github/o/r', repo: 'o/r', owner: 'o', repoName: 'r' },
      { id: 'pr', title: 'Has PR', state: 12, source: 'github/o/r', repo: 'o/r', owner: 'o', repoName: 'r' }
    ]
    const { sandbox, archived } = setupArchiveEnv(tasks)
    sandbox.getOpenPRs = async () => [{ title: 'Has PR', titleLower: 'has pr', branch: 'b' }]
    await sandbox.processTab(TAB, {
      item: sandbox.resolveItem('Waiting on You (12)'),
      force: false,
      dryRun: false,
      repoFilter: 'o/r'
    })
    assert.deepStrictEqual(archived, ['done'], 'running task and task with an open PR must survive')
  })
})

describe('processSuggestionsForTab repository filtering', () => {
  const TAB = { id: 1, url: 'https://jules.google.com/u/0/' }

  function setupSuggestionsEnv(repos) {
    const { sandbox } = setupEnvironment()
    sandbox.getTabConfig = async () => ({ at: 'at', bl: 'bl_v1', fsid: 'fsid', accountNum: '0' })
    sandbox.getStartConfig = async () => ({ modelConfig: [null, 'gemini'], featureFlags: [], experimentIds: [] })
    sandbox.getDailySessionQuota = async () => ({ used: 0, limit: 100, remaining: 100 })
    sandbox.safeListSources = async () => repos

    const queriedRepos = []
    sandbox.listSuggestions = async (repo) => {
      queriedRepos.push(repo)
      return []
    }
    return { sandbox, queriedRepos }
  }

  it('filters suggestions-enabled repos by exact repo name in repoFilter', async () => {
    const repos = ['github/tommyzed/adventures', 'github/tommyzed/add-to-calendar']
    const { sandbox, queriedRepos } = setupSuggestionsEnv(repos)
    await sandbox.processSuggestionsForTab(TAB, { opMode: 'suggestions', repoFilter: 'tommyzed/adventures' })
    assert.deepStrictEqual(queriedRepos, ['github/tommyzed/adventures'])
  })

  it('matches suggestions-enabled repos exactly, not by substring', async () => {
    const repos = ['github/tommyzed/adventures', 'github/tommyzed/adventures-2', 'github/tommyzed/add-to-calendar']
    const { sandbox, queriedRepos } = setupSuggestionsEnv(repos)
    await sandbox.processSuggestionsForTab(TAB, { opMode: 'suggestions', repoFilter: 'Tommyzed/Adventures' })
    assert.deepStrictEqual(queriedRepos, ['github/tommyzed/adventures'])

    queriedRepos.length = 0
    const result = await sandbox.processSuggestionsForTab(TAB, { opMode: 'suggestions', repoFilter: 'Calendar' })
    assert.strictEqual(result, 0)
    assert.deepStrictEqual(queriedRepos, [])
  })

  it('returns 0 and logs message if no repos match repoFilter', async () => {
    const repos = ['github/tommyzed/adventures']
    const { sandbox, queriedRepos } = setupSuggestionsEnv(repos)
    const result = await sandbox.processSuggestionsForTab(TAB, { opMode: 'suggestions', repoFilter: 'other-repo' })
    assert.strictEqual(result, 0)
    assert.strictEqual(queriedRepos.length, 0)
    const state = sandbox.test_state()
    assert.ok(state.log.some((l) => l.includes('No matching repos found. Nothing to do.')))
  })
})

describe('processRemoveSuggestionsForTab', () => {
  const TAB = { id: 1, url: 'https://jules.google.com/u/1/' }

  function setupRemoveEnv(repos, suggestionsMap = {}) {
    const { sandbox } = setupEnvironment()
    sandbox.getTabConfig = async () => ({ at: 'at', bl: 'bl_v1', fsid: 'fsid', accountNum: '0' })
    sandbox.safeListSources = async () => repos

    const queriedRepos = []
    const removedBatchIds = []

    sandbox.listSuggestions = async (repo) => {
      queriedRepos.push(repo)
      return suggestionsMap[repo] || []
    }

    sandbox.dismissSuggestionWithRetry = async (id) => {
      removedBatchIds.push(id)
    }

    return { sandbox, queriedRepos, removedBatchIds }
  }

  it('performs dry run without removing suggestions', async () => {
    const repos = ['github/owner/repo1']
    const suggestionsMap = {
      'github/owner/repo1': [
        { id: 'sug-1', title: 'Fix SQL injection', categorySlug: 'input-validation' },
        { id: 'sug-2', title: 'Optimize loop', categorySlug: 'loop-optimization' }
      ]
    }
    const { sandbox, removedBatchIds } = setupRemoveEnv(repos, suggestionsMap)
    const count = await sandbox.processRemoveSuggestionsForTab(TAB, { opMode: 'remove_suggestions', dryRun: true })

    assert.strictEqual(count, 0)
    assert.strictEqual(removedBatchIds.length, 0)

    const state = sandbox.test_state()
    assert.ok(state.log.some((l) => l.includes('[DRY] Would remove [u/1] Fix SQL injection')))
    assert.ok(state.log.some((l) => l.includes('[DRY] Would remove [u/1] Optimize loop')))
  })

  it('removes each suggestion during a live run', async () => {
    const repos = ['github/owner/repo1']
    const suggestionsMap = {
      'github/owner/repo1': [
        { id: 'sug-1', title: 'Fix SQL injection', categorySlug: 'input-validation' },
        { id: 'sug-2', title: 'Optimize loop', categorySlug: 'loop-optimization' }
      ]
    }
    const { sandbox, removedBatchIds } = setupRemoveEnv(repos, suggestionsMap)
    const count = await sandbox.processRemoveSuggestionsForTab(TAB, { opMode: 'remove_suggestions', dryRun: false })

    assert.strictEqual(count, 2)
    assert.deepStrictEqual(removedBatchIds, ['sug-1', 'sug-2'])

    const state = sandbox.test_state()
    assert.ok(state.log.some((l) => l.includes('Removed [u/1] Fix SQL injection')))
    assert.ok(state.log.some((l) => l.includes('Removed [u/1] Optimize loop')))
    assert.ok(state.log.some((l) => l.includes('TOTAL: 2 suggestions removed')))
  })

  it('filters repos by repoFilter when removing suggestions', async () => {
    const repos = ['github/owner/repo1', 'github/owner/repo2']
    const { sandbox, queriedRepos } = setupRemoveEnv(repos)
    await sandbox.processRemoveSuggestionsForTab(TAB, { opMode: 'remove_suggestions', repoFilter: 'repo2' })

    assert.deepStrictEqual(queriedRepos, ['github/owner/repo2'])
  })

  it('returns 0 if no suggestions found', async () => {
    const repos = ['github/owner/repo1']
    const { sandbox } = setupRemoveEnv(repos, { 'github/owner/repo1': [] })
    const count = await sandbox.processRemoveSuggestionsForTab(TAB, { opMode: 'remove_suggestions', dryRun: false })

    assert.strictEqual(count, 0)
    const state = sandbox.test_state()
    assert.ok(state.log.some((l) => l.includes('TOTAL: 0 suggestions removed')))
  })

  it('formats finalizeOperation summary with "removed" for remove_suggestions mode', () => {
    const { sandbox } = setupEnvironment()
    const results = [{ label: 'u/0', count: 5 }]
    sandbox.finalizeOperation(results, { opMode: 'remove_suggestions' })

    const state = sandbox.test_state()
    assert.ok(state.log.some((l) => l.includes('u/0: 5 removed')))
    assert.ok(state.log.some((l) => l.includes('GRAND TOTAL: 5 suggestions removed')))
  })
})

describe('dismissSuggestion (sc1vFf)', () => {
  it('sends [suggestionId, 2] to sc1vFf', async () => {
    const { sandbox } = setupEnvironment()
    const calls = []
    sandbox.callBatchExecute = async (rpcId, payload) => {
      calls.push({ rpcId, payload })
      return []
    }
    await sandbox.dismissSuggestion('sug-9', { accountNum: '0' })
    assert.deepStrictEqual(JSON.parse(JSON.stringify(calls)), [{ rpcId: 'sc1vFf', payload: ['sug-9', 2] }])
  })
})

describe('processExportSuggestionsForTab', () => {
  const TAB = { id: 1, url: 'https://jules.google.com/u/0/' }

  function setupExportEnv(allRepos, suggestionsMap = {}) {
    const { sandbox } = setupEnvironment()
    sandbox.getTabConfig = async () => ({ at: 'at', bl: 'bl_v1', fsid: 'fsid', accountNum: '0' })
    sandbox.listAllSources = async () => allRepos
    const queriedRepos = []
    sandbox.listSuggestions = async (repo) => {
      queriedRepos.push(repo)
      return suggestionsMap[repo] || []
    }
    const downloads = []
    sandbox.chrome.downloads = {
      download: (opts, cb) => {
        downloads.push(opts)
        cb(1)
      }
    }
    return { sandbox, queriedRepos, downloads }
  }

  it('exports suggestions from every connected repo and saves a JSON file', async () => {
    const { sandbox, queriedRepos, downloads } = setupExportEnv(['github/o/a', 'github/o/b'], {
      'github/o/a': [{ id: 's1', title: 'One' }]
    })
    const count = await sandbox.processExportSuggestionsForTab(TAB, { opMode: 'export_suggestions' })

    assert.strictEqual(count, 1)
    assert.deepStrictEqual(queriedRepos, ['github/o/a', 'github/o/b'])
    const exportData = sandbox.test_state().exportData
    assert.strictEqual(exportData.totalSuggestions, 1)
    assert.strictEqual(exportData.repositories.length, 1)
    assert.strictEqual(exportData.repositories[0].repo, 'github/o/a')
    assert.strictEqual(downloads.length, 1)
    assert.ok(downloads[0].url.startsWith('data:application/json;charset=utf-8,'))
    assert.match(downloads[0].filename, /^jules-suggestions-\d{4}-\d{2}-\d{2}\.json$/)
  })

  it('keeps every account in exportData when several accounts export in one run', async () => {
    const { sandbox, downloads } = setupExportEnv(['github/o/a'], { 'github/o/a': [{ id: 's1', title: 'One' }] })
    await sandbox.processExportSuggestionsForTab(TAB, { opMode: 'export_suggestions' })
    await sandbox.processExportSuggestionsForTab(
      { id: 2, url: 'https://jules.google.com/u/1/' },
      { opMode: 'export_suggestions' }
    )

    const exportData = sandbox.test_state().exportData
    assert.strictEqual(exportData.totalSuggestions, 2)
    assert.strictEqual(exportData.accounts.length, 2)
    assert.strictEqual(exportData.accounts[1].repositories[0].repo, 'github/o/a')
    assert.strictEqual(downloads.length, 2, 'each account still gets its own file')
  })

  it('queries a typed owner/repo directly when it is not among the listed sources', async () => {
    const { sandbox, queriedRepos } = setupExportEnv(['github/o/a'])
    await sandbox.processExportSuggestionsForTab(TAB, { opMode: 'export_suggestions', repoFilter: 'other/repo' })
    assert.deepStrictEqual(queriedRepos, ['github/other/repo'])
  })

  it('rejects a typed repo that is not a plain owner/repo pair', async () => {
    const { sandbox, queriedRepos } = setupExportEnv(['github/o/a'])
    const count = await sandbox.processExportSuggestionsForTab(TAB, {
      opMode: 'export_suggestions',
      repoFilter: 'evil"],[1'
    })
    assert.strictEqual(count, 0)
    assert.deepStrictEqual(queriedRepos, [])
    assert.ok(sandbox.test_state().log.some((l) => l.includes('Invalid repository')))
  })
})

describe('buildBatchAgentPrompt', () => {
  it('keeps the verification step toolchain-neutral', () => {
    const { sandbox } = setupEnvironment()
    const prompt = sandbox.buildBatchAgentPrompt([{ title: 'Fix it', filePath: 'src/a.py', line: 3 }], 'github/o/r')

    assert.ok(!/gradle/i.test(prompt), 'prompt must not assume a Gradle project')
    assert.match(prompt, /this repository's own build, lint and test commands/)
  })
})

describe('processBatchAgentForTab', () => {
  const TAB = { id: 1, url: 'https://jules.google.com/u/0/' }

  function setupBatchEnv(allRepos, suggestionsMap = {}, { enabledRepos = allRepos, remaining = 100 } = {}) {
    const { sandbox } = setupEnvironment()
    sandbox.getTabConfig = async () => ({ at: 'at', bl: 'bl_v1', fsid: 'fsid', accountNum: '0' })
    sandbox.getStartConfig = async () => ({ modelConfig: [null, 'gemini'], featureFlags: [], experimentIds: ['x1'] })
    sandbox.getDailySessionQuota = async () => ({ used: 100 - remaining, limit: 100, remaining })
    sandbox.listAllSources = async () => allRepos
    sandbox.listSuggestionEnabledSources = async () => enabledRepos
    sandbox.listSuggestions = async (repo) => suggestionsMap[repo] || []
    const launches = []
    sandbox.callBatchExecute = async (rpcId, payload) => {
      launches.push({ rpcId, payload })
      return []
    }
    return { sandbox, launches }
  }

  const SUGGESTIONS = {
    'github/o/a': [
      { id: 's1', title: 'First fix', categorySlug: 'dead-code', filePath: 'a.js', line: 1 },
      { id: 's2', title: 'Second fix', categorySlug: 'injection', filePath: 'b.js', line: 2 }
    ]
  }

  it('dry run logs one planned agent per repo and launches nothing', async () => {
    const { sandbox, launches } = setupBatchEnv(['github/o/a', 'github/o/empty'], SUGGESTIONS)
    const count = await sandbox.processBatchAgentForTab(TAB, { opMode: 'agent_batch', dryRun: true })
    assert.strictEqual(count, 0)
    assert.strictEqual(launches.length, 0)
    const log = sandbox.test_state().log
    assert.ok(log.some((l) => l.includes('[DRY] Would launch 1 Master Agent on github/o/a handling all 2 items.')))
    assert.ok(log.some((l) => l.includes('github/o/empty: 0 suggestions. Skipping agent launch.')))
  })

  it('launches one Rja83d session carrying every suggestion of the repo', async () => {
    const { sandbox, launches } = setupBatchEnv(['github/o/a'], SUGGESTIONS)
    const count = await sandbox.processBatchAgentForTab(TAB, { opMode: 'agent_batch', dryRun: false })
    assert.strictEqual(count, 1)
    assert.strictEqual(launches.length, 1)
    const { rpcId, payload } = launches[0]
    assert.strictEqual(rpcId, 'Rja83d')
    assert.strictEqual(payload[sandbox.test_RJA83D.REPO], 'github/o/a')
    const prompt = payload[sandbox.test_RJA83D.PROMPT]
    assert.ok(prompt.includes('First fix') && prompt.includes('Second fix'))
    assert.deepStrictEqual(JSON.parse(JSON.stringify(payload[sandbox.test_RJA83D.METADATA][11])), [null, 's1'])
  })

  it('launches nothing when the daily session quota is exhausted', async () => {
    const { sandbox, launches } = setupBatchEnv(['github/o/a'], SUGGESTIONS, { remaining: 0 })
    const count = await sandbox.processBatchAgentForTab(TAB, { opMode: 'agent_batch', dryRun: false })
    assert.strictEqual(count, 0)
    assert.strictEqual(launches.length, 0)
    assert.ok(sandbox.test_state().log.some((l) => l.includes('Daily limit reached')))
  })

  it('caps launches to the remaining daily quota', async () => {
    const both = { ...SUGGESTIONS, 'github/o/b': [{ id: 's3', title: 'Third fix', filePath: 'c.js', line: 3 }] }
    const { sandbox, launches } = setupBatchEnv(['github/o/a', 'github/o/b'], both, { remaining: 1 })
    const count = await sandbox.processBatchAgentForTab(TAB, { opMode: 'agent_batch', dryRun: false })
    assert.strictEqual(count, 1)
    assert.strictEqual(launches.length, 1)
  })

  it('without a repo filter only targets Suggestions-enabled repos', async () => {
    const both = { ...SUGGESTIONS, 'github/o/off': [{ id: 's9', title: 'Toggle off', filePath: 'z.js', line: 9 }] }
    const { sandbox, launches } = setupBatchEnv(['github/o/a', 'github/o/off'], both, { enabledRepos: ['github/o/a'] })
    await sandbox.processBatchAgentForTab(TAB, { opMode: 'agent_batch', dryRun: false })
    assert.deepStrictEqual(
      launches.map((l) => l.payload[sandbox.test_RJA83D.REPO]),
      ['github/o/a']
    )
  })

  it('an explicitly chosen repo is used even if its Suggestions toggle is off', async () => {
    const both = { ...SUGGESTIONS, 'github/o/off': [{ id: 's9', title: 'Toggle off', filePath: 'z.js', line: 9 }] }
    const { sandbox, launches } = setupBatchEnv(['github/o/a', 'github/o/off'], both, { enabledRepos: ['github/o/a'] })
    await sandbox.processBatchAgentForTab(TAB, { opMode: 'agent_batch', dryRun: false, repoFilter: 'o/off' })
    assert.deepStrictEqual(
      launches.map((l) => l.payload[sandbox.test_RJA83D.REPO]),
      ['github/o/off']
    )
  })

  it('reports launches through state.progress', async () => {
    const { sandbox } = setupBatchEnv(['github/o/a'], SUGGESTIONS)
    await sandbox.processBatchAgentForTab(TAB, { opMode: 'agent_batch', dryRun: false })
    const { progress } = sandbox.test_state()
    assert.strictEqual(progress.total, 1)
    assert.strictEqual(progress.archived, 1)
  })
})

describe('opMode dispatch and run state', () => {
  it('routes each opMode to its per-tab orchestrator', async () => {
    const { sandbox } = setupEnvironment()
    const called = []
    for (const name of [
      'processTab',
      'processSuggestionsForTab',
      'processRemoveSuggestionsForTab',
      'processExportSuggestionsForTab',
      'processBatchAgentForTab'
    ]) {
      sandbox[name] = async () => {
        called.push(name)
        return 1
      }
    }
    const tabs = [{ id: 1, url: 'https://jules.google.com/u/0/' }]
    for (const opMode of ['archive', 'suggestions', 'remove_suggestions', 'export_suggestions', 'agent_batch']) {
      await sandbox.test_processAllTabs(tabs, { opMode })
    }
    assert.deepStrictEqual(called, [
      'processTab',
      'processSuggestionsForTab',
      'processRemoveSuggestionsForTab',
      'processExportSuggestionsForTab',
      'processBatchAgentForTab'
    ])
  })

  it('initOperationState maps __ALL__ to no filter and records the run options', () => {
    const { sandbox } = setupEnvironment()
    const options = { opMode: 'remove_suggestions', dryRun: false, repoFilter: '__ALL__' }
    sandbox.test_initOperationState(options)
    assert.strictEqual(options.repoFilter, '')
    const state = sandbox.test_state()
    assert.strictEqual(state.options.opMode, 'remove_suggestions')
    assert.ok(state.log.includes('=== REMOVE SUGGESTIONS MODE ==='))
  })

  it('getAllSourceNames returns sorted owner/repo names for the repo picker', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.getJulesTabs = async () => [{ id: 7, url: 'https://jules.google.com/u/0/' }]
    sandbox.getTabConfig = async () => ({ at: 'at', bl: 'bl', fsid: 'f', accountNum: '0' })
    sandbox.listAllSources = async () => ['github/z/last', 'github/a/first']
    assert.deepStrictEqual(Array.from(await sandbox.getAllSourceNames()), ['a/first', 'z/last'])
  })

  it('getAllSourceNames merges the repos of every signed-in account', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.chrome.tabs.query = async () => [
      { id: 7, url: 'https://jules.google.com/u/0/' },
      { id: 8, url: 'https://jules.google.com/u/0/repo/x' },
      { id: 9, url: 'https://jules.google.com/u/1/' }
    ]
    sandbox.getTabConfig = async (tabId) => ({ at: 'at', bl: 'bl', fsid: 'f', accountNum: tabId === 9 ? '1' : '0' })
    const queried = []
    sandbox.listAllSources = async (config) => {
      queried.push(config.accountNum)
      return config.accountNum === '1' ? ['github/b/second', 'github/a/first'] : ['github/a/first', 'github/z/last']
    }

    assert.deepStrictEqual(Array.from(await sandbox.getAllSourceNames()), ['a/first', 'b/second', 'z/last'])
    assert.deepStrictEqual(queried.sort(), ['0', '1'], 'one lookup per account, not per tab')
  })

  it('getAllSourceNames keeps the accounts that answered when one fails', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.chrome.tabs.query = async () => [
      { id: 7, url: 'https://jules.google.com/u/0/' },
      { id: 9, url: 'https://jules.google.com/u/1/' }
    ]
    sandbox.getTabConfig = async (tabId) => ({ at: 'at', bl: 'bl', fsid: 'f', accountNum: tabId === 9 ? '1' : '0' })
    sandbox.listAllSources = async (config) => {
      if (config.accountNum === '1') throw new Error('HTTP 401')
      return ['github/a/first']
    }

    assert.deepStrictEqual(Array.from(await sandbox.getAllSourceNames()), ['a/first'])
  })
})

describe('stale XSRF token recovery (HTTP 400)', () => {
  const CONFIG = () => ({ at: 'STALE:1', bl: 'bl_v1', fsid: 'fsid', accountNum: '0' })
  const OK_BODY = (rpcId) => `)]}'\n\n60\n[["wrb.fr","${rpcId}","[[\\"ok\\"]]",null,null,null,"generic"]]`
  // Shape captured live: a rejected token answers 400 with an "er" envelope;
  // when Jules can mint a replacement it is carried as ["xsrf","<token>"].
  const XSRF_BODY = (token) =>
    `)]}'\n\n120\n[["er",null,null,null,null,400,null,null,null,3,[{"48448350":["xsrf","${token}"]}]]]`
  const NO_TOKEN_BODY = `)]}'\n\n60\n[["er",null,null,null,null,400,null,null,null,3]]`

  function scriptedFetch(sandbox, responses) {
    const calls = []
    sandbox.fetch = async (url, opts) => {
      const body = new URLSearchParams(opts.body)
      calls.push({ rpcId: new URL(url).searchParams.get('rpcids'), at: body.get('at') })
      const { status, text } = responses[Math.min(calls.length - 1, responses.length - 1)]
      return { ok: status >= 200 && status < 300, status, text: async () => text }
    }
    return calls
  }

  it('retries once with the fresh token carried in the 400 body', async () => {
    const { sandbox } = setupEnvironment()
    const calls = scriptedFetch(sandbox, [
      { status: 400, text: XSRF_BODY('FRESH:2') },
      { status: 200, text: OK_BODY('p1Takd') }
    ])
    const config = CONFIG()
    const result = await sandbox.test_callBatchExecute('p1Takd', ['', 4], config)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), [['ok']])
    assert.deepStrictEqual(
      calls.map((c) => c.at),
      ['STALE:1', 'FRESH:2']
    )
    assert.strictEqual(config.at, 'FRESH:2', 'later calls in the run reuse the fresh token')
  })

  it('mints a token with a read-only KQOO7 probe when the 400 body carries none', async () => {
    const { sandbox } = setupEnvironment()
    const calls = scriptedFetch(sandbox, [
      { status: 400, text: NO_TOKEN_BODY },
      { status: 400, text: XSRF_BODY('FRESH:3') },
      { status: 200, text: OK_BODY('Tjmm5c') }
    ])
    const config = CONFIG()
    await sandbox.test_callBatchExecute('Tjmm5c', [['t1'], 1], config)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(calls)), [
      { rpcId: 'Tjmm5c', at: 'STALE:1' },
      { rpcId: 'KQOO7', at: '' },
      { rpcId: 'Tjmm5c', at: 'FRESH:3' }
    ])
  })

  it('stops with a sign-in hint when no step brings a working token', async () => {
    const { sandbox } = setupEnvironment()
    const calls = scriptedFetch(sandbox, [{ status: 400, text: XSRF_BODY('FRESH:4') }])
    await assert.rejects(
      sandbox.test_callBatchExecute('p1Takd', ['', 4], CONFIG()),
      /HTTP 400: Jules rejected the sign-in for default\. Open that Jules tab, check you're signed in/
    )
    // The 400 token once, then the mint (which hands back the same token);
    // no tab to read or reload.
    assert.deepStrictEqual(
      calls.map((c) => c.rpcId),
      ['p1Takd', 'p1Takd', 'KQOO7']
    )
  })

  it('does not touch the token on non-400 failures', async () => {
    const { sandbox } = setupEnvironment()
    const calls = scriptedFetch(sandbox, [{ status: 500, text: 'oops' }])
    const config = CONFIG()
    await assert.rejects(sandbox.test_callBatchExecute('p1Takd', ['', 4], config), /HTTP 500/)
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(config.at, 'STALE:1')
  })
})

describe('HTTP 429: pausing the account', () => {
  const OK = ')]}\'\n\n60\n[["wrb.fr","p1Takd","[[\\"ok\\"]]",null,null,null,"generic"]]'
  const config = (accountNum = '0') => ({ at: 'a', bl: 'b', fsid: 'f', accountNum })
  const reply = (status, retryAfter) => ({
    ok: status === 200,
    status,
    headers: { get: (h) => (h === 'retry-after' ? (retryAfter ?? null) : null) },
    text: async () => (status === 200 ? OK : 'slow down')
  })

  function setup(responses) {
    const { sandbox } = setupEnvironment()
    const calls = []
    sandbox.fetch = async (url) => {
      calls.push(new URL(url).pathname.split('/')[3])
      return responses[Math.min(calls.length - 1, responses.length - 1)]
    }
    const waits = []
    sandbox.pause = async (ms) => {
      waits.push(ms)
    }
    const logs = []
    sandbox.addLog = (m) => logs.push(m)
    return { sandbox, calls, waits, logs }
  }

  it('waits out Retry-After, then sends again', async () => {
    const { sandbox, calls, waits, logs } = setup([reply(429, '7'), reply(200)])
    const result = await sandbox.test_callBatchExecute('p1Takd', [], config())
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), [['ok']])
    assert.strictEqual(calls.length, 2)
    assert.strictEqual(waits.length, 1)
    assert.ok(waits[0] > 6000 && waits[0] <= 7000, `waited ${waits[0]} ms`)
    assert.match(logs[0], /\[default\] Jules is rate-limiting this account \(HTTP 429\): pausing its requests for 7 s/)
  })

  it('waits out a 429 on the sign-in mint as well', async () => {
    const bad = (text) => ({ ok: false, status: 400, headers: { get: () => null }, text: async () => text })
    const { sandbox, calls, waits } = setup([
      bad('no token here'),
      reply(429, '3'),
      bad('[["xsrf","FRESH"]]'),
      reply(200)
    ])
    const used = config()
    await sandbox.test_callBatchExecute('p1Takd', [], used)
    assert.strictEqual(calls.length, 4, 'the request, the mint, the mint again, the request again')
    // The clock is frozen, so the retried request also lands inside the pause.
    assert.ok(waits.length > 0, 'the account paused for the 429')
    assert.ok(
      waits.every((ms) => ms > 2000 && ms <= 3000),
      `waited ${waits} ms`
    )
    assert.strictEqual(used.at, 'FRESH')
  })

  it('reads Retry-After as an HTTP date and waits 30 s when Jules gives none', async () => {
    const date = new Date(Date.now() + 12000).toUTCString()
    const a = setup([reply(429, date), reply(200)])
    await a.sandbox.test_callBatchExecute('p1Takd', [], config())
    assert.ok(a.waits[0] > 10000 && a.waits[0] <= 12000, `waited ${a.waits[0]} ms`)

    const b = setup([reply(429), reply(200)])
    await b.sandbox.test_callBatchExecute('p1Takd', [], config())
    assert.ok(b.waits[0] > 29000 && b.waits[0] <= 30000, `waited ${b.waits[0]} ms`)
  })

  it('makes the next request of the same account wait too, but not another account', async () => {
    const { sandbox, waits } = setup([reply(429, '20'), reply(200)])
    await sandbox.test_callBatchExecute('p1Takd', [], config('0'))
    assert.strictEqual(waits.length, 1)
    await sandbox.test_callBatchExecute('p1Takd', [], config('0'))
    assert.strictEqual(waits.length, 2, 'the same account is still paused')
    await sandbox.test_callBatchExecute('p1Takd', [], config('1'))
    assert.strictEqual(waits.length, 2, 'another account goes straight through')
  })

  it('stops the account for the run when Jules asks for more than 5 minutes', async () => {
    const { sandbox, calls, waits } = setup([reply(429, '600'), reply(200)])
    await assert.rejects(
      sandbox.test_callBatchExecute('p1Takd', [], config()),
      /Jules rate-limited default \(asked to wait 600 s\); stopped this account for the run/
    )
    assert.strictEqual(waits.length, 0)
    await assert.rejects(sandbox.test_callBatchExecute('p1Takd', [], config()), /stopped this account for the run/)
    assert.strictEqual(calls.length, 1, 'a stopped account sends nothing more')
  })

  it('keeps a 429 and its Retry-After when the error body stalls', async () => {
    const { sandbox, calls } = setup([])
    sandbox.setTimeout = (fn, ms) => setTimeout(fn, ms === 30000 ? 5 : ms)
    sandbox.fetch = async (url, opts) => {
      calls.push(new URL(url).pathname.split('/')[3])
      return {
        ok: false,
        status: 429,
        headers: { get: (h) => (h === 'retry-after' ? '600' : null) },
        text: () =>
          new Promise((_r, reject) => {
            opts.signal.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            )
          })
      }
    }
    await assert.rejects(sandbox.test_callBatchExecute('p1Takd', [], config()), /stopped this account for the run/)
    assert.strictEqual(calls.length, 1, 'nothing more goes to the account')
  })

  it('pauses the account on the 429 headers, without waiting for its body', async () => {
    const { sandbox, calls } = setup([])
    let bodyReads = 0
    sandbox.fetch = async (url) => {
      calls.push(new URL(url).pathname.split('/')[3])
      return {
        ok: false,
        status: 429,
        headers: { get: (h) => (h === 'retry-after' ? '600' : null) },
        text: () => {
          bodyReads++
          return new Promise(() => {})
        }
      }
    }
    await assert.rejects(sandbox.test_callBatchExecute('p1Takd', [], config()), /stopped this account for the run/)
    assert.strictEqual(bodyReads, 0, 'a 429 body has nothing the run needs')
  })

  it('stops the account after 3 waits in a row', async () => {
    const { sandbox, calls, waits } = setup([reply(429, '1')])
    await assert.rejects(sandbox.test_callBatchExecute('p1Takd', [], config()), /stopped this account for the run/)
    assert.strictEqual(calls.length, 4)
    assert.strictEqual(waits.length, 3)
  })

  it('counts 429s in a row per account, not per request', async () => {
    const { sandbox, calls } = setup([reply(429, '1')])
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => sandbox.test_callBatchExecute('p1Takd', [], config()))
    )
    assert.ok(results.every((r) => r.status === 'rejected' && /stopped this account/.test(r.reason.message)))
    assert.ok(calls.length <= 6, `${calls.length} POSTs; the six went out together, then the account stopped`)
  })

  it('starts the count over after a request gets through', async () => {
    const { sandbox, calls } = setup([reply(429, '1'), reply(429, '1'), reply(429, '1'), reply(200), reply(429, '1')])
    await sandbox.test_callBatchExecute('p1Takd', [], config())
    await assert.rejects(sandbox.test_callBatchExecute('p1Takd', [], config()), /stopped this account/)
    assert.strictEqual(calls.length, 8, 'three 429s and a success, then four 429s')
  })
})

describe('sign-in ladder', () => {
  const OK = (rpcId) => `)]}'\n\n60\n[["wrb.fr","${rpcId}","[[\\"ok\\"]]",null,null,null,"generic"]]`
  const NO_TOKEN = `)]}'\n\n60\n[["er",null,null,null,null,400,null,null,null,3]]`

  // Jules accepts only `goodToken`; every other token answers 400 with no
  // fresh token in the body (so steps 1 and 2 bring nothing).
  function setup({ goodToken, pageTokens, reloadedTokens, reloadTabOnSignIn } = {}) {
    const { sandbox } = setupEnvironment({}, reloadTabOnSignIn === undefined ? {} : { settings: { reloadTabOnSignIn } })
    const calls = []
    sandbox.fetch = async (url, opts) => {
      const at = new URLSearchParams(opts.body).get('at')
      calls.push({ rpcId: new URL(url).searchParams.get('rpcids'), at })
      await new Promise((r) => setTimeout(r, 1))
      return at === goodToken
        ? { ok: true, status: 200, text: async () => OK('p1Takd') }
        : { ok: false, status: 400, text: async () => NO_TOKEN }
    }
    const reads = []
    let reloaded = false
    sandbox.chrome.tabs.sendMessage = async (_tabId, msg) => {
      if (msg.action === 'PING') return { ok: true }
      reads.push(msg)
      return { config: reloaded ? reloadedTokens : pageTokens, accountNum: '0' }
    }
    const reloads = []
    const updated = []
    sandbox.chrome.tabs.onUpdated = {
      addListener: (fn) => updated.push(fn),
      removeListener: (fn) => updated.splice(updated.indexOf(fn), 1)
    }
    sandbox.chrome.tabs.reload = async (tabId) => {
      reloads.push(tabId)
      reloaded = true
      setTimeout(() => {
        for (const fn of [...updated]) fn(tabId, { status: 'complete' })
      }, 1)
    }
    const logs = []
    sandbox.addLog = (m) => logs.push(m)
    return { sandbox, calls, reads, reloads, logs }
  }
  const config = () => ({ at: 'OLD', bl: 'bl1', fsid: 'f1', accountNum: '0', tabId: 5 })

  it('re-reads the tokens from the page, past the cache, before reloading', async () => {
    const { sandbox, calls, reads, reloads } = setup({
      goodToken: 'PAGE',
      pageTokens: { at: 'PAGE', bl: 'bl2', fsid: 'f2' }
    })
    const cfg = config()
    await sandbox.test_settingsReady()
    await sandbox.test_callBatchExecute('p1Takd', [], cfg)
    assert.deepStrictEqual(
      calls.map((c) => `${c.rpcId}:${c.at}`),
      ['p1Takd:OLD', 'KQOO7:', 'p1Takd:PAGE']
    )
    assert.strictEqual(reads.length, 1)
    assert.strictEqual(reads[0].fresh, true, 'the content script is told to skip its cache')
    assert.deepStrictEqual([cfg.at, cfg.bl, cfg.fsid], ['PAGE', 'bl2', 'f2'], 'bl and f.sid are refreshed too')
    assert.strictEqual(reloads.length, 0)
  })

  it("ignores the page's tokens when the tab switched to another account", async () => {
    const { sandbox, calls } = setup({ goodToken: 'OTHER', pageTokens: { at: 'OTHER' }, reloadTabOnSignIn: false })
    sandbox.chrome.tabs.sendMessage = async (_tabId, msg) =>
      msg.action === 'PING' ? { ok: true } : { config: { at: 'OTHER' }, accountNum: '1' }
    await sandbox.test_settingsReady()
    await assert.rejects(sandbox.test_callBatchExecute('p1Takd', [], config()), /Jules rejected the sign-in/)
    assert.ok(!calls.some((c) => c.at === 'OTHER'), 'account 1 tokens never go out for account 0')
  })

  it('reloads the Jules tab when the page still holds the old token', async () => {
    const { sandbox, calls, reloads, logs } = setup({
      goodToken: 'RELOADED',
      pageTokens: { at: 'OLD', bl: 'bl1', fsid: 'f1' },
      reloadedTokens: { at: 'RELOADED', bl: 'bl3', fsid: 'f3' }
    })
    await sandbox.test_settingsReady()
    await sandbox.test_callBatchExecute('p1Takd', [], config())
    assert.deepStrictEqual(reloads, [5])
    assert.strictEqual(calls.at(-1).at, 'RELOADED')
    assert.ok(logs.some((l) => l.includes('trying reloading the Jules tab')))
  })

  it('does not reload a tab that has left Jules or moved to another account', async () => {
    for (const url of ['https://example.com/inbox', 'https://jules.google.com/u/2/session', undefined]) {
      const { sandbox, reloads, logs } = setup({
        goodToken: 'RELOADED',
        pageTokens: { at: 'OLD' },
        reloadedTokens: { at: 'RELOADED' }
      })
      sandbox.chrome.tabs.get = async (id) => ({ id, url })
      await sandbox.test_settingsReady()
      await assert.rejects(sandbox.test_callBatchExecute('p1Takd', [], config()), /Jules rejected the sign-in/)
      assert.deepStrictEqual(reloads, [], `no reload for ${url}`)
      assert.ok(logs.some((l) => l.includes('the tab is no longer on Jules for default')))
    }
  })

  it('does not reload the tab when Settings turned that off', async () => {
    const { sandbox, reloads } = setup({
      goodToken: 'RELOADED',
      pageTokens: { at: 'OLD' },
      reloadedTokens: { at: 'RELOADED' },
      reloadTabOnSignIn: false
    })
    await sandbox.test_settingsReady()
    await assert.rejects(
      sandbox.test_callBatchExecute('p1Takd', [], config()),
      /Jules rejected the sign-in for default/
    )
    assert.deepStrictEqual(reloads, [])
  })

  it('renews once for requests that fail together', async () => {
    const { sandbox, calls, reads, reloads } = setup({
      goodToken: 'RELOADED',
      pageTokens: { at: 'OLD' },
      reloadedTokens: { at: 'RELOADED' }
    })
    await sandbox.test_settingsReady()
    const cfg = config()
    await Promise.all([1, 2, 3].map(() => sandbox.test_callBatchExecute('p1Takd', [], cfg)))
    assert.strictEqual(calls.filter((c) => c.rpcId === 'KQOO7').length, 1, 'one mint')
    assert.strictEqual(reloads.length, 1, 'one reload')
    assert.strictEqual(reads.length, 2, 'one read before and one after the reload')
    assert.strictEqual(calls.filter((c) => c.at === 'RELOADED').length, 3, 'all three go out again')
  })

  it('starts the ladder over after the tokens worked', async () => {
    const { sandbox, calls } = setup({ goodToken: 'PAGE', pageTokens: { at: 'PAGE' } })
    await sandbox.test_settingsReady()
    const cfg = config()
    await sandbox.test_callBatchExecute('p1Takd', [], cfg)
    assert.strictEqual(cfg.signInStep, 0)
    cfg.at = 'EXPIRED'
    await sandbox.test_callBatchExecute('p1Takd', [], cfg)
    assert.deepStrictEqual(
      calls.slice(3).map((c) => `${c.rpcId}:${c.at}`),
      ['p1Takd:EXPIRED', 'KQOO7:', 'p1Takd:PAGE']
    )
  })
})

describe('ListTasks timeout', () => {
  it('gives p1Takd a long timeout (multi-minute, 100MB+ responses on big accounts)', async () => {
    const { sandbox } = setupEnvironment()
    const timeouts = []
    sandbox.jFetch = async (url, opts) => {
      timeouts.push({ rpcId: new URL(url).searchParams.get('rpcids'), timeout: opts.timeout })
      return { ok: true, status: 200, text: async () => ")]}'\n\n4\n[[]]" }
    }
    await sandbox.test_listTasks('', { at: 'a', bl: 'b', fsid: 'f', accountNum: '0' })
    assert.strictEqual(timeouts[0].rpcId, 'p1Takd')
    assert.ok(timeouts[0].timeout >= 180000, `p1Takd timeout was ${timeouts[0].timeout}`)
  })
})

describe('proceed', () => {
  const TAB = { id: 1, url: 'https://jules.google.com/u/1/' }
  const UUID_REGEX = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/

  const task = (id, state, extra = {}) => ({
    id,
    title: `Task ${id}`,
    state,
    source: 'github/o/r',
    repo: 'o/r',
    planId: null,
    ...extra
  })

  // GetTask (n74qPd) returns the session with its activity log at [0][3];
  // the last entry is what the Jules UI threads its reply onto.
  function setupProceedEnv(
    tasks,
    { activities = {}, failInteract = new Set(), quota = [0, [86400], 100], interactError = 'HTTP 500' } = {}
  ) {
    const { sandbox } = setupEnvironment()
    sandbox.getTabConfig = async () => ({ at: 'at', bl: 'bl_v1', fsid: 'fsid', accountNum: '1' })
    sandbox.listTasks = async () => tasks
    const calls = []
    sandbox.callBatchExecute = async (rpcId, payload) => {
      calls.push({ rpcId, payload: JSON.parse(JSON.stringify(payload)) })
      if (rpcId === 'n74qPd') {
        const acts = activities[payload[0]] ?? [
          ['act-old', [1, 0]],
          [`act-last-${payload[0]}`, [2, 0]]
        ]
        return [[payload[0], null, 'prompt', acts]]
      }
      if (rpcId === 'KQOO7') {
        if (quota instanceof Error) throw quota
        return quota
      }
      if (rpcId === 'SLmX6' && failInteract.has(payload[0])) {
        throw new Error(`batchexecute SLmX6 failed: ${interactError}`)
      }
      return []
    }
    const sent = (rpcId) => calls.filter((c) => c.rpcId === rpcId)
    const writes = () => calls.filter((c) => c.rpcId === 'SLmX6' || c.rpcId === 'wk4vKd')
    const log = () => sandbox.test_state().log
    return { sandbox, calls, sent, writes, log }
  }

  describe('planProceed', () => {
    const plan = (sandbox, t, itemText = 'All', options = {}) =>
      JSON.parse(JSON.stringify(sandbox.planProceed(t, sandbox.resolveItem(itemText), options)))

    it('replies to a task waiting on you with the default reply, and appends the message to it', () => {
      const { sandbox } = setupEnvironment()
      const DEFAULT = sandbox.test_DEFAULT_CONTINUE_MESSAGE
      assert.deepStrictEqual(plan(sandbox, task('a', 12)), { action: 'reply', message: DEFAULT })
      assert.strictEqual(
        plan(sandbox, task('a', 12), 'All', { message: ' Go on ' }).message,
        `${DEFAULT}\n\n## Additional instructions\n\nGo on\n`
      )
      assert.strictEqual(
        plan(sandbox, task('a', 12), 'All', { defaultReply: 'Custom default' }).message,
        'Custom default'
      )
      assert.strictEqual(
        plan(sandbox, task('a', 12), 'All', { defaultReply: 'Custom default', message: 'Go on' }).message,
        'Custom default\n\n## Additional instructions\n\nGo on\n'
      )
    })

    it('approves a pending plan, and skips one without a plan id', () => {
      const { sandbox } = setupEnvironment()
      assert.deepStrictEqual(plan(sandbox, task('p', 10, { planId: 'p1' })), { action: 'approve' })
      assert.deepStrictEqual(plan(sandbox, task('p', 10)), { skip: 'no plan to approve' })
    })

    it('resumes a paused session', () => {
      const { sandbox } = setupEnvironment()
      assert.deepStrictEqual(plan(sandbox, task('z', 8)), { action: 'resume' })
    })

    it('retries a failed session with the retry prompt, counting against the quota', () => {
      const { sandbox } = setupEnvironment()
      assert.deepStrictEqual(plan(sandbox, task('e', 4)), {
        action: 'retry',
        message: sandbox.test_DEFAULT_ERROR_CONTINUE_MESSAGE,
        usesQuota: true
      })
      assert.strictEqual(
        plan(sandbox, task('e', 4), 'All', { message: 'Skip the flaky test' }).message,
        `${sandbox.test_DEFAULT_ERROR_CONTINUE_MESSAGE}\n\n## Additional instructions\n\nSkip the flaky test\n`
      )
      assert.strictEqual(plan(sandbox, task('e', 4), 'All', { defaultRetry: 'Retry it' }).message, 'Retry it')
    })

    it('leaves running sessions alone unless there is a message to send', () => {
      const { sandbox } = setupEnvironment()
      for (const state of [1, 2, 9, 11]) {
        assert.deepStrictEqual(plan(sandbox, task('r', state)), {
          skip: 'already running (add a message to send one)'
        })
        assert.deepStrictEqual(plan(sandbox, task('r', state), 'All', { message: 'Also do X' }), {
          action: 'reply',
          message: 'Also do X'
        })
      }
    })

    it('under All, skips completed tasks unless Force is on', () => {
      const { sandbox } = setupEnvironment()
      for (const state of [3, 7, null]) {
        assert.deepStrictEqual(plan(sandbox, task('c', state), 'All', { message: 'More' }), {
          skip: 'completed (Proceed on All skips them unless Force is on)'
        })
        assert.deepStrictEqual(plan(sandbox, task('c', state), 'All', { message: 'More', force: true }), {
          action: 'followUp',
          message: 'More',
          usesQuota: true
        })
      }
    })

    it('sends a follow-up to a completed task only when there is a message', () => {
      const { sandbox } = setupEnvironment()
      assert.deepStrictEqual(plan(sandbox, task('c', 3), 'Completed (3)'), {
        skip: 'completed (a follow-up needs a message)'
      })
      assert.deepStrictEqual(plan(sandbox, task('c', 3), 'All', { force: true }), {
        skip: 'completed (a follow-up needs a message)'
      })
      assert.deepStrictEqual(plan(sandbox, task('c', 7), 'Completed', { message: 'Add tests' }), {
        action: 'followUp',
        message: 'Add tests',
        usesQuota: true
      })
    })

    it('treats unknown and unmapped states like running ones', () => {
      const { sandbox } = setupEnvironment()
      for (const state of [0, 99]) {
        assert.deepStrictEqual(plan(sandbox, task('u', state)), { skip: 'unknown state' })
        assert.deepStrictEqual(plan(sandbox, task('u', state), 'All', { message: 'Hi' }), {
          action: 'reply',
          message: 'Hi'
        })
      }
    })
  })

  describe('planProceedWork', () => {
    it('orders the work so quota goes to the most useful tasks first', () => {
      const { sandbox } = setupEnvironment()
      const tasks = [
        task('done', 3),
        task('err', 4),
        task('run', 2),
        task('paused', 8),
        task('plan', 10, { planId: 'p' }),
        task('fb', 12)
      ]
      const { work } = sandbox.planProceedWork(tasks, sandbox.resolveItem('All'), { message: 'Go', force: true })
      assert.deepStrictEqual(
        Array.from(work, (w) => w.task.id),
        ['fb', 'plan', 'paused', 'run', 'err', 'done']
      )
    })

    it('counts the skipped tasks per reason', () => {
      const { sandbox } = setupEnvironment()
      const tasks = [task('a', 3), task('b', 3), task('c', 2)]
      const { work, skipped } = sandbox.planProceedWork(tasks, sandbox.resolveItem('All'), {})
      assert.strictEqual(work.length, 0)
      assert.deepStrictEqual(Object.fromEntries(skipped), {
        'completed (Proceed on All skips them unless Force is on)': 2,
        'already running (add a message to send one)': 1
      })
    })
  })

  describe('buildInteractPayload', () => {
    it('builds the reply exactly as the Jules UI sends it', () => {
      const { sandbox } = setupEnvironment()
      const payload = sandbox.buildInteractPayload(task('t1', 12), { action: 'reply', message: 'Go on' }, 'act-9')
      assert.strictEqual(payload[0], 't1')
      assert.strictEqual(payload[1][0], null)
      assert.strictEqual(payload[1][1], null)
      assert.strictEqual(payload[1][2][0], 'Go on')
      assert.strictEqual(payload[1][2][1], null)
      assert.match(payload[1][2][2], UUID_REGEX)
      assert.strictEqual(payload[1][3], 'act-9')
      assert.strictEqual(payload[2], null)
      assert.deepStrictEqual(Array.from(payload[3][0]), Array.from(sandbox.test_INTERACT_EXPERIMENT_IDS))
    })

    it('approves a plan by its id and sends no text', () => {
      const { sandbox } = setupEnvironment()
      const payload = sandbox.buildInteractPayload(task('t2', 10, { planId: 'plan-7' }), { action: 'approve' }, 'act-1')
      assert.deepStrictEqual(JSON.parse(JSON.stringify(payload[1])), [null, ['plan-7'], null, 'act-1'])
    })
  })

  describe('normalizeMessage', () => {
    it('trims the message and caps its length', () => {
      const { sandbox } = setupEnvironment()
      assert.strictEqual(sandbox.normalizeMessage('  hi  '), 'hi')
      assert.strictEqual(sandbox.normalizeMessage('x'.repeat(5000)).length, sandbox.test_MAX_MESSAGE_LEN)
      assert.strictEqual(sandbox.normalizeMessage(undefined), '')
      assert.strictEqual(sandbox.normalizeMessage(42), '')
    })
  })

  describe('processProceedForTab', () => {
    const run = (sandbox, itemText, options = {}) =>
      sandbox.processProceedForTab(TAB, { item: sandbox.resolveItem(itemText), dryRun: false, ...options })

    it('a dry run lists what it would do and sends nothing', async () => {
      const tasks = [
        task('fb', 12),
        task('plan', 10, { planId: 'p1' }),
        task('err', 4),
        task('paused', 8),
        task('run', 2)
      ]
      const { sandbox, writes, sent, log } = setupProceedEnv(tasks)
      const count = await run(sandbox, 'All', { dryRun: true })

      assert.strictEqual(count, 0)
      assert.deepStrictEqual(writes(), [])
      assert.deepStrictEqual(sent('n74qPd'), [])
      assert.ok(log().some((l) => l.includes('[DRY] Would reply to [u/1] [fb] Task fb')))
      assert.ok(log().some((l) => l.includes('[DRY] Would approve the plan of [u/1] [plan] Task plan')))
      assert.ok(log().some((l) => l.includes('[DRY] Would retry [u/1] [err] Task err')))
      assert.ok(log().some((l) => l.includes('[DRY] Would resume [u/1] [paused] Task paused')))
      assert.ok(log().some((l) => l.includes('Skipping 1 task(s): already running (add a message to send one)')))
    })

    it('replies, approves and resumes, each with the right call', async () => {
      const tasks = [task('fb', 12), task('plan', 10, { planId: 'p1' }), task('paused', 8)]
      const { sandbox, sent } = setupProceedEnv(tasks)
      const count = await run(sandbox, 'All', { message: 'Proceed' })

      assert.strictEqual(count, 3)
      const byTask = Object.fromEntries(sent('SLmX6').map((c) => [c.payload[0], c.payload]))
      assert.deepStrictEqual(Object.keys(byTask).sort(), ['fb', 'plan'])
      assert.ok(byTask.fb[1][2][0].endsWith('## Additional instructions\n\nProceed\n'))
      assert.ok(byTask.fb[1][2][0].startsWith(sandbox.test_DEFAULT_CONTINUE_MESSAGE))
      assert.strictEqual(byTask.fb[1][3], 'act-last-fb')
      assert.deepStrictEqual(byTask.plan[1], [null, ['p1'], null, 'act-last-plan'])
      assert.deepStrictEqual(
        sent('wk4vKd').map((c) => c.payload),
        [['paused']]
      )

      const state = sandbox.test_state()
      assert.strictEqual(state.progress.archived, 3)
      assert.strictEqual(state.progress.total, 3)
      assert.ok(state.log.some((l) => l.includes('Resumed [u/1] [paused] Task paused')))
      assert.ok(state.log.some((l) => l.includes("Plan approvals and resumes don't take a message")))
    })

    it('only touches the chosen state', async () => {
      const tasks = [task('fb', 12), task('err', 4)]
      const { sandbox, writes } = setupProceedEnv(tasks)
      await run(sandbox, 'Error (4)')
      assert.deepStrictEqual(
        writes().map((c) => c.payload[0]),
        ['err']
      )
    })

    it('stops at "Run up to N items" from Settings', async () => {
      const tasks = [task('fb', 12), task('plan', 10, { planId: 'p1' }), task('paused', 8)]
      const { sandbox, writes, log } = setupProceedEnv(tasks)
      await sandbox.test_settingsReady()
      vm.runInContext('runBudget = 1', sandbox)
      sandbox.test_settings().runLimit = 1
      const count = await run(sandbox, 'All')
      assert.strictEqual(count, 1)
      assert.deepStrictEqual(
        writes().map((c) => c.payload[0]),
        ['fb'],
        'the first in Proceed order'
      )
      assert.ok(
        log().some((l) => l.includes('Settings: run up to 1 item(s), so only 1 of 3 task(s) to proceed')),
        log().join('\n')
      )
    })

    it('only touches tasks in the selected repository', async () => {
      const tasks = [task('mine', 12), task('other', 12, { source: 'github/x/y', repo: 'x/y' })]
      const { sandbox, writes } = setupProceedEnv(tasks)
      await run(sandbox, 'Waiting on You (12)', { repoFilter: 'o/r' })
      assert.deepStrictEqual(
        writes().map((c) => c.payload[0]),
        ['mine']
      )
    })

    it('sends a follow-up to completed tasks when Completed is chosen with a message', async () => {
      const tasks = [task('done', 3), task('nostate', null)]
      const { sandbox, sent } = setupProceedEnv(tasks)
      const count = await run(sandbox, 'Completed (3)', { message: 'Add a changelog entry' })
      assert.strictEqual(count, 2)
      assert.deepStrictEqual(
        sent('SLmX6').map((c) => c.payload[1][2][0]),
        ['Add a changelog entry', 'Add a changelog entry']
      )
    })

    it('gives the quota to failed sessions before completed ones', async () => {
      const tasks = [task('done', 3), task('err1', 4), task('err2', 4), task('fb', 12)]
      const { sandbox, writes, log } = setupProceedEnv(tasks, { quota: [98, [86400], 100] })
      await run(sandbox, 'All', { message: 'Go', force: true })
      assert.deepStrictEqual(
        writes()
          .map((c) => c.payload[0])
          .sort(),
        ['err1', 'err2', 'fb']
      )
      assert.ok(log().some((l) => l.includes('only 2 of 3 task(s) that start a new run will go')))
    })

    it('still replies when the daily session limit is used up', async () => {
      const tasks = [task('fb', 12), task('err', 4)]
      const { sandbox, writes, log } = setupProceedEnv(tasks, { quota: [100, [86400], 100] })
      const count = await run(sandbox, 'All')
      assert.strictEqual(count, 1)
      assert.deepStrictEqual(
        writes().map((c) => c.payload[0]),
        ['fb']
      )
      assert.ok(log().some((l) => l.includes('Daily session limit reached (100/100): skipping 1 task(s)')))
    })

    it('shows the quota cap in a dry run too', async () => {
      const tasks = [task('err1', 4), task('err2', 4)]
      const { sandbox, writes, log } = setupProceedEnv(tasks, { quota: [99, [86400], 100] })
      await run(sandbox, 'Error (4)', { dryRun: true })
      assert.deepStrictEqual(writes(), [])
      assert.strictEqual(log().filter((l) => l.includes('[DRY] Would retry')).length, 1)
    })

    it('does not look up the quota when nothing would start a new run', async () => {
      const { sandbox, sent } = setupProceedEnv([task('fb', 12)])
      await run(sandbox, 'All')
      assert.deepStrictEqual(sent('KQOO7'), [])
    })

    it('still retries failed sessions when the quota lookup fails', async () => {
      const { sandbox, writes, log } = setupProceedEnv([task('err', 4)], { quota: new Error('HTTP 500') })
      await run(sandbox, 'All')
      assert.deepStrictEqual(
        writes().map((c) => c.payload[0]),
        ['err']
      )
      assert.ok(log().some((l) => l.includes('WARNING: Could not fetch daily quota')))
    })

    it('explains a RESOURCE_EXHAUSTED reply as the daily session limit', async () => {
      const { sandbox, log } = setupProceedEnv([task('err', 4)], {
        failInteract: new Set(['err']),
        interactError: 'RPC SLmX6 error code [8]'
      })
      await run(sandbox, 'All')
      assert.ok(
        log().some(
          (l) => l.includes('ERROR [u/1] proceeding with [err]') && l.includes('(daily session limit reached)')
        )
      )
    })

    it('keeps going after one reply fails and never re-sends it', async () => {
      const tasks = [task('bad', 12), task('good', 12)]
      const { sandbox, sent } = setupProceedEnv(tasks, { failInteract: new Set(['bad']) })
      const count = await run(sandbox, 'All')
      assert.strictEqual(count, 1)
      assert.strictEqual(sent('SLmX6').filter((c) => c.payload[0] === 'bad').length, 1)
      assert.strictEqual(sandbox.test_state().progress.skipped, 1)
    })

    it('skips a task whose session has no activity to reply to', async () => {
      const { sandbox, sent, log } = setupProceedEnv([task('empty', 12)], { activities: { empty: [] } })
      const count = await run(sandbox, 'All')
      assert.strictEqual(count, 0)
      assert.deepStrictEqual(sent('SLmX6'), [])
      assert.ok(log().some((l) => l.includes('SKIP [u/1] [empty] Task empty (no activity to reply to)')))
    })

    it('refuses to run without an item', async () => {
      const { sandbox, writes } = setupProceedEnv([task('fb', 12)])
      await assert.rejects(sandbox.processProceedForTab(TAB, { dryRun: false }), /Proceed needs an item/)
      assert.deepStrictEqual(writes(), [])
    })

    it('reports when there is nothing to do', async () => {
      const { sandbox, writes, log } = setupProceedEnv([task('run', 2), task('done', 3)])
      const count = await run(sandbox, 'All')
      assert.strictEqual(count, 0)
      assert.deepStrictEqual(writes(), [])
      assert.ok(log().some((l) => l.includes('Nothing to proceed with.')))
    })
  })

  describe('resolveRunOptions', () => {
    const resolve = (sandbox, options) => JSON.parse(JSON.stringify(sandbox.resolveRunOptions(options)))

    it('maps an action and a task item to the matching orchestrator', () => {
      const { sandbox } = setupEnvironment()
      assert.strictEqual(resolve(sandbox, { action: 'proceed', item: 'Error (4)' }).opMode, 'proceed')
      assert.strictEqual(resolve(sandbox, { action: 'archive', item: 'All' }).opMode, 'archive')
      assert.deepStrictEqual(resolve(sandbox, { action: 'archive', item: 'Error' }).item.codes, [4])
    })

    it('maps Suggestions to start, batch or remove', () => {
      const { sandbox } = setupEnvironment()
      assert.strictEqual(resolve(sandbox, { action: 'proceed', item: 'Suggestions' }).opMode, 'suggestions')
      assert.strictEqual(
        resolve(sandbox, { action: 'proceed', item: 'Suggestions', oneSession: true }).opMode,
        'agent_batch'
      )
      assert.strictEqual(resolve(sandbox, { action: 'archive', item: 'Suggestions' }).opMode, 'remove_suggestions')
    })

    it('maps export to the suggestions export', () => {
      const { sandbox } = setupEnvironment()
      assert.strictEqual(resolve(sandbox, { action: 'export' }).opMode, 'export_suggestions')
    })

    it('normalizes the message', () => {
      const { sandbox } = setupEnvironment()
      assert.strictEqual(resolve(sandbox, { action: 'proceed', item: 'All', message: '  hi ' }).message, 'hi')
    })

    it('rejects an unknown action or item', () => {
      const { sandbox } = setupEnvironment()
      assert.throws(() => sandbox.resolveRunOptions({ action: 'delete', item: 'All' }), /Unknown action "delete"/)
      assert.throws(() => sandbox.resolveRunOptions({ action: 'archive', item: 'Nope' }), /Unknown item "Nope"/)
      assert.throws(() => sandbox.resolveRunOptions({ action: 'archive', item: { codes: null } }), /Unknown item/)
      assert.throws(() => sandbox.resolveRunOptions({ action: 'archive' }), /Unknown item "undefined"/)
    })

    it('rejects options without an action, whatever else they carry', () => {
      const { sandbox } = setupEnvironment()
      assert.throws(() => sandbox.resolveRunOptions({ opMode: 'proceed', dryRun: false }), /Unknown action "undefined"/)
      assert.throws(() => sandbox.resolveRunOptions({}), /Unknown action "undefined"/)
    })
  })

  describe('START message', () => {
    function send(env, options, { protocol = RUN_PROTOCOL } = {}) {
      return new Promise((resolve) => {
        for (const listener of env.messageListeners) listener({ action: 'START', protocol, options }, {}, resolve)
      })
    }
    const plain = (value) => JSON.parse(JSON.stringify(value))

    it('answers HELLO with its protocol, but not to a content script', async () => {
      const env = setupEnvironment()
      const ask = (sender) =>
        new Promise((resolve) => {
          for (const listener of env.messageListeners) listener({ action: 'HELLO' }, sender, resolve)
        })
      assert.deepStrictEqual(plain(await ask({})), { protocol: RUN_PROTOCOL })
      assert.match(plain(await ask({ tab: { id: 1 } })).error, /Unauthorized/)
    })

    it("refuses an older popup's START, the message that archived 65 tasks", async () => {
      const env = setupEnvironment()
      let started = false
      env.sandbox.startOperation = async () => {
        started = true
      }
      // The pre-2026-10-19 popup sent no protocol and an opMode.
      const old = { action: 'START', options: { opMode: 'archive', force: true, dryRun: false } }
      const response = await new Promise((resolve) => {
        for (const listener of env.messageListeners) listener(old, {}, resolve)
      })
      assert.match(plain(response).error, /different versions\. Reload the extension/)
      const other = await send(env, { action: 'archive', item: 'All' }, { protocol: RUN_PROTOCOL + 1 })
      assert.match(plain(other).error, /different versions/)
      assert.strictEqual(started, false)
    })

    it('refuses an option it does not know, instead of ignoring it', async () => {
      const env = setupEnvironment()
      let started = false
      env.sandbox.startOperation = async () => {
        started = true
      }
      const response = await send(env, { action: 'proceed', item: 'All', dryRun: true, keepGoing: true })
      assert.match(plain(response).error, /^Unknown option keepGoing\. Reload the extension/)
      assert.strictEqual(started, false)
    })

    it('refuses a second START that arrives while the first waits for the settings', async () => {
      const env = setupEnvironment()
      const seen = []
      env.sandbox.startOperation = async (options) => {
        seen.push(options.action)
      }
      const first = send(env, { action: 'proceed', item: 'All', dryRun: true })
      const second = send(env, { action: 'archive', item: 'All', dryRun: true })
      assert.match(plain(await second).error, /already going/)
      assert.deepStrictEqual(plain(await first), { ok: true })
      assert.deepStrictEqual(seen, ['proceed'])
    })

    it('waits for the saved state before starting, so a woken worker cannot run twice', async () => {
      let ready
      const sessionReady = new Promise((resolve) => {
        ready = resolve
      })
      const env = setupEnvironment({ archiveState: { status: 'done', log: [] } }, {}, { sessionReady })
      const seen = []
      env.sandbox.startOperation = async (options) => {
        seen.push(options.action)
        env.sandbox.test_updateState({ status: 'running' })
      }
      const first = send(env, { action: 'proceed', item: 'All', dryRun: true })
      await new Promise((r) => setTimeout(r, 5))
      ready()
      assert.deepStrictEqual(plain(await first), { ok: true })
      await new Promise((r) => setTimeout(r, 5))
      assert.strictEqual(env.sandbox.test_state().status, 'running', 'the restore did not undo the run')
      const second = await send(env, { action: 'archive', item: 'All', dryRun: true })
      assert.match(plain(second).error, /already going/)
      assert.deepStrictEqual(seen, ['proceed'])
    })

    it('does not let a scheduled tick start beside a manual START', async () => {
      const env = setupEnvironment({}, { schedEnabled: true })
      const seen = []
      env.sandbox.startOperation = async (options) => {
        seen.push(options.scheduled ? 'tick' : options.action)
        env.sandbox.test_updateState({ status: 'running' })
      }
      const manual = send(env, { action: 'proceed', item: 'All', dryRun: true })
      await env.sandbox.test_runScheduledTick()
      await manual
      assert.deepStrictEqual(seen, ['proceed'])
    })

    it('answers with an error for an unknown item and starts nothing', async () => {
      const env = setupEnvironment()
      let started = false
      env.sandbox.startOperation = async () => {
        started = true
      }
      const response = await send(env, { action: 'archive', item: 'Bogus' })
      assert.deepStrictEqual(JSON.parse(JSON.stringify(response)), { error: 'Unknown item "Bogus"' })
      assert.strictEqual(started, false)
    })

    it('rejects a run without an action and starts nothing', async () => {
      const env = setupEnvironment()
      let started = false
      env.sandbox.startOperation = async () => {
        started = true
      }
      const response = await send(env, { dryRun: false })
      assert.deepStrictEqual(JSON.parse(JSON.stringify(response)), { error: 'Unknown action "undefined"' })
      assert.strictEqual(started, false)
    })

    it('rejects a second run while one is going', async () => {
      const env = setupEnvironment()
      let started = 0
      env.sandbox.startOperation = async () => {
        started++
      }
      env.sandbox.test_updateState({ status: 'running' })
      const response = await send(env, { action: 'proceed', item: 'All', dryRun: true })
      assert.match(JSON.parse(JSON.stringify(response)).error, /already going/)
      assert.strictEqual(started, 0)
    })

    it('starts a valid run', async () => {
      const env = setupEnvironment()
      const seen = []
      env.sandbox.startOperation = async (options) => {
        seen.push(options)
      }
      const response = await send(env, { action: 'proceed', item: 'Waiting on You (12)', dryRun: true })
      assert.deepStrictEqual(JSON.parse(JSON.stringify(response)), { ok: true })
      assert.strictEqual(seen.length, 1)
    })
  })

  describe('run wiring', () => {
    it('routes proceed to processProceedForTab', async () => {
      const { sandbox } = setupEnvironment()
      const called = []
      sandbox.processProceedForTab = async () => {
        called.push('proceed')
        return 3
      }
      sandbox.processTab = async () => {
        called.push('archive')
        return 0
      }
      const results = await sandbox.test_processAllTabs([TAB], { opMode: 'proceed', item: sandbox.resolveItem('All') })
      assert.deepStrictEqual(called, ['proceed'])
      assert.strictEqual(results[0].count, 3)
    })

    it('labels the run, its item and its summary', () => {
      const { sandbox } = setupEnvironment()
      const options = sandbox.resolveRunOptions({ action: 'proceed', item: 'Waiting on You (12)', dryRun: false })
      sandbox.test_initOperationState(options)
      sandbox.finalizeOperation([{ label: 'u/1', count: 4 }], options)
      const log = sandbox.test_state().log
      assert.ok(log.includes('=== PROCEED MODE ==='))
      assert.ok(log.includes('=== ITEM: Waiting on You (12) ==='))
      assert.ok(log.some((l) => l.includes('u/1: 4 proceeded')))
      assert.ok(log.some((l) => l.includes('GRAND TOTAL: 4 tasks proceeded')))
    })

    it('notes that Archive ignores the message', () => {
      const { sandbox } = setupEnvironment()
      sandbox.test_initOperationState(sandbox.resolveRunOptions({ action: 'archive', item: 'All', message: 'Hi' }))
      assert.ok(sandbox.test_state().log.includes("Archive doesn't use the message; it is ignored."))
      sandbox.test_initOperationState(sandbox.resolveRunOptions({ action: 'proceed', item: 'All', message: 'Hi' }))
      assert.ok(!sandbox.test_state().log.some((l) => l.includes("doesn't use the message")))
    })

    it('ends in an error state for an unknown item', async () => {
      const { sandbox } = setupEnvironment()
      await sandbox.test_startOperation({ action: 'archive', item: 'Bogus' })
      const state = sandbox.test_state()
      assert.strictEqual(state.status, 'error')
      assert.strictEqual(state.error, 'Unknown item "Bogus"')
    })

    it('the scheduled tick archives Completed tasks only, with the PR check', async () => {
      const { sandbox } = setupEnvironment({}, { schedEnabled: true, schedStartSuggestions: true, schedMaxStarts: 3 })
      const runs = []
      sandbox.startOperation = async (options) => {
        runs.push(JSON.parse(JSON.stringify(options)))
      }
      await sandbox.test_runScheduledTick()
      assert.deepStrictEqual(
        runs.map((r) => [r.action, r.item, r.force]),
        [
          ['archive', 'Completed', false],
          ['proceed', 'suggestions', false]
        ]
      )
      assert.strictEqual(runs[1].maxSuggestions, 3)
      assert.deepStrictEqual(Array.from(sandbox.resolveItem(runs[0].item).codes), [3, 7])
    })
  })

  describe('scheduled tick and manual runs', () => {
    it('skips the suggestions step when a manual run started after the archive step', async () => {
      const { sandbox } = setupEnvironment({}, { schedEnabled: true, schedStartSuggestions: true, schedMaxStarts: 3 })
      const runs = []
      sandbox.startOperation = async (options) => {
        runs.push(options.action)
        // A manual START lands as the archive step ends.
        sandbox.test_updateState({ status: 'running' })
      }
      await sandbox.test_runScheduledTick()
      assert.deepStrictEqual(runs, ['archive'])
    })
  })

  describe('Suggestions with a message', () => {
    it('appends the message to each suggestion prompt', () => {
      const { sandbox } = setupEnvironment()
      const suggestion = { id: 's1', title: 'Fix it', categorySlug: 'security', filePath: 'a.js', line: 1 }
      const payload = sandbox.buildStartPayload(suggestion, 'github/o/r', {}, null, 'Keep the diff small')
      const prompt = payload[sandbox.test_RJA83D.PROMPT]
      assert.ok(prompt.endsWith('## Additional instructions\n\nKeep the diff small\n'))
      const plain = sandbox.buildStartPayload(suggestion, 'github/o/r', {}, null, '')
      assert.ok(!plain[sandbox.test_RJA83D.PROMPT].includes('Additional instructions'))
    })

    it('passes the message to every suggestion start', async () => {
      const { sandbox } = setupEnvironment()
      sandbox.getTabConfig = async () => ({ at: 'at', bl: 'bl_v1', fsid: 'fsid', accountNum: '0' })
      sandbox.getDailySessionQuota = async () => null
      sandbox.listSuggestionEnabledSources = async () => ['github/o/r']
      sandbox.listSuggestions = async () => [{ id: 's1', title: 'One', categorySlug: 'testing' }]
      const messages = []
      sandbox.startSuggestion = async (_s, _repo, _config, _startConfig, message) => {
        messages.push(message)
      }
      await sandbox.processSuggestionsForTab({ id: 1, url: 'https://jules.google.com/u/0/' }, { message: 'Extra' })
      assert.deepStrictEqual(messages, ['Extra'])
    })
  })
})

// =============================================================================
// Settings, pacing and Jules API rediscovery
// =============================================================================

describe('pacing requests sent together', () => {
  it('paces GitHub PR checks sent together too, and sends a lone one straight out', async () => {
    const { sandbox } = setupEnvironment()
    const waits = []
    sandbox.pause = async (ms) => {
      waits.push(ms)
    }
    sandbox.burstDelayMs = () => 900
    sandbox.fetch = async () => {
      await new Promise((r) => setTimeout(r, 5))
      return { ok: true, status: 200, json: async () => [] }
    }
    await sandbox.getOpenPRs('o', 'alone', '')
    assert.deepStrictEqual(waits, [])
    await Promise.all([
      sandbox.getOpenPRs('o', 'a', ''),
      sandbox.getOpenPRs('o', 'b', ''),
      sandbox.getOpenPRs('o', 'c', '')
    ])
    assert.deepStrictEqual(waits, [900, 900])
  })

  it('waits 0.5-2 s, plus up to the extra jitter when it is on', () => {
    const { sandbox } = setupEnvironment()
    const delay = sandbox.test_burstDelayMs
    const random = sandbox.Math.random
    try {
      sandbox.Math.random = () => 0
      assert.strictEqual(delay(), 500)
      sandbox.Math.random = () => 0.999999
      assert.ok(delay() >= 1999 && delay() <= 2000)
      sandbox.test_settings().extraJitter = true
      sandbox.test_settings().extraJitterMaxSec = 10
      assert.ok(delay() > 11900 && delay() <= 12000, `got ${delay()}`)
    } finally {
      sandbox.Math.random = random
    }
  })

  async function postEnv(settingsPatch = {}) {
    const { sandbox } = setupEnvironment()
    await sandbox.test_settingsReady()
    Object.assign(sandbox.test_settings(), settingsPatch)
    const waits = []
    sandbox.pause = async (ms) => {
      waits.push(ms)
    }
    sandbox.burstDelayMs = () => 700
    let inFlight = 0
    let peak = 0
    const peakByAccount = {}
    const live = {}
    sandbox.fetch = async (url) => {
      const account = new URL(url).pathname.split('/')[2]
      inFlight++
      live[account] = (live[account] || 0) + 1
      peak = Math.max(peak, inFlight)
      peakByAccount[account] = Math.max(peakByAccount[account] || 0, live[account])
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      live[account]--
      return { ok: true, status: 200, text: async () => ")]}'\n\n4\n[[]]" }
    }
    const post = (accountNum) =>
      sandbox.test_postBatchExecute('p1Takd', [], { at: 'a', bl: 'b', fsid: 'f', accountNum })
    return { sandbox, waits, post, stats: () => ({ peak, peakByAccount }) }
  }

  it('holds its slot until the reply body has downloaded', async () => {
    const { sandbox, post } = await postEnv({ totalParallel: 1 })
    let downloading = 0
    let peak = 0
    sandbox.fetch = async () => {
      downloading++
      peak = Math.max(peak, downloading)
      return {
        ok: true,
        status: 200,
        text: () =>
          new Promise((r) =>
            setTimeout(() => {
              downloading--
              r(")]}'\n\n4\n[[]]")
            }, 10)
          )
      }
    }
    await Promise.all([post('0'), post('1'), post('2')])
    assert.strictEqual(peak, 1, 'a 100 MB task list counts against the limit while it downloads')
  })

  it('times out a reply body that stops arriving', async () => {
    const { sandbox, post } = await postEnv({ requestTimeoutSec: 5 })
    sandbox.setTimeout = (fn, ms) => setTimeout(fn, ms === 5000 ? 5 : ms)
    sandbox.fetch = async (_url, opts) => ({
      ok: true,
      status: 200,
      text: () =>
        new Promise((_r, reject) => {
          opts.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          )
        })
    })
    await assert.rejects(post('0'), /timed out/)
  })

  it('ends an error body that stops arriving at the timeout, keeping the status', async () => {
    const { sandbox, post } = await postEnv({ requestTimeoutSec: 5 })
    sandbox.setTimeout = (fn, ms) => setTimeout(fn, ms === 5000 ? 5 : ms)
    sandbox.fetch = async (_url, opts) => ({
      ok: false,
      status: 400,
      text: () =>
        new Promise((_r, reject) => {
          opts.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          )
        })
    })
    await assert.rejects(post('0'), /HTTP 400/)
  })

  it('reads an error body once, while the request holds its slot', async () => {
    const { sandbox } = await postEnv()
    let reads = 0
    sandbox.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => {
        reads++
        return 'xsrf reply'
      }
    })
    const err = await sandbox.test_jFetch('https://jules.google.com/x', { buffer: true }).catch((e) => e)
    assert.strictEqual(err.status, 400)
    assert.strictEqual(reads, 1, 'read inside jFetch')
    assert.strictEqual(await err.response.text(), 'xsrf reply')
    assert.strictEqual(await err.response.text(), 'xsrf reply')
    assert.strictEqual(reads, 1)
  })

  it('sends a lone request straight out, and paces the rest of a burst', async () => {
    const { waits, post } = await postEnv()
    await post('0')
    assert.deepStrictEqual(waits, [], 'a lone request does not wait')
    await Promise.all([post('0'), post('0'), post('0')])
    assert.deepStrictEqual(waits, [700, 700], 'every request after the first of a burst waits')
  })

  it('keeps the total and per-account limits for every request, across accounts', async () => {
    const one = await postEnv({ totalParallel: 1 })
    await Promise.all([one.post('0'), one.post('1'), one.post('2')])
    assert.strictEqual(one.stats().peak, 1)

    const two = await postEnv({ perAccountParallel: 2, totalParallel: 12 })
    await Promise.all([1, 2, 3, 4, 5].map(() => two.post('0')))
    assert.strictEqual(two.stats().peakByAccount['0'], 2)
  })

  it('sends nothing while the account is paused, even if the pause starts after the request queued', async () => {
    const { sandbox, waits, post } = await postEnv()
    let sentAt = null
    const fetch = sandbox.fetch
    sandbox.fetch = async (...args) => {
      sentAt = vm.runInContext("accountPauses.get('0') || 0", sandbox)
      return fetch(...args)
    }
    // A 429 elsewhere pauses the account while this request is in its jitter.
    sandbox.pause = async (ms) => {
      waits.push(ms)
      if (waits.length === 1) vm.runInContext("accountPauses.set('0', Date.now() + 60000)", sandbox)
    }
    sandbox.burstDelayMs = () => 700
    vm.runInContext("accountActive.set('0', 1)", sandbox) // another request of the account is in flight
    await post('0')
    assert.deepStrictEqual(waits.slice(0, 1), [700])
    assert.ok(waits[1] > 59000, `waited out the pause: ${waits}`)
    assert.ok(sentAt > 0, 'the request went out only after waiting for the pause')
  })
})

describe('Run up to N items', () => {
  it('hands out the budget across calls and logs when it cuts', () => {
    const { sandbox } = setupEnvironment()
    const logs = []
    sandbox.addLog = (m) => logs.push(m)
    vm.runInContext('settings.runLimit = 3; runBudget = 3', sandbox)
    assert.deepStrictEqual(sandbox.test_takeRunBudget('a', [1, 2], 'tasks'), [1, 2])
    assert.deepStrictEqual(sandbox.test_takeRunBudget('b', [3, 4, 5], 'tasks'), [3])
    assert.deepStrictEqual(sandbox.test_takeRunBudget('c', [6], 'tasks'), [])
    assert.deepStrictEqual(logs, [
      '[b] Settings: run up to 3 item(s), so only 1 of 3 tasks',
      '[c] Settings: run up to 3 item(s), so only 0 of 1 tasks'
    ])
  })

  it('has no limit by default', () => {
    const { sandbox } = setupEnvironment()
    const many = Array.from({ length: 500 }, (_, i) => i)
    assert.strictEqual(sandbox.test_takeRunBudget('a', many, 'tasks').length, 500)
  })
})

describe('settings in the background', () => {
  it('keeps a change that lands while the start-up read is still in flight', async () => {
    const env = setupEnvironment({}, { settings: { runLimit: 0 } })
    await env.sandbox.chrome.storage.sync.set({ settings: { runLimit: 1 } })
    await env.sandbox.test_settingsReady()
    assert.strictEqual(env.sandbox.test_settings().runLimit, 1)
  })

  it('loads the saved settings and Jules API values at start-up', async () => {
    const env = setupEnvironment({}, { settings: { requestTimeoutSec: 45, runLimit: 1 } })
    await env.sandbox.test_settingsReady()
    assert.strictEqual(env.sandbox.test_settings().requestTimeoutSec, 45)
    assert.strictEqual(env.sandbox.test_settings().runLimit, 1)
  })

  it('picks up a change from the popup without a restart', async () => {
    const env = setupEnvironment()
    await env.sandbox.test_settingsReady()
    await env.sandbox.chrome.storage.sync.set({ settings: { perAccountParallel: 2 } })
    assert.strictEqual(env.sandbox.test_settings().perAccountParallel, 2)
    assert.strictEqual(env.sandbox.test_settings().requestTimeoutSec, 30, 'missing keys take their default')
    for (const listener of env.storageChangeListeners) {
      listener({ julesApi: { newValue: { rpc: { ListTasks: 'Abc12' } } } }, 'local')
    }
    assert.strictEqual(env.sandbox.rpc('ListTasks'), 'Abc12')
    for (const listener of env.storageChangeListeners) listener({ julesApi: { newValue: undefined } }, 'local')
    assert.strictEqual(env.sandbox.rpc('ListTasks'), 'p1Takd', 'Reset to defaults removes the stored values')
  })

  it('refuses to run, manually or on schedule, when the settings could not be read', async () => {
    const env = setupEnvironment(
      {},
      { schedEnabled: true, settings: { runLimit: 1 } },
      {
        prepare: (chrome) => {
          chrome.storage.local.get = async () => {
            throw new Error('IO error')
          }
        }
      }
    )
    await env.sandbox.test_settingsReady()
    assert.strictEqual(env.sandbox.test_settings().runLimit, 1, 'what could be read still applies')
    let started = 0
    env.sandbox.startOperation = async () => {
      started++
    }
    const response = await new Promise((resolve) => {
      const msg = { action: 'START', protocol: RUN_PROTOCOL, options: { action: 'archive', item: 'All' } }
      for (const listener of env.messageListeners) listener(msg, {}, resolve)
    })
    assert.match(JSON.parse(JSON.stringify(response)).error, /Could not read the settings \(IO error\)\. Reload/)
    await env.sandbox.test_runScheduledTick()
    assert.strictEqual(started, 0)
  })

  it("counts a scheduled tick's archive and suggestion steps against one budget", async () => {
    const env = setupEnvironment(
      {},
      { schedEnabled: true, schedStartSuggestions: true, schedMaxStarts: 5, settings: { runLimit: 1 } }
    )
    await env.sandbox.test_settingsReady()
    const kept = []
    env.sandbox.discoverTabs = async () => [{ id: 1, url: 'https://jules.google.com/u/0/' }]
    env.sandbox.processAllTabs = async (_tabs, options) => {
      kept.push([options.action, env.sandbox.test_takeRunBudget('u/0', ['a', 'b'], 'items').length])
      return []
    }
    await env.sandbox.test_runScheduledTick()
    assert.deepStrictEqual(kept, [
      ['archive', 1],
      ['proceed', 0]
    ])
  })

  it("sets the tick's budget before either step, so a failed archive step can't free the suggestions", async () => {
    const env = setupEnvironment(
      {},
      { schedEnabled: true, schedStartSuggestions: true, schedMaxStarts: 5, settings: { runLimit: 1 } }
    )
    await env.sandbox.test_settingsReady()
    const resolveItem = env.sandbox.resolveItem
    // A rediscovered state table without "Completed": the archive step fails before it runs.
    env.sandbox.resolveItem = (id) => (id === 'Completed' ? null : resolveItem(id))
    const kept = []
    env.sandbox.discoverTabs = async () => [{ id: 1, url: 'https://jules.google.com/u/0/' }]
    env.sandbox.processAllTabs = async (_tabs, options) => {
      kept.push([options.action, env.sandbox.test_takeRunBudget('u/0', ['a', 'b', 'c'], 'items').length])
      return []
    }
    await env.sandbox.test_runScheduledTick()
    assert.deepStrictEqual(kept, [['proceed', 1]])
  })

  it("keeps the archive step's account pauses, stops and 429 counts for the suggestions step", async () => {
    const env = setupEnvironment({}, { schedEnabled: true, schedStartSuggestions: true, schedMaxStarts: 5 })
    await env.sandbox.test_settingsReady()
    const seen = []
    env.sandbox.discoverTabs = async () => [{ id: 1, url: 'https://jules.google.com/u/1/' }]
    env.sandbox.processAllTabs = async (_tabs, options) => {
      const run = env.sandbox.test_accountRunState()
      if (options.action === 'archive') {
        run.stoppedAccounts.set('1', 'Jules asked to wait 600 s')
        run.accountPauses.set('2', Date.now() + 60000)
        run.accountRateLimits.set('3', 2)
      } else {
        seen.push(run.stoppedAccounts.has('1'), run.accountPauses.has('2'), run.accountRateLimits.get('3'))
      }
      return []
    }
    await env.sandbox.test_runScheduledTick()
    assert.deepStrictEqual(seen, [true, true, 2])
    // The next run starts clean.
    let stoppedAtStart
    env.sandbox.processAllTabs = async () => {
      stoppedAtStart = env.sandbox.test_accountRunState().stoppedAccounts.size
      return []
    }
    await env.sandbox.test_startOperation({ action: 'archive', item: 'Completed' })
    assert.strictEqual(stoppedAtStart, 0)
  })

  it('reads each message from its own key and merges a change to one key with the rest', async () => {
    const env = setupEnvironment({}, { settings: { runLimit: 3 }, defaultReply: 'Mine', continueErrorMessage: 'Old' })
    await env.sandbox.test_settingsReady()
    assert.strictEqual(env.sandbox.test_settings().defaultReply, 'Mine')
    assert.strictEqual(env.sandbox.test_settings().defaultRetry, 'Old', "the old popup's box until the popup saves")
    for (const listener of env.storageChangeListeners) listener({ defaultRetry: { newValue: 'New' } }, 'sync')
    assert.strictEqual(env.sandbox.test_settings().defaultRetry, 'New')
    assert.strictEqual(env.sandbox.test_settings().runLimit, 3)
    assert.strictEqual(env.sandbox.test_settings().defaultReply, 'Mine')
  })

  it('gives each run the default reply and retry, the run limit and fresh account pauses', async () => {
    const env = setupEnvironment({}, { settings: { defaultReply: 'Mine', defaultRetry: 'Again', runLimit: 2 } })
    let seen = null
    env.sandbox.discoverTabs = async (options) => {
      seen = { ...options, budget: vm.runInContext('runBudget', env.sandbox) }
      return null
    }
    vm.runInContext("stoppedAccounts.set('0', 'old stop')", env.sandbox)
    await env.sandbox.test_startOperation({ action: 'proceed', item: 'All', dryRun: true })
    assert.strictEqual(seen.defaultReply, 'Mine')
    assert.strictEqual(seen.defaultRetry, 'Again')
    assert.strictEqual(seen.budget, 2)
    assert.strictEqual(vm.runInContext('stoppedAccounts.size', env.sandbox), 0)
  })
})

describe('Jules API rediscovery', () => {
  const { JULES_RPC_DEFAULTS } = require('../settings.js')
  const ROW5 =
    '[[0,"Unknown"],[1,"Queued"],[11,"Queued restart"],[2,"In progress"],[9,"Planning"],[12,"Awaiting user feedback"],[10,"Awaiting plan approval"],[3,"Completed"],[4,"Error"],[8,"Paused"],[7,"Completed"]]'
  const ROW25 = '[[0,"Unknown"],[1,"Pending"],[2,"Queued"]]'
  const bundle = (rpc) =>
    `var a=1;${Object.entries(rpc)
      .map(([m, id]) => `x({S:"${id}",V:"/SweBotService.${m}",T:1});`)
      .join('')}var s=new Map(${ROW5});var t=new Map(${ROW25});`

  it('reads RPC ids and state maps only from Jules and gstatic scripts', async () => {
    const { sandbox } = setupEnvironment()
    const fetched = []
    sandbox.document = {
      scripts: [
        { src: 'https://www.gstatic.com/_/mss/boq-swebot/js/k=main.js' },
        { src: 'https://evil.example.com/steal.js' },
        { src: 'http://www.gstatic.com/plain.js' },
        { src: '' }
      ]
    }
    sandbox.performance = {
      getEntriesByType: () => [
        { initiatorType: 'script', name: 'https://jules.google.com/_/lazy.js' },
        { initiatorType: 'img', name: 'https://www.gstatic.com/logo.js' }
      ]
    }
    sandbox.fetch = async (url) => {
      fetched.push(url)
      return {
        text: async () => (url.includes('main') ? bundle(JULES_RPC_DEFAULTS) : 'x({S:"Zz9Yy",V:"/Other.Thing"})')
      }
    }
    const found = JSON.parse(JSON.stringify(await sandbox.test_readJulesBundle()))
    assert.deepStrictEqual(fetched.sort(), [
      'https://jules.google.com/_/lazy.js',
      'https://www.gstatic.com/_/mss/boq-swebot/js/k=main.js'
    ])
    assert.strictEqual(found.scripts, 2)
    assert.ok(found.rpc.some(([id, m]) => id === 'p1Takd' && m === 'SweBotService.ListTasks'))
    assert.ok(found.rpc.some(([id, m]) => id === 'Zz9Yy' && m === 'Other.Thing'))
    assert.strictEqual(found.stateMaps.length, 2)
    assert.deepStrictEqual(found.stateMaps[0], JSON.parse(ROW5))
  })

  function rediscoverEnv(found, { running = false } = {}) {
    const env = setupEnvironment()
    const local = {}
    env.sandbox.chrome.storage.local = {
      get: async (keys) => Object.fromEntries([].concat(keys).map((k) => [k, local[k]])),
      set: async (data) => Object.assign(local, data)
    }
    env.sandbox.chrome.tabs.query = async () => [{ id: 7, url: 'https://jules.google.com/u/0/' }]
    const injected = []
    env.sandbox.chrome.scripting.executeScript = async (opts) => {
      injected.push(opts)
      return [{ result: found }]
    }
    if (running) vm.runInContext("state.status = 'running'", env.sandbox)
    const ask = (sender = {}) =>
      new Promise((resolve) => {
        for (const listener of env.messageListeners) listener({ action: 'REDISCOVER_API' }, sender, resolve)
      })
    return { env, local, injected, ask }
  }
  const liveFound = (overrides = {}) => ({
    rpc: Object.entries({ ...JULES_RPC_DEFAULTS, ...overrides }).map(([m, id]) => [id, `SweBotService.${m}`]),
    stateMaps: [JSON.parse(ROW5), JSON.parse(ROW25)],
    scripts: 5
  })

  it('applies a renamed RPC at once, saves it and logs the change', async () => {
    const { env, local, injected, ask } = rediscoverEnv(liveFound({ ArchiveTasks: 'Qq7Rr' }))
    const response = JSON.parse(JSON.stringify(await ask()))
    assert.deepStrictEqual(response.changes, ['ArchiveTasks: Tjmm5c → Qq7Rr'])
    assert.strictEqual(local.julesApi.rpc.ArchiveTasks, 'Qq7Rr')
    assert.ok(Number.isFinite(local.julesApi.checkedAt))
    assert.deepStrictEqual(JSON.parse(JSON.stringify(local.julesApiLog[0].changes)), ['ArchiveTasks: Tjmm5c → Qq7Rr'])
    assert.strictEqual(env.sandbox.rpc('ArchiveTasks'), 'Qq7Rr')
    assert.deepStrictEqual(JSON.parse(JSON.stringify(injected[0].target)), { tabId: 7, documentIds: ['doc1'] })
  })

  it('reports no changes when Jules matches the current values', async () => {
    const { ask, local } = rediscoverEnv(liveFound())
    const response = await ask()
    assert.deepStrictEqual(Array.from(response.changes), [])
    assert.deepStrictEqual(Array.from(response.problems), [])
    assert.strictEqual(local.julesApi.states, null)
  })

  it('refuses while a run is going, and from a content script', async () => {
    const busy = rediscoverEnv(liveFound(), { running: true })
    assert.match((await busy.ask()).error, /A run is going/)
    assert.strictEqual(busy.injected.length, 0)
    const tab = rediscoverEnv(liveFound())
    assert.match((await tab.ask({ tab: { id: 7 } })).error, /Unauthorized/)
    assert.strictEqual(tab.injected.length, 0)
  })

  it('holds new values until the run in progress ends', async () => {
    const env = setupEnvironment()
    await env.sandbox.test_settingsReady()
    const seen = []
    env.sandbox.discoverTabs = async () => {
      for (const listener of env.storageChangeListeners) {
        listener({ julesApi: { newValue: { rpc: { ListTasks: 'Abc12' } } } }, 'local')
      }
      seen.push(env.sandbox.rpc('ListTasks'))
      env.sandbox.test_updateState({ status: 'error', error: 'No Jules tabs found' })
      return null
    }
    await env.sandbox.test_startOperation({ action: 'proceed', item: 'All', dryRun: true })
    assert.deepStrictEqual(seen, ['p1Takd'], 'the run kept the values it started with')
    assert.strictEqual(env.sandbox.rpc('ListTasks'), 'Abc12', 'applied once the run ended')
  })

  it('gives up on a script that stops arriving and reads the rest', async () => {
    const { sandbox } = setupEnvironment()
    sandbox.document = {
      scripts: [{ src: 'https://www.gstatic.com/stuck.js' }, { src: 'https://www.gstatic.com/main.js' }]
    }
    sandbox.performance = { getEntriesByType: () => [] }
    sandbox.setTimeout = (fn, ms) => setTimeout(fn, ms === 20000 ? 5 : ms)
    sandbox.fetch = async (url, opts) => {
      if (url.includes('main')) return { text: async () => bundle(JULES_RPC_DEFAULTS) }
      // Without a signal it never ends, as a stalled download would.
      return new Promise((_r, reject) => {
        opts?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        )
      })
    }
    const found = await sandbox.test_readJulesBundle()
    assert.ok(found.rpc.some(([id, m]) => id === 'p1Takd' && m === 'SweBotService.ListTasks'))
  })

  it('ends a check that takes too long, so the next one can start', async () => {
    const { env, injected, ask } = rediscoverEnv(liveFound())
    env.sandbox.setTimeout = (fn, ms) => setTimeout(fn, ms === 120000 ? 5 : ms)
    env.sandbox.chrome.scripting.executeScript = async (opts) => {
      injected.push(opts)
      return new Promise(() => {})
    }
    assert.match((await ask()).error, /took too long/)
    await ask()
    assert.strictEqual(injected.length, 2, 'a stuck check does not hold later ones')
  })

  it('never lets a check that ran out of time overwrite a newer one', async () => {
    const { env, local, injected, ask } = rediscoverEnv(liveFound())
    env.sandbox.setTimeout = (fn, ms) => setTimeout(fn, ms === 120000 ? 5 : ms)
    let finishFirst
    env.sandbox.chrome.scripting.executeScript = async (opts) => {
      injected.push(opts)
      if (injected.length === 1) return new Promise((resolve) => (finishFirst = resolve))
      return [{ result: liveFound({ ArchiveTasks: 'Newer1' }) }]
    }
    assert.match((await ask()).error, /took too long/)
    await ask()
    assert.strictEqual(local.julesApi.rpc.ArchiveTasks, 'Newer1')
    finishFirst([{ result: liveFound({ ArchiveTasks: 'Older1' }) }])
    await new Promise((r) => setTimeout(r, 10))
    assert.strictEqual(local.julesApi.rpc.ArchiveTasks, 'Newer1', 'the late check is dropped')
    assert.strictEqual(env.sandbox.test_julesApi().rpc.ArchiveTasks, 'Newer1')
  })

  it('never applies a check that ran out of time while it was saving', async () => {
    const { env, local, ask } = rediscoverEnv(liveFound({ ArchiveTasks: 'Older1' }))
    env.sandbox.setTimeout = (fn, ms) => setTimeout(fn, ms === 120000 ? 5 : ms)
    let saves = 0
    let finishFirstSave
    env.sandbox.chrome.storage.local.set = async (data) => {
      saves++
      if (saves === 1) {
        await new Promise((resolve) => (finishFirstSave = resolve))
        return
      }
      Object.assign(local, data)
    }
    assert.match((await ask()).error, /took too long/)
    env.sandbox.chrome.scripting.executeScript = async () => [{ result: liveFound({ ArchiveTasks: 'Newer1' }) }]
    await ask()
    assert.strictEqual(env.sandbox.test_julesApi().rpc.ArchiveTasks, 'Newer1')
    finishFirstSave()
    await new Promise((r) => setTimeout(r, 10))
    assert.strictEqual(env.sandbox.test_julesApi().rpc.ArchiveTasks, 'Newer1', 'the late save is not applied')
  })

  it('runs one check at a time', async () => {
    const { injected, ask } = rediscoverEnv(liveFound())
    const [a, b] = await Promise.all([ask(), ask()])
    assert.strictEqual(injected.length, 1)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)))
  })

  it('needs a Jules tab', async () => {
    const { env, ask } = rediscoverEnv(liveFound())
    env.sandbox.chrome.tabs.query = async () => []
    assert.strictEqual((await ask()).error, 'Open a Jules tab first.')
  })

  it('schedules a daily check, which skips while a run is going', async () => {
    const env = setupEnvironment()
    await new Promise((r) => setTimeout(r, 0))
    const alarm = env.alarmsStore.get(env.sandbox.test_API_REDISCOVER_ALARM)
    assert.strictEqual(alarm.periodInMinutes, 24 * 60)
    let checks = 0
    env.sandbox.rediscoverJulesApi = async () => {
      checks++
    }
    vm.runInContext("state.status = 'running'", env.sandbox)
    for (const listener of env.alarmListeners) listener({ name: 'jta-api-rediscover' })
    assert.strictEqual(checks, 0)
    vm.runInContext("state.status = 'idle'", env.sandbox)
    for (const listener of env.alarmListeners) listener({ name: 'jta-api-rediscover' })
    assert.strictEqual(checks, 1)
  })
})

const archivedFilter = (filter) => String(filter).includes('is_archived=true')

// More Actions uses the same VM Chrome fake as START; no request leaves the sandbox.
function moreMessage(env, msg, sender = {}) {
  return new Promise((resolve) => {
    const handled = env.messageListeners[0](msg, sender, resolve)
    if (handled !== true) resolve({ error: 'No asynchronous handler' })
  })
}

function setupMoreEnvironment(sync = {}, storage = {}) {
  const env = setupEnvironment(storage, sync)
  env.calls = []
  env.sandbox.getJulesTabs = async () => [
    { id: 1, url: 'https://jules.google.com/u/1/' },
    { id: 2, url: 'https://jules.google.com/u/2/' },
    { id: 3, url: 'https://jules.google.com/u/1/' }
  ]
  env.sandbox.prepareTab = async (tab) => ({
    config: { accountNum: String(tab.id), bl: 'build', at: 'token' },
    label: `u/${tab.id}`
  })
  env.sandbox.callBatchExecute = async (rpc, payload, config) => {
    env.calls.push({ rpc, payload: JSON.parse(JSON.stringify(payload)), account: config.accountNum })
    if (rpc === 'p1Takd') {
      // The one archived task is Org/Repo's; repo-docs has none archived.
      if (archivedFilter(payload[0]) && payload[0].includes('repo-docs')) return [[]]
      const ids = archivedFilter(payload[0]) ? ['archived'] : ['running', 'paused', 'completed', 'other']
      return [
        ids.map((id) => [
          id,
          `Title ${id}`,
          null,
          null,
          id === 'other' ? 'github/org/repo-docs' : 'github/Org/Repo',
          id === 'running' ? 2 : id === 'paused' ? 8 : 3
        ])
      ]
    }
    if (rpc === 'YqkSHd') return [[['github/Org/Repo'], ['github/org/repo-docs']]]
    if (rpc === 'hvmRxc') {
      const cron = []
      cron[7] = [null, null, null, '0 9 * * *', 'America/New_York']
      return [
        [
          ['active', 'github/Org/Repo', cron, ['\n  First line  \nSecond line'], null, [123, 0], 2],
          ['inactive', 'github/Org/Repo', cron, ['x'.repeat(150)], null, [123, 0], 3]
        ]
      ]
    }
    return []
  }
  // No open PRs unless a test says otherwise; no request reaches GitHub.
  env.prChecks = []
  env.sandbox.getOpenPRs = async (owner, repo) => {
    env.prChecks.push(`${owner}/${repo}`)
    return []
  }
  env.load = (repo = '', category = 'all') =>
    moreMessage(env, { action: 'LOAD_ITEMS', protocol: RUN_PROTOCOL, repo, category })
  env.loadArchived = (loadId) => moreMessage(env, { action: 'LOAD_ARCHIVED', protocol: RUN_PROTOCOL, loadId })
  // Both parts, as the popup sends them: the archived tasks come second.
  env.loadAll = async (repo = '') => {
    const load = await env.load(repo)
    return { load, archived: await env.loadArchived(load.loadId) }
  }
  env.apply = async (operation, items, dryRun = false, force = false) => {
    const response = await moreMessage(env, {
      action: 'APPLY_ACTION',
      protocol: RUN_PROTOCOL,
      operation,
      dryRun,
      force,
      items
    })
    for (let i = 0; i < 500; i++) await Promise.resolve()
    return response
  }
  return env
}

describe('More Actions background', () => {
  it('LOAD_ITEMS refuses content scripts, bad repos, mismatched protocols and unknown keys', async () => {
    const env = setupMoreEnvironment()
    for (const [patch, sender, error] of [
      [{}, { tab: { id: 1 } }, /Unauthorized/],
      [{ repo: 'invalid' }, {}, /repo/i],
      [{ category: 'everything' }, {}, /category/i],
      [{ category: undefined }, {}, /category/i],
      [{ protocol: -1 }, {}, /different versions/],
      [{ unexpected: true }, {}, /Unknown option/]
    ]) {
      const reply = await moreMessage(
        env,
        { action: 'LOAD_ITEMS', protocol: RUN_PROTOCOL, repo: '', category: 'all', ...patch },
        sender
      )
      assert.match(reply.error, error)
    }
    assert.strictEqual(env.calls.length, 0)
  })

  it('LOAD_ITEMS refuses running and pending operations', async () => {
    const env = setupMoreEnvironment()
    await env.sandbox.test_stateReadyPromise
    env.sandbox.test_updateState({ status: 'running' })
    assert.match((await env.load()).error, /run.*going/i)
    env.sandbox.test_updateState({ status: 'idle' })
    let release
    env.sandbox.getJulesTabs = () =>
      new Promise((resolve) => {
        release = resolve
      })
    const loading = env.load()
    for (let i = 0; i < 100; i++) await Promise.resolve()
    assert.match((await env.load()).error, /going|loading/i)
    assert.match((await env.apply('archive', [])).error, /going|loading/i)
    release([])
    await loading
  })

  it('LOAD_ITEMS merges unique accounts, filters exact repos and parses schedules', async () => {
    const env = setupMoreEnvironment()
    const { load: reply, archived } = await env.loadAll('org/repo')
    assert.ok(reply.accounts, reply.error)
    assert.deepStrictEqual(
      Array.from(reply.accounts, (a) => a.account),
      ['u/1', 'u/2']
    )
    const account = reply.accounts[0]
    assert.strictEqual(account.tasks.length, 3)
    assert.strictEqual(archived.accounts[0].archived.length, 1)
    assert.strictEqual(account.schedules[0].title, 'First line')
    assert.strictEqual(account.schedules[1].title.length, 120)
    assert.strictEqual(account.schedules[0].cron, '0 9 * * *')
    assert.strictEqual(account.schedules[0].timeZone, 'America/New_York')
    assert.strictEqual(account.schedules[1].state, 3)
    assert.ok(env.sessionSetData.some((data) => data.moreItems))
    // Jules matches a repo's source id by exact case, as ListSources spells it.
    assert.deepStrictEqual([...new Set(env.calls.filter((c) => c.rpc === 'p1Takd').map((c) => c.payload[0]))].sort(), [
      'source_id=github/Org/Repo AND is_archived=false',
      'source_id=github/Org/Repo AND is_archived=true'
    ])
  })

  it('LOAD_ITEMS keeps archived listing failures as per-account notes', async () => {
    const env = setupMoreEnvironment()
    const call = env.sandbox.callBatchExecute
    env.sandbox.callBatchExecute = (rpc, payload, config) => {
      if (rpc === 'p1Takd' && archivedFilter(payload[0]) && config.accountNum === '1') throw new Error('RPC error [4]')
      return call(rpc, payload, config)
    }
    const { load, archived: reply } = await env.loadAll()
    assert.strictEqual(load.accounts[0].tasks.length, 4)
    assert.ok(reply.accounts, reply.error)
    assert.strictEqual(reply.accounts[0].archived.length, 0)
    assert.match(
      reply.accounts[0].notes.join(' '),
      /Jules could not list the archived tasks of 2 of 2 repos of u\/1: Org\/Repo \(RPC error \[4\]\)/
    )
    assert.strictEqual(reply.accounts[1].archived.length, 1)
  })

  it('LOAD_ITEMS answers without the archived tasks; LOAD_ARCHIVED adds them to that load', async () => {
    const env = setupMoreEnvironment()
    const load = await env.load()
    assert.strictEqual(typeof load.loadId, 'string')
    assert.ok(load.accounts.every((account) => !('archived' in account)))
    assert.ok(env.calls.every((call) => call.rpc !== 'p1Takd' || call.payload[0] === ''))
    env.calls.length = 0
    await env.apply('unarchive', [{ account: 'u/1', kind: 'archived', id: 'archived' }])
    assert.strictEqual(env.calls.length, 0, 'not in the load yet')
    const archived = await env.loadArchived(load.loadId)
    assert.strictEqual(archived.loadId, load.loadId)
    assert.ok(
      env.calls.some(
        (call) => call.rpc === 'p1Takd' && call.payload[0] === 'source_id=github/Org/Repo AND is_archived=true'
      )
    )
    env.calls.length = 0
    await env.apply('unarchive', [{ account: 'u/1', kind: 'archived', id: 'archived' }])
    assert.deepStrictEqual(env.calls[0], { rpc: 'Tjmm5c', payload: [['archived']], account: '1' })
  })

  it("LOAD_ARCHIVED lists the archived tasks of the load's repo", async () => {
    const env = setupMoreEnvironment()
    const original = env.sandbox.callBatchExecute
    env.sandbox.callBatchExecute = async (rpc, payload, config) => {
      if (rpc === 'p1Takd' && archivedFilter(payload[0])) {
        return [
          [
            ['mine', 'Mine', null, null, 'github/org/repo', 3],
            ['other', 'Other', null, null, 'github/x/y', 3]
          ]
        ]
      }
      return original(rpc, payload, config)
    }
    const { archived } = await env.loadAll('org/repo')
    assert.deepStrictEqual(
      Array.from(archived.accounts[0].archived, (task) => task.id),
      ['mine']
    )
  })

  it('LOAD_ARCHIVED of a replaced load adds nothing', async () => {
    const env = setupMoreEnvironment()
    const first = await env.load()
    const original = env.sandbox.callBatchExecute
    // One held listing per account.
    const held = []
    const release = () => {
      for (const resume of held) resume()
    }
    env.sandbox.callBatchExecute = (rpc, payload, config) => {
      if (rpc === 'p1Takd' && archivedFilter(payload[0])) {
        return new Promise((resolve) => held.push(() => resolve(original(rpc, payload, config))))
      }
      return original(rpc, payload, config)
    }
    const late = env.loadArchived(first.loadId)
    for (let i = 0; i < 100; i++) await Promise.resolve()
    env.sandbox.callBatchExecute = original
    const second = await env.load()
    assert.notStrictEqual(second.loadId, first.loadId)
    release()
    assert.match((await late).error, /newer load/i)
    assert.match((await env.loadArchived(first.loadId)).error, /newer load/i)
    env.calls.length = 0
    await env.apply('unarchive', [{ account: 'u/1', kind: 'archived', id: 'archived' }])
    assert.strictEqual(env.calls.length, 0)
  })

  it("a newer load stays the saved one when an older load's archived tasks arrive late", async () => {
    const env = setupMoreEnvironment()
    const first = await env.load('org/repo')
    const original = env.sandbox.callBatchExecute
    const held = []
    env.sandbox.callBatchExecute = (rpc, payload, config) => {
      if (rpc === 'p1Takd' && archivedFilter(payload[0])) {
        return new Promise((resolve) => held.push(() => resolve(original(rpc, payload, config))))
      }
      return original(rpc, payload, config)
    }
    const late = env.loadArchived(first.loadId)
    for (let i = 0; i < 100; i++) await Promise.resolve()
    // The newer load's save is still on its way when the older answer lands.
    const set = env.sandbox.chrome.storage.session.set
    let finishSave
    env.sandbox.chrome.storage.session.set = (data) => {
      env.sandbox.chrome.storage.session.set = set
      const saving = set(data)
      return new Promise((resolve) => (finishSave = () => resolve(saving)))
    }
    const second = env.load('org/repo-docs')
    for (let i = 0; i < 100; i++) await Promise.resolve()
    for (const resume of held) resume()
    assert.match((await late).error, /newer load/i)
    finishSave()
    const newer = await second
    const saved = env.sessionSetData.findLast((data) => data.moreItems).moreItems
    assert.strictEqual(saved.id, newer.loadId)
    assert.strictEqual(saved.repo, 'org/repo-docs')
  })

  it("LOAD_ARCHIVED lists a load's archived tasks once", async () => {
    const env = setupMoreEnvironment()
    const { loadId } = await env.load()
    assert.ok((await env.loadArchived(loadId)).accounts)
    assert.match((await env.loadArchived(loadId)).error, /already/i)
    const restarted = setupMoreEnvironment(
      {},
      env.sessionSetData.findLast((data) => data.moreItems)
    )
    assert.match((await restarted.loadArchived(loadId)).error, /already/i, 'also after a worker restart')
  })

  it('LOAD_ARCHIVED may run again for a load whose archived listing failed', async () => {
    const env = setupMoreEnvironment()
    const { loadId } = await env.load()
    const tabs = env.sandbox.getJulesTabs
    env.sandbox.getJulesTabs = async () => []
    assert.match((await env.loadArchived(loadId)).error, /No Jules tabs/)
    env.sandbox.getJulesTabs = tabs
    assert.ok((await env.loadArchived(loadId)).accounts)
  })

  it('LOAD_ARCHIVED refuses content scripts, bad versions, unknown keys and a missing load id', async () => {
    const env = setupMoreEnvironment()
    const { loadId } = await env.load()
    env.calls.length = 0
    for (const [patch, sender, error] of [
      [{}, { tab: { id: 1 } }, /Unauthorized/],
      [{ protocol: -1 }, {}, /different versions/],
      [{ repo: 'org/repo' }, {}, /Unknown option repo/],
      [{ loadId: 5 }, {}, /Invalid/]
    ]) {
      const reply = await moreMessage(
        env,
        { action: 'LOAD_ARCHIVED', protocol: RUN_PROTOCOL, loadId, ...patch },
        sender
      )
      assert.match(reply.error, error)
    }
    assert.strictEqual(env.calls.length, 0)
  })

  it('lets an action run while the archived tasks are still listing, and keeps it alive', async () => {
    const env = setupMoreEnvironment()
    const { loadId } = await env.load()
    const original = env.sandbox.callBatchExecute
    // One held listing per account.
    const held = []
    const release = () => {
      for (const resume of held) resume()
    }
    env.sandbox.callBatchExecute = (rpc, payload, config) => {
      if (rpc === 'p1Takd' && archivedFilter(payload[0])) {
        return new Promise((resolve) => held.push(() => resolve(original(rpc, payload, config))))
      }
      return original(rpc, payload, config)
    }
    const archived = env.loadArchived(loadId)
    for (let i = 0; i < 100; i++) await Promise.resolve()
    let stopped = 0
    env.sandbox.stopKeepAlive = () => stopped++
    const reply = await env.apply('pauseTask', [{ account: 'u/1', kind: 'task', id: 'running' }])
    assert.ok(reply.ok, reply.error)
    assert.strictEqual(env.sandbox.test_state().status, 'done')
    const stoppedByRun = stopped
    release()
    assert.ok((await archived).accounts)
    assert.strictEqual(stopped, stoppedByRun, 'the archived listing leaves the run keep-alive alone')
  })

  for (const [action, kind, id, rpc, payload] of [
    ['archive', 'task', 'completed', 'Tjmm5c', [['completed'], 1]],
    ['unarchive', 'archived', 'archived', 'Tjmm5c', [['archived']]],
    ['pauseTask', 'task', 'running', 'tqq5v', ['running']],
    ['resumeTask', 'task', 'paused', 'wk4vKd', ['paused']],
    ['pauseSchedule', 'schedule', 'active', 'gBUOb', ['active']],
    ['resumeSchedule', 'schedule', 'inactive', 'XuzQWe', ['inactive']]
  ]) {
    it(`APPLY_ACTION ${action} sends the exact RPC payload to the selected account`, async () => {
      const env = setupMoreEnvironment()
      await env.loadAll()
      env.calls.length = 0
      const reply = await env.apply(action, [{ account: 'u/2', kind, id }])
      assert.ok(reply.ok, reply.error)
      const mutations = env.calls.filter((call) => call.rpc !== 'p1Takd')
      assert.ok(mutations.length >= 1)
      for (const call of mutations) assert.deepStrictEqual(call, { rpc, payload, account: '2' })
      assert.ok(env.calls.every((call) => !['rist8', 'sL8twb'].includes(call.rpc)))
      assert.strictEqual(env.sandbox.test_state().status, 'done')
      assert.match(env.sandbox.test_state().log.join('\n'), new RegExp(id))
      assert.match(env.sandbox.test_state().log.join('\n'), /SUMMARY/)
    })
  }

  it('APPLY_ACTION skips missing, duplicate and unfit selections with logs', async () => {
    const env = setupMoreEnvironment()
    await env.load()
    env.calls.length = 0
    await env.apply(
      'pauseTask',
      ['running', 'running', 'paused', 'missing'].map((id) => ({ account: 'u/1', kind: 'task', id }))
    )
    assert.strictEqual(env.calls.length, 1)
    assert.match(env.sandbox.test_state().log.join('\n'), /skip.*paused/i)
    assert.match(env.sandbox.test_state().log.join('\n'), /skip.*missing/i)
  })

  it('APPLY_ACTION dry run sends nothing and Run up to N caps across accounts', async () => {
    for (const dryRun of [true, false]) {
      const env = setupMoreEnvironment({ settings: { runLimit: 1 } })
      await env.load()
      env.calls.length = 0
      await env.apply(
        'pauseTask',
        [1, 2].map((num) => ({ account: `u/${num}`, kind: 'task', id: 'running' })),
        dryRun
      )
      assert.strictEqual(env.calls.length, dryRun ? 0 : 1)
      assert.strictEqual(
        env.sandbox.test_state().results.reduce((n, r) => n + r.count, 0),
        1
      )
    }
  })

  it('APPLY_ACTION unarchive checks once and resends only missing ids once', async () => {
    const env = setupMoreEnvironment()
    await env.loadAll()
    env.calls.length = 0
    await env.apply('unarchive', [{ account: 'u/1', kind: 'archived', id: 'archived' }])
    assert.deepStrictEqual(
      env.calls.map((call) => [call.rpc, call.payload]),
      [
        ['Tjmm5c', [['archived']]],
        ['p1Takd', ['', 4]],
        ['Tjmm5c', [['archived']]],
        ['p1Takd', ['', 4]]
      ]
    )
  })

  it('APPLY_ACTION counts an unarchive only once Jules lists the task again', async () => {
    const env = setupMoreEnvironment()
    await env.loadAll()
    env.calls.length = 0
    const item = { account: 'u/1', kind: 'archived', id: 'archived' }
    await env.apply('unarchive', [item])
    const state = env.sandbox.test_state()
    assert.strictEqual(state.results[0].count, 0)
    assert.strictEqual(state.progress.archived, 0)
    assert.strictEqual(state.progress.skipped, 1)
    assert.match(state.log.join('\n'), /\[archived\].*still archived/)
    env.calls.length = 0
    await env.apply('unarchive', [item])
    assert.ok(
      env.calls.some((call) => call.rpc === 'Tjmm5c'),
      'still in the load, so it can be tried again'
    )
  })

  it('APPLY_ACTION trusts the unarchive replies when the check itself fails', async () => {
    const env = setupMoreEnvironment()
    await env.loadAll()
    const original = env.sandbox.callBatchExecute
    env.sandbox.callBatchExecute = (rpc, payload, config) => {
      if (rpc === 'p1Takd' && payload[0] === '') throw new Error('RPC p1Takd error code [4]')
      return original(rpc, payload, config)
    }
    await env.apply('unarchive', [{ account: 'u/1', kind: 'archived', id: 'archived' }])
    const state = env.sandbox.test_state()
    assert.strictEqual(state.results[0].count, 1)
    assert.match(state.log.join('\n'), /Could not check the unarchived tasks/)
  })

  // Jules already skipped the retried ids once, so their replies are not proof.
  it('APPLY_ACTION does not count a retried unarchive when the second check fails', async () => {
    const env = setupMoreEnvironment()
    await env.loadAll()
    const original = env.sandbox.callBatchExecute
    let checks = 0
    env.sandbox.callBatchExecute = (rpc, payload, config) => {
      if (rpc === 'p1Takd' && payload[0] === '' && ++checks === 2) throw new Error('RPC p1Takd error code [4]')
      return original(rpc, payload, config)
    }
    const item = { account: 'u/1', kind: 'archived', id: 'archived' }
    await env.apply('unarchive', [item])
    const state = env.sandbox.test_state()
    assert.strictEqual(checks, 2)
    assert.strictEqual(state.results[0].count, 0)
    assert.strictEqual(state.progress.skipped, 1)
    assert.match(state.log.join('\n'), /\[archived\].*not confirmed/)
    env.sandbox.callBatchExecute = original
    env.calls.length = 0
    await env.apply('unarchive', [item])
    assert.ok(
      env.calls.some((call) => call.rpc === 'Tjmm5c'),
      'still in the load, so it can be tried again'
    )
  })

  it('APPLY_ACTION restores the last load after a worker restart', async () => {
    const first = setupMoreEnvironment()
    await first.loadAll()
    const saved = first.sessionSetData.findLast((data) => data.moreItems)
    const env = setupMoreEnvironment({}, saved)
    await env.apply('pauseTask', [{ account: 'u/1', kind: 'task', id: 'running' }])
    assert.strictEqual(env.calls.length, 1)
    assert.strictEqual(env.calls[0].rpc, 'tqq5v')
  })

  it('APPLY_ACTION refuses untrusted senders, protocol mismatch, unknown keys and actions', async () => {
    const env = setupMoreEnvironment()
    for (const [patch, sender, error] of [
      [{}, { tab: {} }, /Unauthorized/],
      [{ protocol: -1 }, {}, /different versions/],
      [{ surprise: true }, {}, /Unknown option/],
      [{ operation: 'delete' }, {}, /Unknown action/],
      [{ type: 'APPLY_ACTION' }, {}, /Unknown option type/]
    ]) {
      const reply = await moreMessage(
        env,
        { action: 'APPLY_ACTION', protocol: RUN_PROTOCOL, operation: 'archive', dryRun: false, items: [], ...patch },
        sender
      )
      assert.match(reply.error, error)
    }
    assert.strictEqual(env.calls.length, 0)
  })
})

describe('More Actions load choices', () => {
  const listed = (env) => env.calls.map((call) => `${call.rpc}:${call.rpc === 'p1Takd' ? call.payload[0] : ''}`)

  it('All lists the tasks and the schedules, never the archived tasks', async () => {
    const env = setupMoreEnvironment()
    const reply = await env.load('', 'all')
    assert.ok(reply.accounts, reply.error)
    assert.deepStrictEqual([...new Set(listed(env))].sort(), ['hvmRxc:', 'p1Takd:'])
    assert.strictEqual(reply.accounts[0].tasks.length, 4)
    assert.strictEqual(reply.accounts[0].schedules.length, 2)
  })

  it('Scheduled lists only the schedules', async () => {
    const env = setupMoreEnvironment()
    const reply = await env.load('org/repo', 'scheduled')
    assert.deepStrictEqual([...new Set(listed(env))], ['hvmRxc:'])
    assert.deepStrictEqual(
      Array.from(reply.accounts[0].schedules, (s) => s.id),
      ['active', 'inactive']
    )
    assert.ok(reply.accounts.every((account) => !('tasks' in account)))
  })

  it('Completed lists only the tasks in a completed state', async () => {
    const env = setupMoreEnvironment()
    const reply = await env.load('', 'complete')
    assert.deepStrictEqual([...new Set(listed(env))], ['p1Takd:'])
    assert.deepStrictEqual(
      Array.from(reply.accounts[0].tasks, (t) => t.id),
      ['completed', 'other']
    )
    env.calls.length = 0
    await env.apply('pauseTask', [{ account: 'u/1', kind: 'task', id: 'running' }])
    assert.strictEqual(env.calls.length, 0, 'a running task is not in a Completed load')
  })

  it('Archived lists nothing until LOAD_ARCHIVED, which adds the archived tasks', async () => {
    const env = setupMoreEnvironment()
    const load = await env.load('', 'archive')
    assert.deepStrictEqual(env.calls, [])
    assert.ok(load.accounts.every((account) => Object.keys(account).sort().join() === 'account,notes'))
    const archived = await env.loadArchived(load.loadId)
    assert.deepStrictEqual(
      [...new Set(listed(env))],
      [
        'YqkSHd:',
        'p1Takd:source_id=github/Org/Repo AND is_archived=true',
        'p1Takd:source_id=github/org/repo-docs AND is_archived=true'
      ]
    )
    assert.strictEqual(archived.accounts[0].archived.length, 1)
  })

  it('an All-repos load asks for every task with no repo lookup', async () => {
    const env = setupMoreEnvironment()
    await env.load('', 'all')
    assert.deepStrictEqual([...new Set(listed(env))].sort(), ['hvmRxc:', 'p1Takd:'])
    assert.ok(!env.calls.some((call) => call.rpc === 'YqkSHd'))
  })

  it("an All-repos Archived lists each connected repo's archived tasks, never the whole archive at once", async () => {
    const env = setupMoreEnvironment()
    const archived = await env.loadArchived((await env.load('', 'archive')).loadId)
    assert.ok(!env.calls.some((call) => call.rpc === 'p1Takd' && call.payload[0] === 'is_archived=true'))
    for (const account of ['1', '2']) {
      const calls = env.calls.filter((call) => call.account === account)
      assert.deepStrictEqual(
        Array.from(calls, (call) => (call.rpc === 'YqkSHd' ? call.payload[1] : call.payload[0])),
        [null, 'source_id=github/Org/Repo AND is_archived=true', 'source_id=github/org/repo-docs AND is_archived=true'],
        'one repo list per account, then one archived list per repo'
      )
    }
    assert.deepStrictEqual(
      Array.from(archived.accounts, (account) =>
        Array.from(account.archived, (task) => `${task.id}:${task.repo}`).join()
      ),
      ['archived:Org/Repo', 'archived:Org/Repo']
    )
    assert.ok(archived.accounts.every((account) => account.notes.length === 0))
  })

  it('lists at most Parallel per account repos at once', async () => {
    const env = setupMoreEnvironment({ settings: { perAccountParallel: 2 } })
    const sources = Array.from({ length: 7 }, (_, i) => [`github/org/r${i}`])
    let open = 0
    let peak = 0
    let listed = 0
    env.sandbox.callBatchExecute = async (rpc, payload, config) => {
      if (config.accountNum !== '1') return rpc === 'YqkSHd' ? [[]] : []
      if (rpc === 'YqkSHd') return [sources]
      open++
      peak = Math.max(peak, open)
      for (let i = 0; i < 20; i++) await Promise.resolve()
      open--
      listed++
      return [[[`t-${payload[0].slice(17, 21)}`, 'T', null, null, payload[0].split(' ')[0].slice(10), 3]]]
    }
    const archived = await env.loadArchived((await env.load('', 'archive')).loadId)
    assert.strictEqual(listed, 7)
    assert.strictEqual(peak, 2)
    assert.strictEqual(archived.accounts[0].archived.length, 7)
  })

  it('names the repos whose archived tasks Jules could not list, and keeps the rest', async () => {
    const env = setupMoreEnvironment()
    const original = env.sandbox.callBatchExecute
    env.sandbox.callBatchExecute = (rpc, payload, config) => {
      if (rpc === 'p1Takd' && archivedFilter(payload[0]) && payload[0].includes('repo-docs')) {
        throw new Error('RPC p1Takd error code [4]')
      }
      return original(rpc, payload, config)
    }
    const archived = await env.loadArchived((await env.load('', 'archive')).loadId)
    assert.strictEqual(archived.accounts[0].archived.length, 1)
    assert.deepStrictEqual(
      [...archived.accounts[0].notes],
      ['Jules could not list the archived tasks of 1 of 2 repos of u/1: org/repo-docs (RPC p1Takd error code [4]).']
    )
  })

  it('names at most three failed repos and counts the rest', async () => {
    const env = setupMoreEnvironment()
    env.sandbox.callBatchExecute = async (rpc, _payload, config) => {
      if (rpc === 'YqkSHd') return [Array.from({ length: 5 }, (_, i) => [`github/org/r${i}`])]
      if (rpc === 'p1Takd' && config.accountNum === '1') throw new Error('RPC error [4]')
      return [[]]
    }
    const archived = await env.loadArchived((await env.load('', 'archive')).loadId)
    assert.deepStrictEqual(
      [...archived.accounts[0].notes],
      [
        'Jules could not list the archived tasks of 5 of 5 repos of u/1: org/r0 (RPC error [4]), org/r1 (RPC error [4]), org/r2 (RPC error [4]) and 2 more.'
      ]
    )
    assert.deepStrictEqual([...archived.accounts[1].notes], [])
  })

  it("an account whose repos can't be read gets a note, and no archived list is asked", async () => {
    const env = setupMoreEnvironment()
    const original = env.sandbox.callBatchExecute
    env.sandbox.callBatchExecute = (rpc, payload, config) => {
      if (rpc === 'YqkSHd' && config.accountNum === '2') throw new Error('RPC YqkSHd error code [13]')
      return original(rpc, payload, config)
    }
    const archived = await env.loadArchived((await env.load('', 'archive')).loadId)
    assert.ok(!env.calls.some((call) => call.rpc === 'p1Takd' && call.account === '2'))
    assert.deepStrictEqual(
      [...archived.accounts[1].notes],
      ['Jules could not list the archived tasks of u/2: RPC YqkSHd error code [13].']
    )
    assert.strictEqual(archived.accounts[0].archived.length, 1)
  })

  it('saves how many repos the All-repos archived listing has done, for the popup', async () => {
    const env = setupMoreEnvironment()
    const { loadId } = await env.loadArchived((await env.load('', 'archive')).loadId)
    const saved = env.sessionSetData
      .filter((data) => data.moreArchivedProgress)
      .map((data) => data.moreArchivedProgress)
    assert.ok(saved.length > 0)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(saved.at(-1))), { loadId, done: 4, total: 4 })
    env.sessionSetData.length = 0
    await env.loadArchived((await env.load('org/repo', 'archive')).loadId)
    assert.ok(
      !env.sessionSetData.some((data) => data.moreArchivedProgress),
      'one repo is one request: no progress to show'
    )
  })

  it('lists the disconnected repos too, after the connected ones', async () => {
    const env = setupMoreEnvironment({ settings: { perAccountParallel: 1 } })
    const asked = []
    env.sandbox.callBatchExecute = async (rpc, payload, config) => {
      if (config.accountNum !== '1') return [[]]
      if (rpc === 'YqkSHd') {
        asked.push(`YqkSHd:${payload[1]}`)
        // Row [4]: 1 = connected, 2 = disconnected.
        return [
          [
            ['github/o/gone', null, null, null, 2],
            ['github/o/live', null, null, null, 1],
            ['gitlab/o/other', null, null, null, 1]
          ]
        ]
      }
      asked.push(payload[0])
      return [[[`t-${asked.length}`, 'T', null, null, payload[0].split(' ')[0].slice(10), 3]]]
    }
    const archived = await env.loadArchived((await env.load('', 'archive')).loadId)
    assert.deepStrictEqual(asked, [
      'YqkSHd:null',
      'source_id=github/o/live AND is_archived=true',
      'source_id=github/o/gone AND is_archived=true'
    ])
    assert.deepStrictEqual(
      Array.from(archived.accounts[0].archived, (task) => task.repo),
      ['o/live', 'o/gone']
    )
  })

  it('a disconnected repo can be loaded by name', async () => {
    const env = setupMoreEnvironment()
    const original = env.sandbox.callBatchExecute
    env.sandbox.callBatchExecute = (rpc, payload, config) =>
      rpc === 'YqkSHd'
        ? [payload[1] === null ? [['github/o/Gone', null, null, null, 2]] : []]
        : original(rpc, payload, config)
    await env.loadArchived((await env.load('o/gone', 'archive')).loadId)
    assert.ok(env.calls.some((call) => call.payload[0] === 'source_id=github/o/Gone AND is_archived=true'))
  })

  it("retries a repo's archived list on a 5xx before naming it", async () => {
    const env = setupMoreEnvironment()
    const original = env.sandbox.callBatchExecute
    let failures = 0
    env.sandbox.callBatchExecute = (rpc, payload, config) => {
      if (rpc === 'p1Takd' && payload[0].startsWith('source_id=github/Org/Repo') && config.accountNum === '1') {
        if (failures++ === 0) throw new Error('HTTP 502')
      }
      return original(rpc, payload, config)
    }
    const archived = await env.loadArchived((await env.load('', 'archive')).loadId)
    assert.strictEqual(failures, 2)
    assert.strictEqual(archived.accounts[0].archived.length, 1)
    assert.deepStrictEqual([...archived.accounts[0].notes], [])
  })

  // Timers the test runs by hand; the worker's other timers are not used here.
  function fakeTimers(env) {
    const timers = []
    env.sandbox.setTimeout = (fn, ms) => timers.push({ fn, ms, cleared: false })
    env.sandbox.clearTimeout = (id) => {
      if (timers[id - 1]) timers[id - 1].cleared = true
    }
    timers.run = () => {
      for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn()
    }
    return timers
  }
  const settle = async () => {
    for (let i = 0; i < 200; i++) await Promise.resolve()
  }
  const progressSaves = (env) =>
    env.sessionSetData
      .filter((data) => data.moreArchivedProgress)
      .map((data) => JSON.parse(JSON.stringify(data.moreArchivedProgress)))

  it('saves the count while it lists, at most every 500 ms', async () => {
    const env = setupMoreEnvironment({ settings: { perAccountParallel: 1 } })
    const timers = fakeTimers(env)
    const held = []
    env.sandbox.callBatchExecute = (rpc, _payload, config) => {
      if (config.accountNum !== '1') return [[]]
      if (rpc === 'YqkSHd') return [[['github/o/r0'], ['github/o/r1'], ['github/o/r2']]]
      return new Promise((resolve) => held.push(() => resolve([[]])))
    }
    const { loadId } = await env.load('', 'archive')
    const listing = env.loadArchived(loadId)
    await settle()
    held.shift()()
    await settle()
    assert.deepStrictEqual(
      timers.filter((timer) => !timer.cleared).map((timer) => timer.ms),
      [500],
      'one save waits, however many repos finish meanwhile'
    )
    timers.run()
    assert.deepStrictEqual(progressSaves(env), [{ loadId, done: 1, total: 3 }])
    while (held.length) {
      held.shift()()
      await settle()
    }
    await listing
    assert.deepStrictEqual(progressSaves(env).at(-1), { loadId, done: 3, total: 3 })
  })

  it('stops retrying a repo, and saving its count, once a newer Load replaced the load', async () => {
    const env = setupMoreEnvironment({ settings: { perAccountParallel: 1 } })
    const timers = fakeTimers(env)
    let lists = 0
    env.sandbox.callBatchExecute = async (rpc, _payload, config) => {
      if (config.accountNum !== '1') return [[]]
      if (rpc === 'YqkSHd') return [[['github/o/r0'], ['github/o/r1']]]
      if (rpc === 'hvmRxc') return [[]]
      lists++
      throw new Error('HTTP 502')
    }
    const first = await env.load('', 'archive')
    const late = env.loadArchived(first.loadId)
    await settle()
    assert.strictEqual(lists, 1)
    await env.load('', 'scheduled')
    env.sessionSetData.length = 0
    // The retry's wait ends after the newer Load; so do the count's saves.
    for (let i = 0; i < 5; i++) {
      timers.run()
      await settle()
    }
    assert.match((await late).error, /newer load/i)
    assert.strictEqual(lists, 1, 'no request after the load was replaced')
    assert.deepStrictEqual(progressSaves(env), [])
  })

  it('keeps and answers a listing that Chrome could not save, with a note', async () => {
    const env = setupMoreEnvironment()
    const set = env.sandbox.chrome.storage.session.set
    env.sandbox.chrome.storage.session.set = async (data) => {
      if (data.moreItems?.items.some((item) => item.kind === 'archived')) {
        throw new Error('Session storage quota bytes exceeded.')
      }
      return set(data)
    }
    const { loadId } = await env.load('', 'archive')
    const archived = await env.loadArchived(loadId)
    assert.strictEqual(archived.accounts[0].archived.length, 1)
    assert.deepStrictEqual(
      [...archived.notes],
      [
        'Chrome could not keep this list (Session storage quota bytes exceeded.): it is lost if the extension restarts, so act on it now or load again.'
      ]
    )
    env.calls.length = 0
    await env.apply('unarchive', [{ account: 'u/1', kind: 'archived', id: 'archived' }], true)
    assert.match(env.sandbox.test_state().log.join('\n'), /DRY RUN - would Unarchive \[u\/1\] \[archived\]/)
  })

  it('answers a load that Chrome could not save, with a note', async () => {
    const env = setupMoreEnvironment()
    env.sandbox.chrome.storage.session.set = async (data) => {
      if (data.moreItems) throw new Error('Session storage quota bytes exceeded.')
    }
    const load = await env.load('', 'all')
    assert.strictEqual(load.accounts[0].tasks.length, 4)
    assert.match(load.notes.join(' '), /Chrome could not keep this list/)
  })

  it('a newer Load stops the older All-repos archived listing from asking for more repos', async () => {
    const env = setupMoreEnvironment({ settings: { perAccountParallel: 1 } })
    const sources = Array.from({ length: 6 }, (_, i) => [`github/org/r${i}`])
    const held = []
    let asked = 0
    env.sandbox.callBatchExecute = (rpc, _payload, config) => {
      if (config.accountNum !== '1') return rpc === 'YqkSHd' ? [[]] : [[]]
      if (rpc === 'YqkSHd') return [sources]
      if (rpc === 'hvmRxc') return [[]]
      // Only the first repo's list waits; any later one answers at once.
      if (++asked > 1) return [[]]
      return new Promise((resolve) => held.push(() => resolve([[]])))
    }
    const first = await env.load('', 'archive')
    const late = env.loadArchived(first.loadId)
    for (let i = 0; i < 100; i++) await Promise.resolve()
    assert.strictEqual(asked, 1)
    await env.load('', 'scheduled')
    held.shift()()
    assert.match((await late).error, /newer load/i)
    assert.strictEqual(asked, 1, 'no repo is asked for after the load was replaced')
  })

  it('a Scheduled repo load needs no repo lookup', async () => {
    const env = setupMoreEnvironment()
    await env.load('org/repo', 'scheduled')
    assert.deepStrictEqual([...new Set(listed(env))], ['hvmRxc:'])
  })

  it('an account without that repo gets a note, and its tasks are not listed', async () => {
    const env = setupMoreEnvironment()
    const original = env.sandbox.callBatchExecute
    env.sandbox.callBatchExecute = (rpc, payload, config) => {
      if (rpc === 'YqkSHd' && config.accountNum === '2') {
        env.calls.push({ rpc, payload, account: config.accountNum })
        return [[['github/x/y']]]
      }
      return original(rpc, payload, config)
    }
    const reply = await env.load('org/repo', 'all')
    assert.ok(!env.calls.some((call) => call.rpc === 'p1Takd' && call.account === '2'))
    assert.strictEqual(reply.accounts[1].tasks.length, 0)
    assert.match(reply.accounts[1].notes.join(' '), /u\/2 has no repo org\/repo/)
    assert.strictEqual(reply.accounts[1].schedules.length, 2, 'schedules are still read')
    assert.strictEqual(reply.accounts[0].tasks.length, 3)
  })

  it('uses the repo as typed when the repo list cannot be read', async () => {
    const env = setupMoreEnvironment()
    const original = env.sandbox.callBatchExecute
    env.sandbox.callBatchExecute = (rpc, payload, config) => {
      if (rpc === 'YqkSHd') throw new Error('RPC YqkSHd error code [4]')
      return original(rpc, payload, config)
    }
    const reply = await env.load('org/repo', 'complete')
    assert.ok(
      env.calls.some(
        (call) => call.rpc === 'p1Takd' && call.payload[0] === 'source_id=github/org/repo AND is_archived=false'
      )
    )
    assert.match(reply.accounts[0].notes.join(' '), /Could not read the repos of u\/1.*as typed/)
  })

  it("a one-repo archived listing that fails says so in the account's note", async () => {
    const env = setupMoreEnvironment()
    const original = env.sandbox.callBatchExecute
    env.sandbox.callBatchExecute = (rpc, payload, config) => {
      if (rpc === 'p1Takd' && archivedFilter(payload[0])) throw new Error('RPC p1Takd error code [4]')
      return original(rpc, payload, config)
    }
    const one = await env.loadArchived((await env.load('org/repo', 'archive')).loadId)
    assert.deepStrictEqual(
      [...one.accounts[0].notes],
      ['Jules could not list the archived tasks of u/1: RPC p1Takd error code [4].']
    )
  })

  it('carries the ready-for-review flag and the prompt title of a task', async () => {
    const env = setupMoreEnvironment()
    env.sandbox.callBatchExecute = async (rpc, payload, config) => {
      env.calls.push({ rpc, payload, account: config.accountNum })
      const row = new Array(31).fill(null)
      row[0] = 'review'
      row[2] = 'You are "Bolt" ⚡\nMore'
      row[4] = 'github/org/repo'
      row[5] = 3
      row[12] = true
      return rpc === 'p1Takd' ? [[row]] : []
    }
    const reply = await env.load('', 'complete')
    assert.deepStrictEqual(JSON.parse(JSON.stringify(reply.accounts[0].tasks[0])), {
      id: 'review',
      title: 'You are "Bolt" ⚡',
      state: 3,
      repo: 'org/repo',
      awaitingReview: true
    })
  })
})

describe('More Actions Archive and Force', () => {
  const pick = (...ids) => ids.map((id) => ({ account: 'u/1', kind: 'task', id }))
  function withOpenPR(env, title) {
    env.sandbox.getOpenPRs = async (owner, repo) => {
      env.prChecks.push(`${owner}/${repo}`)
      return [{ title, titleLower: title.toLowerCase(), branch: 'b' }]
    }
  }
  const archivedIds = (env) => env.calls.filter((call) => call.rpc === 'Tjmm5c').flatMap((call) => call.payload[0])

  it('without Force, Archive checks the open PRs and skips a task with one', async () => {
    const env = setupMoreEnvironment()
    withOpenPR(env, 'Title completed')
    await env.load('org/repo')
    env.calls.length = 0
    await env.apply('archive', pick('completed', 'running'))
    assert.deepStrictEqual(env.prChecks, ['Org/Repo'])
    assert.deepStrictEqual(archivedIds(env), ['running'])
    assert.match(env.sandbox.test_state().log.join('\n'), /SKIP \[completed\] Title completed \(matching open PR\)/)
  })

  it('without Force, a repo whose open PRs cannot be read keeps its tasks', async () => {
    const env = setupMoreEnvironment()
    env.sandbox.getOpenPRs = async () => null
    await env.load('org/repo')
    env.calls.length = 0
    await env.apply('archive', pick('completed'))
    assert.deepStrictEqual(archivedIds(env), [])
    assert.match(env.sandbox.test_state().log.join('\n'), /couldn't check its open PRs/)
  })

  it('with Force, Archive skips the open-PR check', async () => {
    const env = setupMoreEnvironment()
    withOpenPR(env, 'Title completed')
    await env.load('org/repo')
    env.calls.length = 0
    await env.apply('archive', pick('completed'), false, true)
    assert.deepStrictEqual(env.prChecks, [])
    assert.deepStrictEqual(archivedIds(env), ['completed'])
    assert.match(env.sandbox.test_state().log.join('\n'), /FORCE/)
  })

  it('a dry run checks the open PRs too and sends nothing', async () => {
    const env = setupMoreEnvironment()
    withOpenPR(env, 'Title completed')
    await env.load('org/repo')
    env.calls.length = 0
    await env.apply('archive', pick('completed', 'running'), true)
    assert.deepStrictEqual(env.calls, [])
    const log = env.sandbox.test_state().log.join('\n')
    assert.match(log, /SKIP \[completed\]/)
    assert.match(log, /would Archive \[u\/1\] \[running\]/)
    assert.doesNotMatch(log, /would Archive \[u\/1\] \[completed\]/)
  })

  it('Run up to N counts the tasks left after the open-PR check', async () => {
    const env = setupMoreEnvironment({ settings: { runLimit: 1 } })
    withOpenPR(env, 'Title completed')
    await env.load('org/repo')
    env.calls.length = 0
    await env.apply('archive', pick('completed', 'running'))
    assert.deepStrictEqual(archivedIds(env), ['running'])
  })

  it('Force means nothing to the other actions', async () => {
    const env = setupMoreEnvironment()
    await env.load()
    env.calls.length = 0
    await env.apply('pauseTask', pick('running'), false, true)
    assert.deepStrictEqual(env.prChecks, [])
    assert.deepStrictEqual(env.calls, [{ rpc: 'tqq5v', payload: ['running'], account: '1' }])
    assert.doesNotMatch(env.sandbox.test_state().log.join('\n'), /FORCE/)
  })

  it('refuses a Force that is not true or false', async () => {
    const env = setupMoreEnvironment()
    await env.load()
    const reply = await moreMessage(env, {
      action: 'APPLY_ACTION',
      protocol: RUN_PROTOCOL,
      operation: 'archive',
      dryRun: false,
      force: 'yes',
      items: []
    })
    assert.match(reply.error, /Invalid action options/)
  })
})

describe('More Actions edge cases', () => {
  it('batches archive and unarchive with the configured batch and split sizes', async () => {
    for (const action of ['archive', 'unarchive']) {
      const env = setupMoreEnvironment()
      await env.sandbox.test_settingsReady()
      env.sandbox.test_julesApi().archiveBatch = 3
      env.sandbox.test_julesApi().archiveSplit = 1
      const original = env.sandbox.callBatchExecute
      let checking = false
      env.sandbox.callBatchExecute = async (rpc, payload, config) => {
        if (rpc === 'p1Takd') {
          env.calls.push({ rpc, payload, account: config.accountNum })
          const ids = checking ? ['a'] : ['a', 'b', 'c', 'd']
          return [ids.map((id) => [id, id, null, null, 'github/org/repo', 3])]
        }
        if (rpc === 'Tjmm5c') {
          env.calls.push({ rpc, payload: JSON.parse(JSON.stringify(payload)), account: config.accountNum })
          if (payload[0].length === 3) throw new Error('RPC Tjmm5c error code [4]')
          return []
        }
        return original(rpc, payload, config)
      }
      await env.loadAll()
      env.calls.length = 0
      checking = true
      await env.apply(
        action,
        ['a', 'b', 'c', 'd'].map((id) => ({ account: 'u/1', kind: action === 'archive' ? 'task' : 'archived', id }))
      )
      const batches = env.calls.filter((call) => call.rpc === 'Tjmm5c').map((call) => call.payload)
      const ids = [['a', 'b', 'c'], ['a'], ['b'], ['c'], ['d']]
      if (action === 'unarchive') ids.push(['b', 'c', 'd'], ['b'], ['c'], ['d'])
      assert.deepStrictEqual(
        batches,
        ids.map((batch) => (action === 'archive' ? [batch, 1] : [batch]))
      )
      // Jules lists only "a" again after the unarchive, so only it counts.
      assert.strictEqual(env.sandbox.test_state().results[0].count, action === 'archive' ? 4 : 1)
    }
  })

  it('keeps empty schedules and failed accounts serializable', async () => {
    const env = setupMoreEnvironment()
    const original = env.sandbox.callBatchExecute
    env.sandbox.callBatchExecute = (rpc, payload, config) => (rpc === 'hvmRxc' ? [] : original(rpc, payload, config))
    env.sandbox.prepareTab = async (tab) => (tab.id === 1 ? null : { config: { accountNum: '2' } })
    const reply = JSON.parse(JSON.stringify(await env.load()))
    assert.strictEqual(reply.accounts[0].tasks.length, 0)
    assert.match(reply.accounts[0].notes[0], /u\/1/)
    assert.deepStrictEqual(reply.accounts[1].schedules, [])
    env.sandbox.getJulesTabs = async () => []
    assert.match((await env.load()).error, /No Jules tabs/)
  })

  it('does not double-count budget skips when an account cannot be prepared', async () => {
    const env = setupMoreEnvironment({ settings: { runLimit: 1 } })
    await env.load()
    env.sandbox.prepareTab = async () => null
    await env.apply(
      'archive',
      ['running', 'completed'].map((id) => ({ account: 'u/1', kind: 'task', id }))
    )
    assert.strictEqual(env.sandbox.test_state().progress.skipped, 2)
    assert.strictEqual(env.sandbox.test_state().progress.total, 2)
  })

  it('continues after an item fails and rejects acted items until the next load', async () => {
    const env = setupMoreEnvironment()
    await env.load()
    const original = env.sandbox.callBatchExecute
    env.sandbox.callBatchExecute = (rpc, payload, config) => {
      if (rpc === 'tqq5v' && config.accountNum === '1') throw new Error('RPC tqq5v error code [4]')
      return original(rpc, payload, config)
    }
    const selected = [1, 2].map((num) => ({ account: `u/${num}`, kind: 'task', id: 'running' }))
    await env.apply('pauseTask', selected)
    assert.strictEqual(env.sandbox.test_state().results[1].count, 1)
    assert.match(env.sandbox.test_state().log.join('\n'), /ERROR.*u\/1.*running/)
    env.calls.length = 0
    await env.apply('pauseTask', [selected[1]])
    assert.strictEqual(env.calls.length, 0)
    assert.match(env.sandbox.test_state().log.join('\n'), /Skipped.*running/)
  })

  it('rejects APPLY_ACTION while running and validates selection shapes', async () => {
    const env = setupMoreEnvironment()
    for (const items of [null, [null], [{ account: 'u/1', kind: 'task', id: 'a', state: 2 }]]) {
      const reply = await moreMessage(env, {
        action: 'APPLY_ACTION',
        protocol: RUN_PROTOCOL,
        operation: 'archive',
        dryRun: true,
        items
      })
      assert.match(reply.error, /Invalid/)
    }
    await env.sandbox.test_stateReadyPromise
    env.sandbox.test_updateState({ status: 'running' })
    assert.match((await env.apply('archive', [])).error, /run.*going/i)
  })
})

describe('More Actions startup locking', () => {
  it('refuses LOAD_ITEMS and APPLY_ACTION while START is waiting for restored state', async () => {
    let release
    const sessionReady = new Promise((resolve) => {
      release = resolve
    })
    const env = setupEnvironment({}, {}, { sessionReady })
    const starting = moreMessage(env, {
      action: 'START',
      protocol: RUN_PROTOCOL,
      options: { action: 'archive', item: 'all', dryRun: true }
    })
    assert.match(
      (await moreMessage(env, { action: 'LOAD_ITEMS', protocol: RUN_PROTOCOL, repo: '' })).error,
      /run.*going/i
    )
    assert.match(
      (
        await moreMessage(env, {
          action: 'APPLY_ACTION',
          protocol: RUN_PROTOCOL,
          operation: 'archive',
          dryRun: true,
          items: []
        })
      ).error,
      /run.*going/i
    )
    release()
    await starting
  })
})

describe('More Actions smoke', () => {
  it('boots the service worker and answers HELLO and GET_STATE', async () => {
    const env = setupEnvironment()
    const hello = await moreMessage(env, { action: 'HELLO' })
    const state = await moreMessage(env, { action: 'GET_STATE' })
    assert.strictEqual(hello.protocol, 5)
    assert.strictEqual(state.status, 'idle')
    assert.ok(Array.isArray(state.log))
  })
})
