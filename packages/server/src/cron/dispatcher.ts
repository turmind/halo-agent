/**
 * Cron output dispatcher — fan a final assistant text out to a list of
 * channel targets.
 *
 * The dispatcher itself is channel-agnostic. Each channel module
 * registers its own `CronChannelDispatcher` at server boot
 * (`registerCronDispatcher(...)`); this file only knows how to look up by
 * `channelType` and let the channel handle the rest. Adding a new
 * channel = ship its dispatcher inside that channel's directory and
 * register it once during boot — no edits here.
 *
 * Failures are per-target — one channel being down doesn't block the
 * others. Returns a structured array the runner persists into
 * `cron_runs.dispatch_results` for the UI.
 */

export interface CronTarget {
  /** Wire-level slug. Matches `ServerChannelDescriptor.channelType`. The
   *  cron dispatcher registry decides at runtime whether anything is
   *  registered for it — unknown types fail with a clear "no dispatcher
   *  registered" error rather than a compile-time enum. */
  channelType: string
  accountId: string
  /** Optional explicit chat id. When set, the channel dispatcher should
   *  send only to this chat (pinning the schedule to the conversation it
   *  was created from). When unset, fan-out / default-recipient logic in
   *  the channel decides who gets the message. */
  chatId?: string
}

export interface DispatchResult {
  channelType: string
  accountId: string
  /** Echoed back so the UI can show "sent to chat 123: ✓".
   *  Absent for single-recipient channels. */
  chatId?: string
  ok: boolean
  /** Populated on failure. Concise — full stack trace goes to stderr/log. */
  error?: string
}

/** A channel-side enumeration of accounts that can be picked as cron
 *  targets in the admin UI's create-form dropdown. `ready` flags accounts
 *  that can deliver right now (numeric whitelist id present, or QR-bound
 *  owner, etc.); the UI surfaces "(no active chat)" for `ready=false`. */
export interface CronTargetOption {
  channelType: string
  accountId: string
  label: string
  workspacePath: string
  enabled: boolean
  /** True when the dispatcher would have somewhere to send to right now. */
  hasActiveChat: boolean
}

/**
 * A channel's cron-dispatch implementation. Each channel module supplies
 * one and registers it at boot. `dispatch` takes (accountId, text,
 * optional explicit chatId) and returns one or more `DispatchResult` rows
 * — telegram fans out to multiple chats so it returns N rows; wechat is
 * single-recipient so it returns one. Throwing is acceptable; the
 * orchestrator wraps it into a single failed-result.
 *
 * `listTargets` is what the admin UI's create-form dropdown reads to know
 * which accounts of this channel can be picked. Optional — channels with
 * no UI surface (purely send-side, e.g. a future webhook) can omit it.
 */
export interface CronChannelDispatcher {
  channelType: string
  dispatch: (accountId: string, text: string, chatId?: string) => Promise<DispatchResult[]>
  listTargets?: () => CronTargetOption[]
}

const _registry = new Map<string, CronChannelDispatcher>()

export function registerCronDispatcher(d: CronChannelDispatcher): void {
  _registry.set(d.channelType, d)
}

/** Aggregate `listTargets()` from every registered dispatcher. Routes use
 *  this to feed the admin UI's create form without knowing the channels. */
export function listAllCronTargets(): CronTargetOption[] {
  const out: CronTargetOption[] = []
  for (const d of _registry.values()) {
    if (!d.listTargets) continue
    out.push(...d.listTargets())
  }
  return out
}

/**
 * Send `text` to every target. Never throws — every target's outcome is
 * captured into the returned array. An empty `targets` returns []
 * (caller treats that as "log only" and skips dispatch entirely).
 */
export async function dispatchToTargets(text: string, targets: CronTarget[]): Promise<DispatchResult[]> {
  const out: DispatchResult[] = []
  for (const t of targets) {
    const handler = _registry.get(t.channelType)
    if (!handler) {
      out.push({
        channelType: t.channelType, accountId: t.accountId, chatId: t.chatId,
        ok: false, error: `no dispatcher registered for channel type "${t.channelType}"`,
      })
      continue
    }
    try {
      const results = await handler.dispatch(t.accountId, text, t.chatId)
      for (const r of results) out.push(r)
    } catch (err) {
      out.push({
        channelType: t.channelType, accountId: t.accountId, chatId: t.chatId,
        ok: false, error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return out
}
