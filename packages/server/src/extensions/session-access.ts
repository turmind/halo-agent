import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import {
  EXTENSION_ACCESS_TTL_MS, EXTENSION_BACKENDS_ENV, EXTENSION_NODE_ENV,
  EXTENSION_NOTICE_LIMITS,
  type ExtensionBackendAccessMap, type ExtensionCaller, type ExtensionCallerRevokedMessage,
  type ExtensionCallerUpdatedMessage, type ExtensionCallerRevocationReason,
} from '@turmind/halo-core/protocol'
import { getDisabledSet, openHaloDb } from '../db/index.js'
import { agentSessions } from '../db/schema.js'
import { extensionsRoot, readExtensionDir } from './registry.js'
import { confirmedBackendIds, disabledExtensionIds } from './state.js'
import { ExtensionAccessWatchers } from './session-access-watchers.js'

export interface ExtensionEntitlement {
  projectId: string
  sessionId: string
  rootSessionId: string
  agentId: string
  extensionIds: string[]
}
export type ExtensionAccessEvent = {
  extensionId: string
  generation: string
  message: ExtensionCallerRevokedMessage | ExtensionCallerUpdatedMessage
}
type ShellContext = { env: Record<string, string>; secrets: string[] }
type Identity = Omit<ExtensionEntitlement, 'extensionIds'>
type Slot = {
  projectId: string; sessionId: string; epoch: number; stopped: boolean
  userTurnId: string | null
  entitlement?: Promise<ExtensionEntitlement | null>
  issued: Map<string, { accessKey: string; grant: Grant }>
}
type Grant = {
  slot: Slot; identity: Identity; extensionId: string; userTurnId: string | null
  expiresAt: number; digest: string; abort: AbortController
}
type Binding = {
  extensionId: string; generation: string; caller: ExtensionCaller
  expiresAt: number; cacheKey: string
}
export class ExtensionAccessError extends Error {
  constructor(public status: 401 | 403, message = status === 401 ? 'Unauthorized' : 'Forbidden') { super(message) }
}
const MAX_ENTRIES = 4096
const ROTATE_BEFORE_MS = 60_000
const digest = (key: string) => crypto.createHash('sha256').update(key).digest('hex')
const slotKey = (projectId: string, sessionId: string) => JSON.stringify([projectId, sessionId])

/** Cold path only. Never creates a workspace or trusts an agent id supplied by
 * the shell. DB rows and the same model-enabled metadata loader as the builder
 * determine entitlement; a same-named workspace/global override grants nothing. */
async function loadEntitlement(projectId: string, sessionId: string): Promise<ExtensionEntitlement | null> {
  const dbPath = path.join(projectId, '.halo', 'halo.db')
  if (!fs.existsSync(dbPath)) return null
  const db = openHaloDb(path.dirname(dbPath))
  const row = db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get()
  if (!row) return null
  let root = row
  const seen = new Set([row.id])
  while (root.parentId) {
    const parent = db.select().from(agentSessions).where(eq(agentSessions.id, root.parentId)).get()
    if (!parent || seen.has(parent.id)) return null
    seen.add(parent.id)
    root = parent
  }
  const identity = { projectId, sessionId, rootSessionId: root.id, agentId: row.agentId }
  if (row.accessLevel !== null) return { ...identity, extensionIds: [] }
  const { loadAgentYaml, loadSkillMetadata } = await import('../agents/agent-loader.js')
  const { listSkillDirs } = await import('../agents/skill-sources.js')
  const yaml = await loadAgentYaml(row.agentId, projectId)
  const disabledAgents = getDisabledSet(db, 'agent')
  if (!yaml?.tools?.includes('shell_exec') || ['global', 'workspace'].some((scope) => disabledAgents.has(`${scope}:${row.agentId}`))) {
    return { ...identity, extensionIds: [] }
  }
  const skills = await loadSkillMetadata(yaml.skills ?? [], projectId, getDisabledSet(db, 'skill'), null)
  const dirs = listSkillDirs(projectId)
  const off = disabledExtensionIds()
  const confirmed = confirmedBackendIds()
  const extensionIds = new Set<string>()
  for (const skill of skills) {
    const source = dirs.find((s) => s.id === skill.id && !s.overridden)
    if (source?.scope !== 'extension' || !source.extId || path.join(source.dir, 'SKILL.md') !== skill.path) continue
    if (off.has(source.extId) || !confirmed.has(source.extId)) continue
    // Provenance includes resolution: a shipped SKILL.md symlink must not
    // lend this extension's authority to an unrelated folder's contents.
    try {
      const shipped = path.join(fs.realpathSync(path.join(extensionsRoot(), source.extId)), 'skills')
      if (!fs.realpathSync(skill.path).startsWith(shipped + path.sep)) continue
    } catch { continue }
    const ext = readExtensionDir(path.join(extensionsRoot(), source.extId))
    if (!('error' in ext) && ext.backend) extensionIds.add(source.extId)
  }
  return { ...identity, extensionIds: [...extensionIds] }
}

