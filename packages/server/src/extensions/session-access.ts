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
  projectId: string; sessionId: string; epoch: number; references: number
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
  expiresAt: number; cacheKey: string; slot?: Slot
  // Notice retention extends routing, never a live Admin HTTP/WS connection.
  abort?: AbortController; connectionExpiresAt?: number
}
export class ExtensionAccessError extends Error {
  constructor(public status: 401 | 403 | 503, message = status === 401 ? 'Unauthorized' : 'Forbidden') { super(message) }
}
const MAX_ENTRIES = 4096
const ROTATE_BEFORE_MS = 60_000
const digest = (key: string) => crypto.createHash('sha256').update(key).digest('hex')
const slotKey = (projectId: string, sessionId: string) => JSON.stringify([projectId, sessionId])

/** Cold path only. Never creates a workspace or trusts an agent id supplied by
 * the shell. DB rows and the same model-enabled metadata loader as the builder
 * determine entitlement; a same-named workspace/global override grants nothing. */
async function loadEntitlement(projectId: string, sessionId: string, watch: (root: string) => void): Promise<ExtensionEntitlement | null> {
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
  const dirs = listSkillDirs(projectId)
  // Watch candidates BEFORE metadata filtering/await: a disabled or malformed
  // shipped skill must invalidate the negative cache when edited too.
  for (const source of dirs) {
    if (source.scope === 'extension' && !source.overridden && yaml.skills?.includes(source.id)) watch(path.dirname(source.dir))
  }
  const skills = await loadSkillMetadata(yaml.skills ?? [], projectId, getDisabledSet(db, 'skill'), null)
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
  private idleSlots = new Set<string>()
  private projectSlots = new Map<string, number>()
  // Explicit lifecycle fences outlive reclaimable metadata/markers. No eviction:
  // old tool closures remain fenced until an actual run resumes (or shutdown).
  private stopped = new Set<string>()
  private projects = new Map<string, string>()
  private grants = new Map<string, Grant>()
  private bindings = new Map<string, Binding>()
  private bindingKeys = new Map<string, string>()
  private bindingEpoch = 0
  private listeners = new Set<(event: ExtensionAccessEvent) => void>()
  private timer: NodeJS.Timeout | undefined
  private nextExpiry = Infinity
  private expiryDirty = false
  private watchers: ExtensionAccessWatchers

  constructor(private load?: (projectId: string, sessionId: string) => Promise<ExtensionEntitlement | null>) {
    this.watchers = new ExtensionAccessWatchers((projectId) => this.invalidateSkills(projectId))
  }

  start({ baseUrl }: { baseUrl: string }): void {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
      throw new Error('[ExtensionAccess] A loopback listener URL is required')
    }
    this.baseUrl = url.origin
  }

  private project(projectId: string): string {
    const cached = this.projects.get(projectId)
    if (cached) return cached
    const resolved = fs.realpathSync(projectId)
    if (this.projects.size >= MAX_ENTRIES) this.projects.delete(this.projects.keys().next().value!)
    this.projects.set(projectId, resolved)
    return resolved
  }

  private slot(projectId: string, sessionId: string): Slot {
    const key = slotKey(projectId, sessionId)
    let slot = this.slots.get(key)
    if (!slot) {
      if (this.slots.size >= MAX_ENTRIES) {
        const idle = this.idleSlots.values().next().value
        if (!idle) throw new ExtensionAccessError(503, 'Extension access unavailable: session capacity reached')
        const evicted = this.slots.get(idle)!
        this.slots.delete(idle)
        this.idleSlots.delete(idle)
        const remaining = this.projectSlots.get(evicted.projectId)! - 1
        if (remaining) this.projectSlots.set(evicted.projectId, remaining)
        else { this.projectSlots.delete(evicted.projectId); this.watchers.unwatchWorkspace(evicted.projectId) }
      }
      slot = { projectId, sessionId, epoch: 0, references: 0, userTurnId: null, issued: new Map() }
      this.slots.set(key, slot)
      this.projectSlots.set(projectId, (this.projectSlots.get(projectId) ?? 0) + 1)
    }
    if (slot.references === 0) { this.idleSlots.delete(key); this.idleSlots.add(key) }
    return slot
  }

  private reference(slot: Slot, delta: number): void {
    slot.references += delta
    const key = slotKey(slot.projectId, slot.sessionId)
    if (this.slots.get(key) !== slot) return // an async load may finish after close
    if (slot.references) this.idleSlots.delete(key)
    else this.idleSlots.add(key)
  }

  private entitlement(slot: Slot): Promise<ExtensionEntitlement | null> {
    if (!slot.entitlement) {
      this.watchers.watchWorkspace(slot.projectId)
      slot.entitlement = this.load ? this.load(slot.projectId, slot.sessionId)
        : loadEntitlement(slot.projectId, slot.sessionId, (root) => this.watchers.watch(root, null))
    }
    return slot.entitlement
  }

  async shellContext(projectId: string, sessionId: string): Promise<ShellContext> {
    const empty = { env: {}, secrets: [] }
    if (!this.baseUrl) return empty
    this.sweepIfDue()
    projectId = this.project(projectId)
    if (this.stopped.has(slotKey(projectId, sessionId))) return empty
    const slot = this.slot(projectId, sessionId)
    const epoch = slot.epoch
    this.reference(slot, 1)
    try {
      const entitlement = await this.entitlement(slot)
      if (!entitlement || slot.epoch !== epoch || !this.baseUrl) return empty
      const map: ExtensionBackendAccessMap = {}
      for (const extensionId of entitlement.extensionIds) {
        let issued = slot.issued.get(extensionId)
        if (!issued || issued.grant.expiresAt - Date.now() <= ROTATE_BEFORE_MS) {
          if (this.grants.size >= MAX_ENTRIES) throw new ExtensionAccessError(503, 'Extension access unavailable: grant capacity reached')
          const accessKey = crypto.randomBytes(32).toString('base64url')
          const grant: Grant = {
            slot, identity: { projectId, sessionId, rootSessionId: entitlement.rootSessionId, agentId: entitlement.agentId }, extensionId, userTurnId: slot.userTurnId,
            expiresAt: Date.now() + EXTENSION_ACCESS_TTL_MS, digest: digest(accessKey), abort: new AbortController(),
          }
          this.grants.set(grant.digest, grant)
          this.expiryDirty = true
          this.reference(slot, 1)
          issued = { accessKey, grant }
          slot.issued.set(extensionId, issued)
          this.schedule()
        }
        map[extensionId] = { url: `${this.baseUrl}/api/ext/${extensionId}`, accessKey: issued.accessKey, expiresAt: new Date(issued.grant.expiresAt).toISOString() }
      }
      if (!Object.keys(map).length) return empty
      return { env: { [EXTENSION_BACKENDS_ENV]: JSON.stringify(map), [EXTENSION_NODE_ENV]: process.execPath }, secrets: Object.values(map).map((entry) => entry.accessKey) }
    } finally { this.reference(slot, -1) }
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
    const binding = this.bind(cacheKey, extensionId, generation, {
      kind: 'session', ...grant.identity, bindingId: crypto.randomUUID(), userTurnId: grant.userTurnId,
    }, grant.expiresAt, grant.slot)
    return { caller: binding.caller, signal: grant.abort.signal }
  }

  async bindAdmin(extensionId: string, generation: string, context: { projectId: string; sessionId?: string }): Promise<{ caller: ExtensionCaller; signal: AbortSignal }> {
    if (!this.baseUrl) throw new ExtensionAccessError(403, 'Caller binding unavailable')
    this.sweepIfDue()
    if (!path.isAbsolute(context.projectId)) throw new ExtensionAccessError(403, 'Invalid view context')
    let projectId: string
    try { projectId = this.project(context.projectId) } catch { throw new ExtensionAccessError(403, 'Invalid view context') }
    const cacheKey = JSON.stringify([extensionId, generation, 'admin', projectId, context.sessionId])
    const existingId = this.bindingKeys.get(cacheKey)
    const existing = existingId ? this.bindings.get(existingId) : undefined
    if (existing?.abort && !existing.abort.signal.aborted) return { caller: existing.caller, signal: existing.abort.signal }
    if (!fs.existsSync(path.join(projectId, '.halo', 'halo.db')) || this.stopped.has(slotKey(projectId, context.sessionId ?? ''))) throw new ExtensionAccessError(403, 'Invalid view context')
    const slot = context.sessionId ? this.slot(projectId, context.sessionId) : undefined
    const epoch = slot?.epoch
    const bindingEpoch = this.bindingEpoch
    if (slot) this.reference(slot, 1)
    try {
      const identity = slot ? await this.entitlement(slot) : undefined
      if (bindingEpoch !== this.bindingEpoch) throw new ExtensionAccessError(403, 'Caller binding unavailable')
      if (slot && (!identity || slot.epoch !== epoch)) throw new ExtensionAccessError(403, 'Invalid view context')
      const binding = this.bind(cacheKey, extensionId, generation, {
        kind: 'admin', bindingId: crypto.randomUUID(), projectId,
        ...(identity ? { sessionId: identity.sessionId, rootSessionId: identity.rootSessionId, agentId: identity.agentId } : {}),
        userTurnId: slot?.userTurnId ?? null,
      }, Date.now() + EXTENSION_ACCESS_TTL_MS, slot)
      return { caller: binding.caller, signal: binding.abort!.signal }
    } finally { if (slot) this.reference(slot, -1) }
  }

  private bind(cacheKey: string, extensionId: string, generation: string, caller: ExtensionCaller, expiresAt: number, slot?: Slot): Binding {
    const existingId = this.bindingKeys.get(cacheKey)
    const existing = existingId ? this.bindings.get(existingId) : undefined
    if (existing) return existing
    if (!generation) throw new ExtensionAccessError(403, 'Caller binding unavailable')
    if (this.bindings.size >= MAX_ENTRIES) throw new ExtensionAccessError(503, 'Extension access unavailable: binding capacity reached')
    const binding: Binding = { extensionId, generation, caller, expiresAt, cacheKey, slot,
      ...(caller.kind === 'admin' ? { abort: new AbortController(), connectionExpiresAt: expiresAt } : {}),
    }
    this.bindings.set(caller.bindingId, binding)
    this.expiryDirty = true
    this.bindingKeys.set(cacheKey, caller.bindingId)
    if (slot) this.reference(slot, 1)
    this.schedule()
    return binding
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
    if (deadline > b.expiresAt) { b.expiresAt = deadline; this.expiryDirty = true; this.schedule() }
    return true
  }

  acceptAdminInput(projectId: string, sessionId: string): string {
    const marker = crypto.randomUUID()
    if (!this.baseUrl) return marker
    this.sweepIfDue()
    projectId = this.project(projectId)
    // Ordinary chat must not fail when all extension slots are in use. There
    // is no live caller to update if this session has never obtained a slot.
    if (!this.slots.has(slotKey(projectId, sessionId)) && this.slots.size >= MAX_ENTRIES && !this.idleSlots.size) return marker
    const slot = this.slot(projectId, sessionId)
    slot.userTurnId = marker
    slot.epoch++ // fence a shell-context load already awaiting metadata
    if (slot.references === 0) return marker
    this.dropGrants((g) => g.slot === slot)
    // Existing notice bindings survive input/expiry; their live marker is a
    // takeover fence, NOT new authority for any old bearer.
    for (const b of this.bindings.values()) {
      if (b.caller.projectId !== projectId || b.caller.sessionId !== sessionId) continue
      b.caller = { ...b.caller, userTurnId: marker }
      this.emit(b, { type: 'halo:caller:updated', bindingId: b.caller.bindingId, userTurnId: marker })
    }
    this.schedule()
    return marker
  }

  revokeSession(projectId: string, sessionId: string, reason: ExtensionCallerRevocationReason): void {
    if (!this.baseUrl) return
    try { projectId = this.project(projectId) } catch { projectId = path.resolve(projectId) }
    const key = slotKey(projectId, sessionId)
    if (reason === 'session-stopped' || reason === 'session-deleted') this.stopped.add(key)
    const slot = this.slots.get(key)
    if (slot) this.revokeSlot(slot, reason)
    this.schedule()
  }

  /** Called on an actual resumed run, never on model construction/release. */
  resumeSession(projectId: string, sessionId: string): void {
    if (!this.baseUrl) return
    projectId = this.project(projectId)
    const key = slotKey(projectId, sessionId)
    if (this.stopped.delete(key)) {
      const slot = this.slots.get(key)
      if (slot) slot.entitlement = undefined
    }
  }

  invalidateSkills(projectId: string | null): void {
    if (projectId) {
      try { projectId = this.project(projectId) } catch { projectId = path.resolve(projectId) }
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
      if (b.slot === slot) this.dropBinding(b, reason)
    }
  }

  private dropGrants(predicate: (g: Grant) => boolean): void {
    for (const g of this.grants.values()) {
      if (!predicate(g)) continue
      this.grants.delete(g.digest)
      this.expiryDirty = true
      if (g.slot.issued.get(g.extensionId)?.grant === g) g.slot.issued.delete(g.extensionId)
      this.reference(g.slot, -1)
      g.abort.abort()
    }
  }

  private dropBinding(b: Binding, reason?: ExtensionCallerRevocationReason): void {
    this.bindings.delete(b.caller.bindingId)
    this.expiryDirty = true
    if (this.bindingKeys.get(b.cacheKey) === b.caller.bindingId) this.bindingKeys.delete(b.cacheKey)
    if (b.slot) this.reference(b.slot, -1)
    b.abort?.abort()
    if (reason) this.emit(b, { type: 'halo:caller:revoked', bindingId: b.caller.bindingId, reason })
  }

  private sweepIfDue(): void {
    if (Date.now() < this.nextExpiry) return
    this.dropGrants((g) => g.expiresAt <= Date.now())
    for (const b of this.bindings.values()) {
      if (b.connectionExpiresAt !== undefined && b.connectionExpiresAt <= Date.now()) {
        b.connectionExpiresAt = undefined
        this.expiryDirty = true
        if (this.bindingKeys.get(b.cacheKey) === b.caller.bindingId) this.bindingKeys.delete(b.cacheKey)
        b.abort!.abort()
      }
      if (b.expiresAt <= Date.now()) this.dropBinding(b)
    }
    this.schedule()
  }

  private schedule(): void {
    if (!this.expiryDirty) return
    this.expiryDirty = false
    let next = Infinity
    for (const g of this.grants.values()) next = Math.min(next, g.expiresAt)
    for (const b of this.bindings.values()) next = Math.min(next, b.expiresAt, b.connectionExpiresAt ?? Infinity)
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
    this.idleSlots.clear()
    this.projectSlots.clear()
    this.stopped.clear()
    this.projects.clear()
    this.watchers.close()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.nextExpiry = Infinity
    this.expiryDirty = false
    this.listeners.clear()
  }
}

export const extensionSessionAccess = new ExtensionSessionAccess()
