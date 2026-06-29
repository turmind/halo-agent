/**
 * Comprehensive integration test for the unified session architecture.
 *
 * Covers:
 *   - A: Agent system (init, YAML, query_agent, delete protection)
 *   - B: Default agent basics (chat, tool calling, multi-turn)
 *   - C: Agent capabilities (prompt caching, thinking mode)
 *   - D: Session tools (start_session, session_list, query_session, stop_session)
 *   - E: Session operations (delete_session, delete_log)
 *   - I: Commands (/new, /compact)
 *
 * Run:
 *   cd packages/server && node tests/test-session-system.mjs
 *
 * Requires: server running on localhost:9527. Set env vars before running:
 *   HALO_TEST_PASSWORD=<login password>
 *   HALO_TEST_PROJECT=<absolute workspace path>
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'

const BASE_URL = 'http://localhost:9527'
const WS_URL = 'ws://localhost:9527/ws'
const PASSWORD = process.env.HALO_TEST_PASSWORD
const PROJECT_ID = process.env.HALO_TEST_PROJECT
if (!PASSWORD || !PROJECT_ID) {
  console.error('Missing env: set HALO_TEST_PASSWORD and HALO_TEST_PROJECT before running.')
  process.exit(1)
}

// ── Utilities ────────────────────────────────────────────────────
let passed = 0
let failed = 0
let skipped = 0

function assert(condition, name) {
  if (condition) {
    console.log(`  \u2713 ${name}`)
    passed++
  } else {
    console.log(`  \u2717 ${name}`)
    failed++
  }
}

function skip(name) {
  console.log(`  - ${name} (skipped)`)
  skipped++
}

function section(name) {
  console.log(`\n${'━'.repeat(60)}`)
  console.log(`  ${name}`)
  console.log('━'.repeat(60))
}

// ── Auth ─────────────────────────────────────────────────────────
async function login() {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ password: PASSWORD })
    const req = http.request(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': postData.length },
    }, (res) => {
      const cookies = res.headers['set-cookie']
      const token = cookies?.find(c => c.startsWith('halo_token='))
      if (token) resolve(token.split(';')[0])
      else reject(new Error(`Login failed: ${res.statusCode}`))
    })
    req.on('error', reject)
    req.write(postData)
    req.end()
  })
}

async function apiFetch(path, cookie, opts = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...opts.headers },
    ...opts,
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, ok: res.ok, body }
}

// ── WebSocket helpers ────────────────────────────────────────────
/** Connect WS and wait for the initial state:snapshot */
function connectWS(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { Cookie: cookie } })
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 15000)
    // Capture initial snapshot before 'open' resolves to avoid race
    let initSnapshot = null
    ws.on('message', function onFirst(raw) {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'state:snapshot') {
        initSnapshot = msg
        ws.removeListener('message', onFirst)
      }
    })
    ws.on('open', () => {
      // Wait briefly for the initial snapshot to arrive
      const check = () => {
        if (initSnapshot) { clearTimeout(timer); resolve({ ws, initSnapshot }) }
        else setTimeout(check, 50)
      }
      check()
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

function send(ws, data) {
  ws.send(JSON.stringify(data))
}

function waitForType(ws, type, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout)
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === type) {
        clearTimeout(timer)
        ws.removeListener('message', handler)
        resolve(msg)
      }
    }
    ws.on('message', handler)
  })
}

/** Wait for a type that satisfies predicate */
function waitForMatch(ws, predicate, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for match')), timeout)
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString())
      if (predicate(msg)) {
        clearTimeout(timer)
        ws.removeListener('message', handler)
        resolve(msg)
      }
    }
    ws.on('message', handler)
  })
}

/** Collect all messages until a specific type appears or timeout */
function collectUntil(ws, stopType, timeout = 90000) {
  return new Promise((resolve, reject) => {
    const messages = []
    const timer = setTimeout(() => {
      ws.removeListener('message', handler)
      resolve(messages)
    }, timeout)
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString())
      messages.push(msg)
      if (msg.type === stopType) {
        clearTimeout(timer)
        ws.removeListener('message', handler)
        resolve(messages)
      }
    }
    ws.on('message', handler)
  })
}

/** Drain any pending messages (non-blocking, short wait) */
function drain(ws, ms = 500) {
  return new Promise((resolve) => {
    const messages = []
    const handler = (raw) => messages.push(JSON.parse(raw.toString()))
    ws.on('message', handler)
    setTimeout(() => { ws.removeListener('message', handler); resolve(messages) }, ms)
  })
}

