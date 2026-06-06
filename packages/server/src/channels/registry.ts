/**
 * Server-side channel registry.
 *
 * Each channel (telegram / wechat / web / future) ships a
 * `ServerChannelDescriptor` describing how to boot it, mount its REST
 * routes, optionally register a cron dispatcher, and optionally shut
 * down gracefully. `index.ts` iterates the registry; nothing in the
 * core knows about specific channel types.
 *
 * Adding a new channel = create a `descriptor.ts` next to the channel's
 * handler + add one import to `channels/registry.ts`'s default list.
 * No edits to `index.ts`, `cron/`, or the admin tab routing.
 */
import type { Hono } from 'hono'
import type { ChannelDb } from '../db/channel-db.js'
import type { SessionManagerRegistry } from '../agents/session-manager-registry.js'

export interface ChannelBootDeps {
  registry: SessionManagerRegistry
  db: ChannelDb
}

export interface ChannelRoutesDeps<TChannel> {
  db: ChannelDb
  channel: TChannel
}

/** A server-side channel implementation, opaque to the registry but
 *  type-safe internally. The descriptor owns its own handle type
 *  (`TChannel`) so its `routes` / `shutdown` callbacks can dot into
 *  channel-specific methods (e.g. `channel.stopAccount(id)` from a
 *  DELETE handler). */
export interface ServerChannelDescriptor<TChannel = unknown> {
  /** Wire-level slug. Must match the `channel_type` value in
   *  `channel_accounts` rows and the `channelType` used by the cron
   *  dispatcher registry. */
  channelType: string
  /** Boot the channel — start long-poll loops, init runners, etc.
   *  Returns whatever handle the routes/shutdown callbacks need. */
  start(deps: ChannelBootDeps): TChannel
  /** Build the Hono sub-router mounted at `/api/`. The router itself
   *  decides its prefix (e.g. `/telegram/accounts`), keeping with the
   *  existing convention. */
  routes(deps: ChannelRoutesDeps<TChannel>): Hono
  /** Optional graceful shutdown. Called on SIGINT/SIGTERM in the order
   *  channels were registered. */
  shutdown?(channel: TChannel): Promise<void>
  /** Optional: register the channel's cron dispatcher into
   *  `cron/dispatcher.ts`'s registry. Called once at boot, before
   *  `startCronDaemon()`. */
  registerCronDispatcher?(): void
}

/** Internal runtime row — the descriptor plus the started handle. Kept
 *  as `unknown` here so the registry stays generic; the descriptor's
 *  own `routes` / `shutdown` callbacks see their typed `TChannel`. */
interface RunningChannel {
  descriptor: ServerChannelDescriptor<unknown>
  channel: unknown
}

const _running: RunningChannel[] = []

/** Boot every descriptor in order. Each one's `start` is called, the
 *  handle is captured, then `routes(...)` is mounted on `app`. Cron
 *  dispatcher registration happens here too — before `startCronDaemon`
 *  in the boot sequence — so the cron registry is fully populated
 *  before the first scheduled fire. */
export function bootChannels(
  app: Hono,
  descriptors: ReadonlyArray<ServerChannelDescriptor<unknown>>,
  deps: ChannelBootDeps,
): void {
  for (const d of descriptors) {
    if (d.registerCronDispatcher) d.registerCronDispatcher()
    const channel = d.start(deps)
    _running.push({ descriptor: d, channel })
    const router = d.routes({ db: deps.db, channel })
    app.route('/api', router)
  }
}

/** Shut down all running channels in reverse-boot order. Each error is
 *  logged but never thrown — graceful shutdown should drain everything
 *  it can, even if one channel hangs. */
export async function shutdownChannels(): Promise<void> {
  for (const r of [..._running].reverse()) {
    if (!r.descriptor.shutdown) continue
    try {
      await r.descriptor.shutdown(r.channel)
    } catch (err) {
      console.log(`[Server] ${r.descriptor.channelType} shutdown error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  _running.length = 0
}
