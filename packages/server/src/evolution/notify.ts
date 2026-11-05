/**
 * Auto-apply notice (plans/evo-l2-l3.md §6): one `chat:system` line in the
 * source session once an L2/L3 auto apply has published — nobody approved
 * it, so this is how the user learns their prompts changed.
 *
 * Driven by the db, not memory: the ticker sends for every
 * `approved_by='auto' AND status='applied' AND notified_at IS NULL` row and
 * stamps notified_at, so a restart neither repeats nor drops a notice.
 */
import fs from 'node:fs'
import path from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import { config } from '../config.js'
import { evolutionApplies, evolutionRuns, type EvoDb } from '../db/evo-db.js'
import { t } from '../channels/shared/i18n.js'
import { wsEvoHistoryDir, wsEvoRunDir } from '../paths.js'
import { AUTO_APPLY_FILE, type AutoApplyRecord } from './auto-apply.js'

/** What the notice needs from the session layer — the server's
 *  SessionManagerRegistry, injected by index.ts like the cron one. */
export interface EvoNotifyTarget {
  getSessionById(sessionId: string): unknown
  notifySystem(sessionId: string, text: string): void
}
export interface EvoNotifyRegistry { getOrCreate(workspacePath: string): EvoNotifyTarget }

let _registry: EvoNotifyRegistry | null = null
/** Unset (tests, AgentCore mode) = no server-side sessions; nothing is sent
 *  and rows stay un-notified until a registry exists. */
export function setEvoSessionRegistry(r: EvoNotifyRegistry | null): void { _registry = r }

const OBSERVATION_PREVIEW_CHARS = 120
const MAX_LISTED_FILES = 3

/** The notice text. Exported for tests. */
export function formatAutoAppliedNotice(input: {
  files: string[]
  avg: number | null
  confidence: string | null
  observation: string | null
  lang: 'en' | 'zh'
}): string {
  const { files, lang } = input
  const listed = files.slice(0, MAX_LISTED_FILES).join(', ')
  const fileText = files.length > MAX_LISTED_FILES
    ? t('evo.auto_applied_files_more', lang, { files: listed, count: files.length })
    : listed
  let text = t('evo.auto_applied', lang, { files: fileText || '?', avg: input.avg ?? '?', confidence: input.confidence ?? '?' })
  if (input.observation) {
    const flat = input.observation.replace(/\s+/g, ' ').trim()
    const preview = flat.length > OBSERVATION_PREVIEW_CHARS ? `${flat.slice(0, OBSERVATION_PREVIEW_CHARS)}…` : flat
    text += ` ${t('evo.auto_applied_observation', lang, { preview })}`
  }
  return text
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) as T } catch { return null }
}

/** One pass. Called from the ticker after broadcastChanges. */
export function notifyAutoApplied(db: EvoDb): void {
  const registry = _registry
  if (!registry) return
  const rows = db.select().from(evolutionApplies)
    .where(and(eq(evolutionApplies.approvedBy, 'auto'), eq(evolutionApplies.status, 'applied'), isNull(evolutionApplies.notifiedAt)))
    .limit(20)
    .all()
  for (const a of rows) {
    try {
      const runId = (JSON.parse(a.sourceRunIds) as string[])[0]
      const run = runId ? db.select().from(evolutionRuns).where(eq(evolutionRuns.id, runId)).get() : undefined
      // Same gate as relay: never scaffold a `.halo/` into a vanished folder.
      if (run && fs.existsSync(path.join(a.workspacePath, '.halo'))) {
        const sm = registry.getOrCreate(a.workspacePath)
        if (sm.getSessionById(run.sourceSession)) {
          const manifest = readJson<{ files?: Array<{ rel: string }> }>(path.join(wsEvoHistoryDir(a.workspacePath, a.id), 'MANIFEST.json'))
          const verdict = readJson<AutoApplyRecord>(path.join(wsEvoRunDir(a.workspacePath, run.id), AUTO_APPLY_FILE))
          sm.notifySystem(run.sourceSession, formatAutoAppliedNotice({
            files: (manifest?.files ?? []).map((f) => f.rel.split(path.sep).join('/')),
            avg: verdict?.score?.avg ?? null,
            confidence: verdict?.score?.confidence ?? null,
            observation: verdict?.observation ?? null,
            lang: config.language,
          }))
        }
      }
    } catch (err) {
      console.warn(`[EvoTicker] auto-apply notice for ${a.id} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    // Stamped whether or not a session got the line (deleted session, vanished
    // workspace, a throw) — otherwise the row would be retried every tick.
    db.update(evolutionApplies)
      .set({ notifiedAt: Date.now() })
      .where(and(eq(evolutionApplies.id, a.id), isNull(evolutionApplies.notifiedAt)))
      .run()
  }
}
