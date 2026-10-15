import { Hono } from 'hono'
import { and, eq, gte, lt } from 'drizzle-orm'
import { getWorkspaceDb } from '../db/index.js'
import type { SessionManagerRegistry } from '../agents/session-manager-registry.js'
import { agentSessions } from '../db/schema.js'
import {
  findAndDeleteSessionFile, getSessionDir, fileSegment, loadSessionView, stripTurnStamp,
} from '../sessions/session-store.js'
import { uiLogExists, uiLogPath } from '../sessions/session-log.js'
import { countArchiveSegments } from '../sessions/session-archive.js'
import { findLatestGoal } from '../agents/goal-mode.js'
import { broadcast } from '../ws/broadcast.js'
import { isSafeIdSegment } from './workspace-path.js'
import { hasWorkspaceHalo } from '../init.js'

/** Raw content block — supports both Bedrock and Anthropic API formats */
interface RawContentBlock {
  // Common
  type?: string
  text?: string
  // Bedrock format
  toolUse?: { name: string; toolUseId: string; input: unknown }
  toolResult?: { toolUseId: string; status: string; content: Array<{ text?: string }> }
  // Anthropic format
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}

interface RawMessage {
  role: 'user' | 'assistant'
  content: RawContentBlock[] | string
}

interface DisplayMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  agentName?: string
  toolName?: string
  toolInput?: unknown
  toolOutput?: string
  toolCalls?: Array<{ name: string; input: string; output?: string }>
  contentBlocks?: Array<{ type: string; text?: string; toolCall?: { name: string; input: string; output?: string } }>
}

let msgCounter = 0
function rawId(): string { return `raw_${Date.now().toString(36)}_${(msgCounter++).toString(36)}` }

/** Extract tool use info from a block (Bedrock or Anthropic format) */
function extractToolUse(block: RawContentBlock): { name: string; input: unknown } | null {
  // Bedrock: { toolUse: { name, toolUseId, input } }
  if (block.toolUse) return { name: block.toolUse.name, input: block.toolUse.input }
  // Anthropic: { type: "tool_use", name, id, input }
  if (block.type === 'tool_use' && block.name) return { name: block.name, input: block.input }
  return null
}

/** Extract tool result text from a block (Bedrock or Anthropic format) */
function extractToolResult(block: RawContentBlock): string | null {
  // Bedrock: { toolResult: { toolUseId, status, content: [{ text }] } }
  if (block.toolResult) {
    const content = block.toolResult.content ?? []
    return content.map((c) => c.text ?? '').filter(Boolean).join('\n') || '(no output)'
  }
  // Anthropic: { type: "tool_result", tool_use_id, content: string | [{ type: "text", text }] }
  if (block.type === 'tool_result') {
    const content = block.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return (content as Array<{ text?: string }>).map((c) => c.text ?? '').filter(Boolean).join('\n') || '(no output)'
    }
    return '(no output)'
  }
  return null
}

