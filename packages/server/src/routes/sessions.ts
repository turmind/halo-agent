import { Hono } from 'hono'
import { and, eq, gte, lt } from 'drizzle-orm'
import { getWorkspaceDb, mirrorSessionMeta } from '../db/index.js'
import type { SessionManagerRegistry } from '../agents/session-manager-registry.js'
import { agentSessions } from '../db/schema.js'
import { findSessionFileData, findAndDeleteSessionFile, findAndUpdateSessionTitle, readSessionFileMeta, stripTurnStamp } from '../sessions/session-store.js'
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

    // Per-row metadata comes from the mirrored db columns — no file reads.
    // `exchangeCount === null` means the row predates those columns, so read
    // the file once and mirror it back; subsequent pages hit the db.
    const enrich = (s: typeof rows[number]) => {
      let title = s.title ?? ''
      let exchangeCount = s.exchangeCount
      let contextTokens = s.contextTokens ?? 0
      let totalOutputTokens = s.totalOutputTokens ?? 0
      if (exchangeCount === null) {
        const meta = readSessionFileMeta(s.id, s.agentId, workspacePath)
        if (meta) {
          mirrorSessionMeta(db, s.id, meta)
          title = meta.title
          exchangeCount = meta.exchangeCount
          contextTokens = meta.contextTokens
          totalOutputTokens = meta.totalOutputTokens
        }
      }
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
      }
    }

    const enriched = [...rows.map(enrich), ...descendants.map(enrich)]
    return c.json({ sessions: enriched, nextCursor })
  })

  // GET /sessions/logs/:id?projectId=xxx — get full session log by ID
  app.get('/sessions/logs/:id', (c) => {
    const id = c.req.param('id')
    if (!isSafeIdSegment(id)) return c.json({ error: 'Invalid session id' }, 400)
    const projectId = c.req.query('projectId')
    const data = findSessionFileData(id, projectId ?? null)
    if (!data) return c.json({ error: 'Session not found' }, 404)

    // Only convert rawMessages when event log messages are empty
    // (sub-agent sessions that were only tracked via session-manager)
    const dataAny = data as unknown as Record<string, unknown>
    const hasEventLog = Array.isArray(data.messages) && data.messages.length > 0
    if (!hasEventLog) {
      const raw = dataAny.rawMessages as RawMessage[] | undefined
      if (raw && raw.length > 0) {
        const agentName = data.agentName ?? data.agentId ?? 'Agent'
        dataAny.messages = convertRawMessages(raw, agentName)
      }
    }

    return c.json(data)
  })

  // DELETE /sessions/logs/:id?projectId=xxx — permanently delete a session.
  // Cascades to all descendants: removes log files AND SQLite rows.
  // Use session:delete WS command for archive-only (soft delete).
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

  // PATCH /sessions/logs/:id?projectId=xxx — rename a session's title.
  // The JSON log file is the source of truth the listing reads, so the
  // new title lands there. Admin-only edit (no channel exposes this).
  app.patch('/sessions/logs/:id', async (c) => {
    const id = c.req.param('id')
    if (!isSafeIdSegment(id)) return c.json({ error: 'Invalid session id' }, 400)
    const projectId = c.req.query('projectId')
    if (!projectId) return c.json({ error: 'projectId required' }, 400)
    const body = await c.req.json<{ title?: string }>().catch(() => ({} as { title?: string }))
    const title = body.title?.trim()
    if (!title) return c.json({ error: 'title required' }, 400)

    const { db, workspacePath } = getWorkspaceDb(projectId)
    const updated = findAndUpdateSessionTitle(id, title, workspacePath)
    if (!updated) return c.json({ error: 'Session not found' }, 404)
    // The listing reads the mirrored column, so the rename has to land there
    // too — otherwise the new title only appears after the session's next write.
    db.update(agentSessions).set({ title }).where(eq(agentSessions.id, id)).run()
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