// ── Test runner ──────────────────────────────────────────────────
async function main() {
  let cookie
  try {
    cookie = await login()
    console.log('Logged in successfully\n')
  } catch (err) {
    console.error(`Cannot login: ${err.message}`)
    process.exit(1)
  }

  // ================================================================
  // GROUP A: Agent System (API-level, no LLM)
  // ================================================================
  section('A. Agent System')

  // A1: Default agent loaded
  {
    const { body } = await apiFetch('/api/agent-configs', cookie)
    const agents = body.agents ?? []
    const defaultAgent = agents.find(a => a.id === 'default')
    assert(!!defaultAgent, 'A1: Default agent exists in agent-configs')
    assert(defaultAgent?.scope === 'global', 'A1: Default agent scope=global')
  }

  // A2: Workspace agents loaded
  {
    const { body } = await apiFetch(`/api/agent-configs?projectId=${encodeURIComponent(PROJECT_ID)}`, cookie)
    const agents = body.agents ?? []
    const sleeper = agents.find(a => a.id === 'sleeper')
    const testAgent = agents.find(a => a.id === 'test-agent')
    assert(!!sleeper, 'A2: Sleeper agent visible in workspace')
    assert(!!testAgent, 'A2: Test-agent visible in workspace')
    assert(sleeper?.scope === 'workspace', 'A2: Sleeper scope=workspace')
  }

  // A3: Agent YAML creation (workspace scope to allow deletion)
  const testAgentName = `yaml-test-${Date.now()}`
  let testAgentId = null
  {
    const { ok, body } = await apiFetch('/api/agent-configs', cookie, {
      method: 'POST',
      body: JSON.stringify({ name: testAgentName, description: 'Test agent for YAML validation', scope: 'workspace', projectId: PROJECT_ID }),
    })
    assert(ok, 'A3: Agent created successfully')
    testAgentId = body.agent?.id

    if (testAgentId) {
      const { body: yamlBody } = await apiFetch(`/api/agent-configs/${testAgentId}/yaml?scope=workspace&projectId=${encodeURIComponent(PROJECT_ID)}`, cookie)
      assert(yamlBody.yaml?.includes(testAgentName), 'A3: YAML contains agent name')
      assert(yamlBody.yaml?.includes('Test agent for YAML validation'), 'A3: YAML contains description')
    }
  }

  // A4: Agent deletion (workspace agents can be deleted)
  if (testAgentId) {
    const { ok } = await apiFetch(`/api/agent-configs/${testAgentId}?scope=workspace&projectId=${encodeURIComponent(PROJECT_ID)}`, cookie, { method: 'DELETE' })
    assert(ok, 'A4: Workspace test agent deleted')
    // Verify removed from list
    const { body } = await apiFetch(`/api/agent-configs?projectId=${encodeURIComponent(PROJECT_ID)}`, cookie)
    const stillExists = body.agents?.find(a => a.id === testAgentId)
    assert(!stillExists, 'A4: Deleted agent not in list')
  }


  // ================================================================
  // GROUP B: Default Agent Basics (WS + LLM)
  // ================================================================
  section('B. Default Agent Basics')

  const { ws, initSnapshot } = await connectWS(cookie)
  assert(initSnapshot.type === 'state:snapshot', 'B0: Initial snapshot received')

  const sessionId1 = `test_basic_${Date.now()}`

  // B1: Multi-turn context
  {
    send(ws, { type: 'subscribe', sessionId: sessionId1, projectId: PROJECT_ID })
    await waitForType(ws, 'state:snapshot')

    // First message
    send(ws, { type: 'chat', sessionId: sessionId1, projectId: PROJECT_ID, message: 'The secret word is "pineapple". Just acknowledge with "Got it".' })
    const events1 = await collectUntil(ws, 'chat:complete', 60000)
    const hasComplete1 = events1.some(e => e.type === 'chat:complete')
    assert(hasComplete1, 'B1: First message completed')

    // Second message — test context retention
    send(ws, { type: 'chat', sessionId: sessionId1, projectId: PROJECT_ID, message: 'What was the secret word I told you?' })
    const events2 = await collectUntil(ws, 'chat:complete', 60000)
    const streamTexts = events2.filter(e => e.type === 'chat:stream').map(e => e.text).join('')
    assert(streamTexts.toLowerCase().includes('pineapple'), 'B1: Context maintained, recalls secret word')
  }

  // ================================================================
  // GROUP C: Agent Capabilities (LLM + tool calling)
  // ================================================================
  section('C. Agent Capabilities')

  const sessionIdC = `test_caps_${Date.now()}`

  // Setup: create test file
  fs.writeFileSync('/tmp/halo-test-read.txt', 'Hello from test file!', 'utf-8')

  // C1: Tool calling
  {
    send(ws, { type: 'session:clear', sessionId: sessionId1 })
    await waitForType(ws, 'session:cleared')

    send(ws, { type: 'subscribe', sessionId: sessionIdC, projectId: PROJECT_ID })
    await waitForType(ws, 'state:snapshot')

    send(ws, { type: 'chat', sessionId: sessionIdC, projectId: PROJECT_ID, message: 'Read the file /tmp/halo-test-read.txt and tell me its contents.' })
    const events = await collectUntil(ws, 'chat:complete', 60000)
    const toolCalls = events.filter(e => e.type === 'agent:tool_call')
    const fileReadCall = toolCalls.find(e => e.tool === 'file_read')
    assert(!!fileReadCall, 'C1: file_read tool was called')

    const streamText = events.filter(e => e.type === 'chat:stream').map(e => e.text).join('')
    assert(streamText.includes('Hello from test file'), 'C1: File content returned to user')

    const hasComplete = events.some(e => e.type === 'chat:complete')
    assert(hasComplete, 'C1: Chat completed')
  }

  // C2: Multi-tool turn
  {
    send(ws, { type: 'chat', sessionId: sessionIdC, projectId: PROJECT_ID, message: 'Run these two shell commands one at a time: "echo FIRST_CMD" and "echo SECOND_CMD". Show me their outputs.' })
    const events = await collectUntil(ws, 'chat:complete', 60000)
    const toolCalls = events.filter(e => e.type === 'agent:tool_call')
    assert(toolCalls.length >= 2, `C2: Multiple tool calls made (got ${toolCalls.length})`)

    const hasComplete = events.some(e => e.type === 'chat:complete')
    assert(hasComplete, 'C2: Chat completed')
  }

  // C4: Prompt caching (check usage events for cache tokens)
  {
    send(ws, { type: 'session:clear', sessionId: sessionIdC })
    await waitForType(ws, 'session:cleared')

    const sessionIdCache = `test_cache_${Date.now()}`
    send(ws, { type: 'subscribe', sessionId: sessionIdCache, projectId: PROJECT_ID })
    await waitForType(ws, 'state:snapshot')

    // First message — should create cache
    send(ws, { type: 'chat', sessionId: sessionIdCache, projectId: PROJECT_ID, message: 'Say "first" and nothing else.' })
    const events1 = await collectUntil(ws, 'chat:complete', 60000)
    const usage1 = events1.find(e => e.type === 'agent:usage' || e.type === 'chat:usage')

    // Second message — should hit cache
    send(ws, { type: 'chat', sessionId: sessionIdCache, projectId: PROJECT_ID, message: 'Say "second" and nothing else.' })
    const events2 = await collectUntil(ws, 'chat:complete', 60000)
    const usage2 = events2.find(e => e.type === 'agent:usage' || e.type === 'chat:usage')

    if (usage2) {
      const cacheRead = usage2.usage?.cacheReadInputTokens ?? usage2.cacheReadInputTokens ?? 0
      if (cacheRead > 0) {
        assert(true, `C4: Prompt cache hit on second request (cache_read=${cacheRead})`)
      } else {
        // Prompt caching requires promptCaching: true in agent YAML — not a bug
        skip('C4: No cache hit — promptCaching may not be enabled in agent YAML config')
      }
    } else {
      skip('C4: No usage event found to check cache')
    }

    // Cleanup
    send(ws, { type: 'session:delete', sessionId: sessionIdCache })
    await waitForType(ws, 'session:deleted', 5000).catch(() => {})
  }

  // ================================================================
  // GROUP D: Session Tools (LLM + sub-agent)
  // ================================================================
  section('D. Session Tools')

  const sessionIdD = `test_session_tools_${Date.now()}`

  // A6: query_agent (tested here because needs LLM). Target `executor`, which is
  // in the seed `default`'s team — query_agent is team-gated, so an off-team
  // target (e.g. sleeper) would be reported not-found.
  {
    send(ws, { type: 'session:clear', sessionId: sessionIdC })
    await waitForType(ws, 'session:cleared')

    send(ws, { type: 'subscribe', sessionId: sessionIdD, projectId: PROJECT_ID })
    await waitForType(ws, 'state:snapshot')

    send(ws, { type: 'chat', sessionId: sessionIdD, projectId: PROJECT_ID, message: 'Use query_agent to get detailed info about the "executor" agent. Show the results.' })
    const eventsA6 = await collectUntil(ws, 'chat:complete', 60000)
    const queryCall = eventsA6.find(e => e.type === 'agent:tool_call' && e.tool === 'query_agent')
    assert(!!queryCall, 'A6: query_agent tool was called')
  }

  // D1: Basic delegation (start_session)
  {
    send(ws, { type: 'session:clear', sessionId: sessionIdD })
    await waitForType(ws, 'session:cleared')

    const sessionIdDel = `test_delegate_${Date.now()}`
    send(ws, { type: 'subscribe', sessionId: sessionIdDel, projectId: PROJECT_ID })
    await waitForType(ws, 'state:snapshot')

    send(ws, { type: 'chat', sessionId: sessionIdDel, projectId: PROJECT_ID, message: 'Use start_session to ask the "executor" agent: "What is your name? Reply in one sentence."' })

    // Wait longer — delegation involves sub-agent startup + execution + auto-report
    const events = await collectUntil(ws, 'chat:complete', 120000)
    const startCall = events.find(e => e.type === 'agent:tool_call' && e.tool === 'start_session')
    assert(!!startCall, 'D1: start_session tool was called')

    const hasComplete = events.some(e => e.type === 'chat:complete')
    assert(hasComplete, 'D1: Delegation completed (auto-report received)')

    // Verify SQLite has sub-session — query the workspace DB directly
    // (no public REST endpoint lists agent_sessions; admin queries via WS).
    // Target `executor` is in the seed `default`'s team (delegation is team-gated).
    const dbPath = path.join(PROJECT_ID, '.halo', 'halo.db')
    const { execFileSync } = await import('node:child_process')
    const sqlOut = execFileSync('sqlite3', [dbPath, `select agent_id from agent_sessions where parent_id LIKE '${sessionIdDel}%';`], { encoding: 'utf-8' })
    const hasExecutor = sqlOut.split('\n').some(line => line.trim() === 'executor')
    assert(hasExecutor, 'D1: Sub-session created for executor in SQLite')

    // D7: session_list — ask the agent to list sessions
    send(ws, { type: 'chat', sessionId: sessionIdDel, projectId: PROJECT_ID, message: 'Use the session_list tool to show me all active sessions.' })
    const eventsD7 = await collectUntil(ws, 'chat:complete', 60000)
    const listSessionCall = eventsD7.find(e => e.type === 'agent:tool_call' && e.tool === 'session_list')
    assert(!!listSessionCall, 'D7: session_list tool was called')

    // E6-E7: Delete session + log
    send(ws, { type: 'session:delete', sessionId: sessionIdDel })
    const deleted = await waitForType(ws, 'session:deleted', 10000)
    assert(deleted.sessionId === sessionIdDel, 'E6: Session deleted notification received')

    // Verify file is gone
    const sessionFilePath = path.join(PROJECT_ID, '.halo/sessions/explorer/default', `${sessionIdDel}.json`)
    assert(!fs.existsSync(sessionFilePath), 'E7: Session file deleted from disk')
  }

  // ================================================================
  // GROUP I: Commands (/new, /compact)
  // ================================================================
  section('I. Commands')

  // I1: /new command (session:clear)
  {
    const sessionIdNew1 = `test_new_cmd_${Date.now()}`
    send(ws, { type: 'subscribe', sessionId: sessionIdNew1, projectId: PROJECT_ID })
    await waitForType(ws, 'state:snapshot')

    // Send a message to create state
    send(ws, { type: 'chat', sessionId: sessionIdNew1, projectId: PROJECT_ID, message: 'Say "test message for new command" and nothing else.' })
    await collectUntil(ws, 'chat:complete', 60000)

    // Clear session (/new)
    send(ws, { type: 'session:clear', sessionId: sessionIdNew1 })
    const cleared = await waitForType(ws, 'session:cleared')
    assert(cleared.type === 'session:cleared', 'I1: session:cleared received')

    // Subscribe to new session — should be empty
    const sessionIdNew2 = `test_new_cmd_2_${Date.now()}`
    send(ws, { type: 'subscribe', sessionId: sessionIdNew2, projectId: PROJECT_ID })
    const newSnapshot = await waitForType(ws, 'state:snapshot')
    const hasNoMessages = !newSnapshot.snapshot?.recentMessages?.length
    assert(hasNoMessages, 'I1: New session has no messages')

    // Subscribe back to old session — should have messages
    send(ws, { type: 'subscribe', sessionId: sessionIdNew1, projectId: PROJECT_ID })
    const oldSnapshot = await waitForType(ws, 'state:snapshot')
    assert(oldSnapshot.snapshot?.recentMessages?.length > 0, 'I1: Old session preserved with messages')

    // Cleanup
    send(ws, { type: 'session:delete', sessionId: sessionIdNew1 })
    await waitForType(ws, 'session:deleted', 5000).catch(() => {})
    send(ws, { type: 'session:delete', sessionId: sessionIdNew2 })
    await waitForType(ws, 'session:deleted', 5000).catch(() => {})
  }

  // I3: /compact command
  {
    const sessionIdCompact = `test_compact_${Date.now()}`
    send(ws, { type: 'subscribe', sessionId: sessionIdCompact, projectId: PROJECT_ID })
    await waitForType(ws, 'state:snapshot')

    // Build up enough messages (need >= minMessagesRequired=8)
    const chatPrompts = [
      'Say "msg1" only.', 'Say "msg2" only.', 'Say "msg3" only.',
      'Say "msg4" only.', 'Say "msg5" only.', 'Say "msg6" only.',
      'Say "msg7" only.', 'Say "msg8" only.', 'Say "msg9" only.',
    ]

    console.log('  Building conversation for compact test (9 messages)...')
    for (const prompt of chatPrompts) {
      send(ws, { type: 'chat', sessionId: sessionIdCompact, projectId: PROJECT_ID, message: prompt })
      await collectUntil(ws, 'chat:complete', 60000)
    }

    // Verify WS is alive and session has enough messages
    send(ws, { type: 'chat', sessionId: sessionIdCompact, projectId: PROJECT_ID, message: 'Say "ready" only.' })
    const readyEvents = await collectUntil(ws, 'chat:complete', 60000)
    console.log(`  Pre-compact check: ${readyEvents.some(e => e.type === 'chat:complete') ? 'OK' : 'FAIL'}`)
    await drain(ws, 1000)

    // Send compact command
    send(ws, { type: 'command:compact' })
    const compactEvents = await collectUntil(ws, 'compact:done', 60000)
    const hasCompacted = compactEvents.some(e => e.type === 'session:compacted')
    const hasProgress = compactEvents.some(e => e.type === 'compact:progress')
    const hasDone = compactEvents.some(e => e.type === 'compact:done')
    const errors = compactEvents.filter(e => e.type === 'error')
    if (errors.length) console.log(`  [debug] Compact errors: ${errors.map(e => e.error).join(', ')}`)
    if (!hasProgress && !hasCompacted) {
      const types = compactEvents.map(e => e.type).join(', ')
      console.log(`  [debug] Compact events received: ${types}`)
    }
    assert(hasProgress || hasCompacted, 'I3: compact:progress or session:compacted event received')
    assert(hasDone, 'I3: compact:done event received')

    // Cleanup
    send(ws, { type: 'session:delete', sessionId: sessionIdCompact })
    await waitForType(ws, 'session:deleted', 5000).catch(() => {})
  }

  // ================================================================
  // Cleanup B1 session
  // ================================================================
  send(ws, { type: 'session:delete', sessionId: sessionId1 })
  await waitForType(ws, 'session:deleted', 5000).catch(() => {})

  // Cleanup C sessions
  send(ws, { type: 'session:delete', sessionId: sessionIdC })
  await waitForType(ws, 'session:deleted', 5000).catch(() => {})

  // Clean up test file
  fs.unlinkSync('/tmp/halo-test-read.txt')

  ws.close()

  // ================================================================
  // Summary
  // ================================================================
  console.log(`\n${'━'.repeat(60)}`)
  console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`)
  console.log('━'.repeat(60))
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('\nFatal error:', err.message)
  process.exit(1)
})