/** Convert rawMessages to flat display messages (model-agnostic) */
function convertRawMessages(raw: RawMessage[], agentName: string): DisplayMessage[] {
  const result: DisplayMessage[] = []
  const now = Date.now()

  // Ensure there's an assistant message to attach tool calls to
  function ensureAssistant(): DisplayMessage {
    const last = result[result.length - 1]
    if (last && last.role === 'assistant') return last
    const msg: DisplayMessage = { id: rawId(), role: 'assistant', content: '', timestamp: now, agentName, toolCalls: [], contentBlocks: [] }
    result.push(msg)
    return msg
  }

  for (const msg of raw) {
    const blocks = Array.isArray(msg.content) ? msg.content : [{ text: msg.content }]

    if (msg.role === 'user') {
      const texts: string[] = []
      for (const block of blocks) {
        if (block.text && !block.toolResult && block.type !== 'tool_result') {
          // Arrival stamp first — the prefix regexes below are ^-anchored and a
          // sub-session opening turn reads `[<iso>] [Session …]`.
          const text = stripTurnStamp(block.text)
            .replace(/^\[Session [^\]]+\]\s*\n*/i, '')
            .replace(/^\[(?:Message|Report) from [^\]]+\]\s*\n*/i, '')
            .trim()
          if (text) texts.push(text)
        }
        const toolResultText = extractToolResult(block)
        if (toolResultText !== null) {
          // Find last tool call without output and fill it
          for (let i = result.length - 1; i >= 0; i--) {
            const m = result[i]
            if (m.toolCalls?.length) {
              const lastTc = m.toolCalls[m.toolCalls.length - 1]
              if (!lastTc.output) {
                lastTc.output = toolResultText
                // Also update contentBlocks
                if (m.contentBlocks) {
                  for (let j = m.contentBlocks.length - 1; j >= 0; j--) {
                    const cb = m.contentBlocks[j] as { type: string; toolCall?: { output?: string } }
                    if (cb.type === 'tool_call' && cb.toolCall && !cb.toolCall.output) {
                      cb.toolCall.output = toolResultText
                      break
                    }
                  }
                }
                break
              }
            }
          }
        }
      }
      if (texts.length > 0) {
        result.push({ id: rawId(), role: 'user', content: texts.join('\n'), timestamp: now })
      }
    } else {
      for (const block of blocks) {
        const toolUse = extractToolUse(block)
        if (toolUse) {
          const assistant = ensureAssistant()
          const inputStr = typeof toolUse.input === 'string' ? toolUse.input : JSON.stringify(toolUse.input ?? {})
          const tc = { name: toolUse.name, input: inputStr }
          if (!assistant.toolCalls) assistant.toolCalls = []
          assistant.toolCalls.push(tc)
          if (!assistant.contentBlocks) assistant.contentBlocks = []
          assistant.contentBlocks.push({ type: 'tool_call', toolCall: tc })
        } else if (block.text) {
          const assistant = ensureAssistant()
          if (!assistant.contentBlocks) assistant.contentBlocks = []
          assistant.contentBlocks.push({ type: 'text', text: block.text })
          assistant.content = (assistant.content ? assistant.content + block.text : block.text)
        }
      }
    }
  }

  return result
}

