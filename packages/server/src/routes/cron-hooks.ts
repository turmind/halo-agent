/**
 * Webhook receiver of cron jobs: `POST /cron-hooks/:jobId`, outside /api (no
 * admin cookie — authed here by the job's secret, like /a2a-push/:pushId).
 * Stores the delivery in `cron_events` and hands it to the runner
 * (startOrInject); answers 202 without waiting for the run.
 *
 *   - auth: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(body, secret)>`
 *     (GitHub and most senders) or `Authorization: Bearer <secret>`; unknown
 *     job, non-webhook job or a bad credential → 404 alike
 *   - body ≤ 1 MB (413), stored as received; GitHub `ping` → 200, no run
 *   - dedupe per job on X-GitHub-Delivery / Idempotency-Key / X-Request-Id,
 *     else sha256(body) → 200 `{duplicate:true}`
 *   - disabled job → 409; MAX_PENDING_EVENTS pending → 429
 */
import crypto from 'node:crypto'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { and, eq } from 'drizzle-orm'
import { cronEvents, cronJobs, getCronDb } from '../db/cron-db.js'
import { countPendingEvents, MAX_PENDING_EVENTS } from '../cron/events.js'
import { startOrInject } from '../cron/runner.js'

const MAX_HOOK_BODY = 1024 * 1024

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

function authorized(c: Context, body: Buffer, secret: string): boolean {
  const sig = c.req.header('x-hub-signature-256')
  if (sig) return safeEqual(sig, `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`)
  const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1]
  return bearer !== undefined && safeEqual(bearer, secret)
}

export function createCronHookRoutes(): Hono {
  const app = new Hono()
  app.post('/cron-hooks/:jobId', bodyLimit({ maxSize: MAX_HOOK_BODY, onError: (c) => c.json({ error: 'payload too large' }, 413) }), async (c) => {
    const jobId = c.req.param('jobId')
    const body = Buffer.from(await c.req.arrayBuffer())
    const job = getCronDb().select({ webhookSecret: cronJobs.webhookSecret, enabled: cronJobs.enabled }).from(cronJobs).where(eq(cronJobs.id, jobId)).get()
    if (!job?.webhookSecret || !authorized(c, body, job.webhookSecret)) return c.json({ error: 'not found' }, 404)
    const eventType = c.req.header('x-github-event') || c.req.header('x-gitlab-event') || null
    if (eventType === 'ping') return c.json({ ok: true, ping: true })
    if (job.enabled !== 1) return c.json({ error: 'job disabled' }, 409)
    const deliveryId = c.req.header('x-github-delivery') || c.req.header('idempotency-key') || c.req.header('x-request-id')
      || crypto.createHash('sha256').update(body).digest('hex')
    const db = getCronDb()
    const seen = db.select({ id: cronEvents.id }).from(cronEvents).where(and(eq(cronEvents.jobId, jobId), eq(cronEvents.deliveryId, deliveryId))).get()
    if (seen) return c.json({ ok: true, duplicate: true, eventId: seen.id })
    if (countPendingEvents(jobId) >= MAX_PENDING_EVENTS) return c.json({ error: `too many pending events (${MAX_PENDING_EVENTS})` }, 429)
    const eventId = `ev-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
    const { changes } = db.insert(cronEvents).values({
      id: eventId, jobId, deliveryId, eventType, receivedAt: Date.now(), state: 'pending', payload: body.toString('utf-8'),
    }).onConflictDoNothing().run()
    // The same delivery raced in on another request.
    if (changes === 0) return c.json({ ok: true, duplicate: true })
    console.log(`[Cron] ${jobId}: webhook event ${eventId}${eventType ? ` (${eventType})` : ''} delivery ${deliveryId}`)
    startOrInject(jobId).catch((err) => console.warn(`[Cron] ${jobId}: handling webhook event ${eventId} failed: ${err instanceof Error ? err.message : String(err)}`))
    return c.json({ ok: true, eventId }, 202)
  })
  return app
}