/** Process-local authority, separate from routing retention. Exported class is
 * also the test seam: production uses disk loading and independent fs watches. */
export class ExtensionSessionAccess {
  private baseUrl: string | null = null
  private slots = new Map<string, Slot>()
  private grants = new Map<string, Grant>()
  private bindings = new Map<string, Binding>()
  private bindingKeys = new Map<string, string>()
  private bindingEpoch = 0
  private listeners = new Set<(event: ExtensionAccessEvent) => void>()
  private timer: NodeJS.Timeout | undefined
  private nextExpiry = Infinity
  private watchers: ExtensionAccessWatchers

  constructor(private load: (projectId: string, sessionId: string) => Promise<ExtensionEntitlement | null> = loadEntitlement) {
    this.watchers = new ExtensionAccessWatchers((projectId) => this.invalidateSkills(projectId))
  }

  start({ baseUrl }: { baseUrl: string }): void {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
      throw new Error('[ExtensionAccess] A loopback listener URL is required')
    }
    this.baseUrl = url.origin
  }

  private slot(projectId: string, sessionId: string): Slot {
    const key = slotKey(projectId, sessionId)
    let slot = this.slots.get(key)
    if (!slot) {
      // Never evict a Stop tombstone to make space: an old tool closure must
      // not become eligible again just because other sessions were opened.
      if (this.slots.size >= MAX_ENTRIES) return { projectId, sessionId, epoch: 0, stopped: true, userTurnId: null, issued: new Map() }
      slot = { projectId, sessionId, epoch: 0, stopped: false, userTurnId: null, issued: new Map() }
      this.slots.set(key, slot)
    }
    return slot
  }

  private entitlement(slot: Slot): Promise<ExtensionEntitlement | null> {
    // Re-check watcher registration even on a cache hit: a failed fs watch
    // re-arm must not leave a cached eligible slot with no invalidation source.
    this.watchers.watchWorkspace(slot.projectId)
    if (!slot.entitlement) {
      slot.entitlement = this.load(slot.projectId, slot.sessionId)
    }
    return slot.entitlement
  }

  async shellContext(projectId: string, sessionId: string): Promise<ShellContext> {
    const empty = { env: {}, secrets: [] }
    if (!this.baseUrl) return empty
    this.sweepIfDue()
    projectId = fs.realpathSync(projectId)
    const slot = this.slot(projectId, sessionId)
    if (slot.stopped) return empty
    const epoch = slot.epoch
    const entitlement = await this.entitlement(slot)
    if (!entitlement || slot.epoch !== epoch || slot.stopped || !this.baseUrl) return empty
    const map: ExtensionBackendAccessMap = {}
    for (const extensionId of entitlement.extensionIds) {
      this.watchers.watch(path.join(extensionsRoot(), extensionId, 'skills'), null)
      let issued = slot.issued.get(extensionId)
      if (!issued || issued.grant.expiresAt - Date.now() <= ROTATE_BEFORE_MS) {
        if (this.grants.size >= MAX_ENTRIES) continue
        const accessKey = crypto.randomBytes(32).toString('base64url')
        const grant: Grant = {
          slot, identity: { projectId, sessionId, rootSessionId: entitlement.rootSessionId, agentId: entitlement.agentId }, extensionId, userTurnId: slot.userTurnId,
          expiresAt: Date.now() + EXTENSION_ACCESS_TTL_MS, digest: digest(accessKey), abort: new AbortController(),
        }
        this.grants.set(grant.digest, grant)
        issued = { accessKey, grant }
        slot.issued.set(extensionId, issued)
      }
      map[extensionId] = { url: `${this.baseUrl}/api/ext/${extensionId}`, accessKey: issued.accessKey, expiresAt: new Date(issued.grant.expiresAt).toISOString() }
    }
    this.schedule()
    if (!Object.keys(map).length) return empty
    return { env: { [EXTENSION_BACKENDS_ENV]: JSON.stringify(map), [EXTENSION_NODE_ENV]: process.execPath }, secrets: Object.values(map).map((entry) => entry.accessKey) }
  }

  /** Authentication only uses the digest registry, never a routing binding. */
  validate(extensionId: string, authorization: string): Grant {
    this.sweepIfDue()
    const key = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1]
    const grant = key ? this.grants.get(digest(key)) : undefined
    if (!grant || grant.extensionId !== extensionId || grant.abort.signal.aborted) throw new ExtensionAccessError(401)
    return grant
  }

  bindSession(extensionId: string, generation: string, authorization: string): { caller: ExtensionCaller; signal: AbortSignal } {
    const grant = this.validate(extensionId, authorization)
    const cacheKey = JSON.stringify([extensionId, generation, grant.digest])
    const caller = this.bind(cacheKey, extensionId, generation, {
      kind: 'session', ...grant.identity, bindingId: crypto.randomUUID(), userTurnId: grant.userTurnId,
    }, grant.expiresAt)
    return { caller, signal: grant.abort.signal }
  }

  async bindAdmin(extensionId: string, generation: string, context: { projectId: string; sessionId?: string }): Promise<ExtensionCaller> {
    if (!this.baseUrl) throw new ExtensionAccessError(403, 'Caller binding unavailable')
    this.sweepIfDue()
    if (!path.isAbsolute(context.projectId)) throw new ExtensionAccessError(403, 'Invalid view context')
    let projectId: string
    try { projectId = fs.realpathSync(context.projectId) } catch { throw new ExtensionAccessError(403, 'Invalid view context') }
    if (!fs.existsSync(path.join(projectId, '.halo', 'halo.db'))) throw new ExtensionAccessError(403, 'Invalid view context')
    const slot = context.sessionId ? this.slot(projectId, context.sessionId) : undefined
    const epoch = slot?.epoch
    const bindingEpoch = this.bindingEpoch
    const identity = slot ? await this.entitlement(slot) : undefined
    if (bindingEpoch !== this.bindingEpoch) throw new ExtensionAccessError(403, 'Caller binding unavailable')
    if (slot && (!identity || slot.epoch !== epoch || slot.stopped)) throw new ExtensionAccessError(403, 'Invalid view context')
    const cacheKey = JSON.stringify([extensionId, generation, 'admin', projectId, context.sessionId, slot?.userTurnId])
    return this.bind(cacheKey, extensionId, generation, {
      kind: 'admin', bindingId: crypto.randomUUID(), projectId,
      ...(identity ? { sessionId: identity.sessionId, rootSessionId: identity.rootSessionId, agentId: identity.agentId } : {}),
      userTurnId: slot?.userTurnId ?? null,
    }, Date.now() + EXTENSION_ACCESS_TTL_MS)
  }

  private bind(cacheKey: string, extensionId: string, generation: string, caller: ExtensionCaller, expiresAt: number): ExtensionCaller {
    const existingId = this.bindingKeys.get(cacheKey)
    const existing = existingId ? this.bindings.get(existingId) : undefined
    if (existing) return existing.caller
    if (!generation || this.bindings.size >= MAX_ENTRIES) throw new ExtensionAccessError(403, 'Caller binding unavailable')
    this.bindings.set(caller.bindingId, { extensionId, generation, caller, expiresAt, cacheKey })
    this.bindingKeys.set(cacheKey, caller.bindingId)
    this.schedule()
    return caller
  }

  getBinding(extensionId: string, generation: string, bindingId: string): ExtensionCaller | null {
    this.sweepIfDue()
    const b = this.bindings.get(bindingId)
    return b?.extensionId === extensionId && b.generation === generation ? b.caller : null
  }

  retainBinding(extensionId: string, generation: string, bindingId: string, expiresAt: string): boolean {
    const caller = this.getBinding(extensionId, generation, bindingId)
    const deadline = Date.parse(expiresAt)
    if (!caller || !Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + EXTENSION_NOTICE_LIMITS.maxTtlMs) return false
    const b = this.bindings.get(bindingId)!
    b.expiresAt = Math.max(b.expiresAt, deadline)
    this.schedule()
    return true
  }

  acceptAdminInput(projectId: string, sessionId: string): string {
    this.sweepIfDue()
    projectId = fs.realpathSync(projectId)
    const slot = this.slot(projectId, sessionId)
    slot.userTurnId = crypto.randomUUID()
    slot.epoch++ // fence a shell-context load already awaiting metadata
    this.dropGrants((g) => g.slot === slot)
    // Existing notice bindings survive input/expiry; their live marker is a
    // takeover fence, NOT new authority for any old bearer.
    for (const b of this.bindings.values()) {
      if (b.caller.projectId !== projectId || b.caller.sessionId !== sessionId) continue
      b.caller = { ...b.caller, userTurnId: slot.userTurnId }
      this.emit(b, { type: 'halo:caller:updated', bindingId: b.caller.bindingId, userTurnId: slot.userTurnId })
    }
    this.schedule()
    return slot.userTurnId
  }

  revokeSession(projectId: string, sessionId: string, reason: ExtensionCallerRevocationReason): void {
    if (!this.baseUrl) return
    try { projectId = fs.realpathSync(projectId) } catch { projectId = path.resolve(projectId) }
    const slot = this.slot(projectId, sessionId)
    if (reason === 'session-stopped' || reason === 'session-deleted') slot.stopped = true
    this.revokeSlot(slot, reason)
    this.schedule()
  }

  /** Called on an actual resumed run, never on model construction/release. */
  resumeSession(projectId: string, sessionId: string): void {
    if (!this.baseUrl) return
    projectId = fs.realpathSync(projectId)
    const slot = this.slots.get(slotKey(projectId, sessionId))
    if (slot?.stopped) { slot.stopped = false; slot.entitlement = undefined }
  }

  invalidateSkills(projectId: string | null): void {
    if (projectId) {
      try { projectId = fs.realpathSync(projectId) } catch { projectId = path.resolve(projectId) }
    }
    // One pass per collection, not revokeSlot's scan once per session. A
    // global skill edit must stay linear when many sessions hold grants.
    for (const slot of this.slots.values()) {
      if (projectId && slot.projectId !== projectId) continue
      slot.epoch++
      slot.entitlement = undefined
    }
    this.dropGrants((g) => !projectId || g.slot.projectId === projectId)
    for (const b of [...this.bindings.values()]) {
      if (!projectId || b.caller.projectId === projectId) this.dropBinding(b, 'skill-changed')
    }
    this.schedule()
  }

  invalidateExtension(extensionId?: string): void {
    this.bindingEpoch++
    for (const slot of this.slots.values()) { slot.epoch++; slot.entitlement = undefined }
    this.dropGrants((g) => !extensionId || g.extensionId === extensionId)
    for (const b of [...this.bindings.values()]) if (!extensionId || b.extensionId === extensionId) this.dropBinding(b, 'extension-changed')
    this.schedule()
  }

  dropBackendGeneration(extensionId: string, generation: string): void {
    this.bindingEpoch++
    for (const b of [...this.bindings.values()]) if (b.extensionId === extensionId && b.generation === generation) this.dropBinding(b, 'extension-changed')
    this.schedule()
  }

  subscribe(listener: (event: ExtensionAccessEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(b: Binding, message: ExtensionAccessEvent['message']): void {
    for (const listener of this.listeners) listener({ extensionId: b.extensionId, generation: b.generation, message })
  }

  private revokeSlot(slot: Slot, reason: ExtensionCallerRevocationReason): void {
    slot.epoch++
    slot.entitlement = undefined
    this.dropGrants((g) => g.slot === slot)
    for (const b of [...this.bindings.values()]) {
      if (b.caller.projectId === slot.projectId && b.caller.sessionId === slot.sessionId) this.dropBinding(b, reason)
    }
  }

  private dropGrants(predicate: (g: Grant) => boolean): void {
    for (const g of this.grants.values()) {
      if (!predicate(g)) continue
      this.grants.delete(g.digest)
      if (g.slot.issued.get(g.extensionId)?.grant === g) g.slot.issued.delete(g.extensionId)
      g.abort.abort()
    }
  }

  private dropBinding(b: Binding, reason?: ExtensionCallerRevocationReason): void {
    this.bindings.delete(b.caller.bindingId)
    this.bindingKeys.delete(b.cacheKey)
    if (reason) this.emit(b, { type: 'halo:caller:revoked', bindingId: b.caller.bindingId, reason })
  }

  private sweepIfDue(): void {
    if (Date.now() < this.nextExpiry) return
    this.dropGrants((g) => g.expiresAt <= Date.now())
    for (const b of this.bindings.values()) if (b.expiresAt <= Date.now()) this.dropBinding(b)
    this.schedule()
  }

  private schedule(): void {
    let next = Infinity
    for (const g of this.grants.values()) next = Math.min(next, g.expiresAt)
    for (const b of this.bindings.values()) next = Math.min(next, b.expiresAt)
    if (next === this.nextExpiry) return
    if (this.timer) clearTimeout(this.timer)
    this.nextExpiry = next
    this.timer = Number.isFinite(next) ? setTimeout(() => this.sweepIfDue(), Math.max(1, next - Date.now())) : undefined
    this.timer?.unref()
  }

  close(): void {
    this.bindingEpoch++
    this.baseUrl = null
    this.dropGrants(() => true)
    for (const b of [...this.bindings.values()]) this.dropBinding(b, 'shutdown')
    this.slots.clear()
    this.watchers.close()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.nextExpiry = Infinity
    this.listeners.clear()
  }
}

export const extensionSessionAccess = new ExtensionSessionAccess()