export function createSessionRoutes(smRegistry?: SessionManagerRegistry) {
  const app = new Hono()

  // ── Session logs (db-driven listing, jsonl per-row enrichment) ──

  // GET /sessions/logs?projectId=&cursor=&limit=&includeArchived=&parentId=
  //   - parentId omitted   → top-level only (parent_id IS NULL)
  //   - parentId='<sid>'   → direct children of that session
  //   - parentId='*'       → no parent filter (all depths, used by archive UI)
  //   - cursor (epoch ms)  → keyset pagination on updated_at
  //   - limit (default 50, max 500)
  // Returns { sessions, nextCursor }. nextCursor is null when this is the
  // last page.
  app.get('/sessions/logs', (c) => {
    const projectId = c.req.query('projectId')
    const includeArchived = c.req.query('includeArchived') === '1'
    const parentIdParam = c.req.query('parentId')
    const rootOnly = c.req.query('rootOnly') === '1'
    const cursorRaw = c.req.query('cursor')
    const limitRaw = c.req.query('limit')

    if (!smRegistry) return c.json({ error: 'session manager not initialized' }, 500)
    if (!projectId) return c.json({ error: 'projectId required' }, 400)
    // A list must not turn a directory into a workspace (getOrCreate scaffolds
    // `.halo/` and builds a SessionManager): no `.halo/` → no sessions.
    if (!hasWorkspaceHalo(projectId)) return c.json({ sessions: [], nextCursor: null })

    const sm = smRegistry.getOrCreate(projectId)

    // parentId semantics:
    //   undefined        → opts.parentId = null (top-level)
    //   '*'              → opts.parentId = undefined (any)
    //   '<sid>'          → opts.parentId = sid
    let parentId: string | null | undefined
    if (parentIdParam === undefined) parentId = null
    else if (parentIdParam === '*') parentId = undefined
    else parentId = parentIdParam

    const cursor = cursorRaw ? parseInt(cursorRaw, 10) : undefined
    const limit = limitRaw ? parseInt(limitRaw, 10) : 50

    const { sessions: rows, nextCursor } = sm.listSessions({
      // rootOnly callers (the chat-header dropdown) page through roots alone;
      // the default path keeps parentId semantics for the tree-building sidebar.
      ...(rootOnly ? { rootOnly: true } : { parentId }),
      cursor: Number.isFinite(cursor as number) ? (cursor as number) : undefined,
      limit: Number.isFinite(limit) ? limit : 50,
      includeArchived,
    })

    // When the request is asking for top-level sessions (the default —
    // admin sidebar), eagerly include every descendant so the UI can
    // build the whole tree without per-expand round-trips. Hierarchical
    // id format `root>child>...` lets us do a single indexed range scan
    // per root, so this stays O(page_size) regardless of subtree depth.
    // rootOnly mode wants roots alone (flat dropdown), so skip this.
    const includeDescendants = !rootOnly && parentId === null
    const descendants = includeDescendants
      ? sm.listDescendants(rows.map((s) => s.id), { includeArchived })
      : []

    const { db, workspacePath } = getWorkspaceDb(projectId)

    // Per-row metadata comes from the db columns — no file reads.
    // `exchangeCount === null` means the row predates them and its session may
    // still be a 1.x file: probing the UI log migrates it (back-filling the
    // row's NULL columns), then the row is read again. Once per session. A
    // failed conversion (logged by the migrator) leaves that one row
    // un-enriched; the list still answers.
    const probe = (s: typeof rows[number]) => {
      try { return uiLogExists(uiLogPath(getSessionDir(s.agentId, workspacePath), fileSegment(s.id))) } catch { return false }
    }
    const enrich = (row: typeof rows[number]) => {
      let s = row
      if (s.exchangeCount === null && probe(s)) {
        const fresh = db.select().from(agentSessions).where(eq(agentSessions.id, s.id)).get()
        if (fresh) s = { ...s, title: fresh.title, exchangeCount: fresh.exchangeCount, contextTokens: fresh.contextTokens, totalOutputTokens: fresh.totalOutputTokens }
      }
      const title = s.title ?? ''
      const exchangeCount = s.exchangeCount
      const contextTokens = s.contextTokens ?? 0
      const totalOutputTokens = s.totalOutputTokens ?? 0
      return {
        id: s.id,
        agentId: s.agentId,
        agentName: s.agentName,
        title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        exchangeCount: exchangeCount ?? 0,
        parentSessionId: s.parentId ?? undefined,
        stoppedAt: s.stoppedAt,
        archivedAt: s.archivedAt,
        contextTokens,
        totalOutputTokens,
        // Goal-mode: non-null while this session is the bound worker of an
        // active goal — session lists render a 🎯 badge off this.
        goalSessionId: s.goalSessionId,
        // Persisted working dir (workspace-relative; null = root) — the cron
        // form prefills a picked session's folder from it.
        workingDir: s.workingDir,
        // Running flag for an Explorer chat tab that hasn't loaded yet (a
        // loaded tab tracks its own stream). A root with a running sub-session
        // counts as running.
        status: s.status,
      }
    }

    const enriched = [...rows.map(enrich), ...descendants.map(enrich)]
    return c.json({ sessions: enriched, nextCursor })
  })

  // GET /sessions/logs/:id?projectId=xxx — get full session log by ID: the
  // session's row (metadata) + its active UI log and raw history.
  app.get('/sessions/logs/:id', (c) => {
    const id = c.req.param('id')
    if (!isSafeIdSegment(id)) return c.json({ error: 'Invalid session id' }, 400)
    const projectId = c.req.query('projectId')
    // 1.x scanned the workspace's session dirs; the row now names the dir.
    if (!projectId) return c.json({ error: 'Session not found' }, 404)
    const { db, workspacePath } = getWorkspaceDb(projectId)
    let row = db.select().from(agentSessions).where(eq(agentSessions.id, id)).get()
    if (!row) return c.json({ error: 'Session not found' }, 404)
    const view = loadSessionView(id, row.agentId, workspacePath)
    if (!view) return c.json({ error: 'Session not found' }, 404)
    // Opening a 1.x session's log migrates it and back-fills the row's NULL
    // columns (exchangeCount NULL = predates them) — answer with the fresh row.
    if (row.exchangeCount === null) row = db.select().from(agentSessions).where(eq(agentSessions.id, id)).get() ?? row

    const agentName = row.agentName || row.agentId
    // Only convert rawMessages when the UI log is empty (sub-agent sessions
    // that were only tracked via session-manager).
    const messages = view.messages.length > 0 || view.rawMessages.length === 0
      ? view.messages
      : convertRawMessages(view.rawMessages as RawMessage[], agentName)
    return c.json({
      id: row.id,
      agentId: row.agentId,
      agentName,
      title: row.title ?? '',
      source: row.parentId ? 'delegated' : 'explorer',
      ...(row.parentId ? { parentSessionId: row.parentId } : {}),
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
      messageCount: view.messages.length,
      exchangeCount: row.exchangeCount ?? 0,
      contextTokens: row.contextTokens ?? 0,
      totalOutputTokens: row.totalOutputTokens ?? 0,
      archiveCount: countArchiveSegments(getSessionDir(row.agentId, workspacePath), fileSegment(id)),
      messages,
      rawMessages: view.rawMessages,
      ...(row.output !== null ? { output: row.output } : {}),
      ...(row.lastActivityAt !== null ? { lastActivityAt: row.lastActivityAt } : {}),
    })
  })

  // DELETE /sessions/logs/:id?projectId=xxx — permanently delete a session.
  // Cascades to all descendants: removes log files AND SQLite rows.
  // The WS session:delete command does the same hard delete.
  app.delete('/sessions/logs/:id', async (c) => {
    const id = c.req.param('id')
    if (!isSafeIdSegment(id)) return c.json({ error: 'Invalid session id' }, 400)
    const projectId = c.req.query('projectId')
    if (!projectId) return c.json({ error: 'projectId required' }, 400)

    const { workspacePath } = getWorkspaceDb(projectId)

    // Route through SessionManager when available so it can:
    //   - abort any in-flight runs for these sessions,
    //   - clear in-memory uiStates / debounced persist timers,
    //   - mark tombstones so racing background saves don't resurrect files.
    // Without this, a pending `chat:complete`-triggered WS save can write
    // the deleted session right back to disk after we remove it.
    let allIds: string[]
    if (smRegistry) {
      const sm = smRegistry.getOrCreate(workspacePath)
      allIds = await sm.deleteSession(id)
    } else {
      const { db } = getWorkspaceDb(projectId)
      // Path-encoded id range = the whole subtree; canonical form is SessionQueryStore.listDescendantIds.
      allIds = [id, ...db.select({ id: agentSessions.id }).from(agentSessions)
        .where(and(gte(agentSessions.id, id + '>'), lt(agentSessions.id, id + '>￿'))).all().map((r) => r.id)]
      for (const sid of allIds) {
        db.delete(agentSessions).where(eq(agentSessions.id, sid)).run()
      }
    }

    for (const sid of allIds) {
      await findAndDeleteSessionFile(sid, workspacePath)
    }
    return c.json({ ok: true, deleted: allIds.length })
  })

  // PATCH /sessions/logs/:id?projectId=xxx — rename a session's title. The
  // row is the title's only home. Admin-only edit (no channel exposes this).
  app.patch('/sessions/logs/:id', async (c) => {
    const id = c.req.param('id')
    if (!isSafeIdSegment(id)) return c.json({ error: 'Invalid session id' }, 400)
    const projectId = c.req.query('projectId')
    if (!projectId) return c.json({ error: 'projectId required' }, 400)
    const body = await c.req.json<{ title?: string }>().catch(() => ({} as { title?: string }))
    const title = body.title?.trim()
    if (!title) return c.json({ error: 'title required' }, 400)

    const { db } = getWorkspaceDb(projectId)
    const updated = db.update(agentSessions).set({ title }).where(eq(agentSessions.id, id)).run()
    if (updated.changes === 0) return c.json({ error: 'Session not found' }, 404)
    // Push so every admin session list re-fetches the new title live.
    broadcast({ type: 'session:changed' })
    return c.json({ ok: true })
  })

  // GET /sessions/goal?projectId=xxx — latest goal binding for the workspace
  // (goals are serialized per workspace, so "the" goal is unambiguous).
  // Refresh seed for the admin's goal banner / input lock: `goal:changed` WS
  // pushes keep a live tab current, this endpoint restores the state after a
  // page reload. `cleared` is a dismissed record, not a displayable state.
  app.get('/sessions/goal', (c) => {
    const projectId = c.req.query('projectId')
    if (!projectId) return c.json({ error: 'projectId required' }, 400)
    const { db } = getWorkspaceDb(projectId)
    const latest = findLatestGoal(db)
    if (!latest || latest.state.status === 'cleared') return c.json({ goal: null })
    return c.json({
      goal: {
        goalSessionId: latest.goalSessionId,
        workerSessionId: latest.state.workerSessionId,
        status: latest.state.status,
        round: latest.state.round,
        maxRounds: latest.state.caps.maxRounds,
      },
    })
  })

  return app
}
