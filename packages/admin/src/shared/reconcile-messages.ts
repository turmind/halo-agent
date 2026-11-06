import type { ChatMessage } from '@/shared/types'

/**
 * Reuse previous message object identities for entries whose content is
 * unchanged, so MessageList's memoized exchange rows skip re-render: a
 * wholesale array replace hands every row a brand-new object, re-running
 * ReactMarkdown across the whole conversation. When nothing changed at all,
 * returns `prev` so the store set is a no-op.
 *
 * `settledPrefix` — for a `prev` that is an earlier read of the SAME server
 * log (the Sessions-tab refetch, fired on every write to the session file,
 * including rewrites that change no messages, e.g. a title PATCH). Session
 * logs are append-only: settled rows never change bytes, the only in-place
 * mutation is the LAST row absorbing updates (tool results landing,
 * streaming text growing) — plus rare wholesale rewrites (compact, exchange
 * soft-delete). So deep-comparing every row on every write (two
 * JSON.stringify passes over a multi-MB transcript per file:changed event)
 * buys nothing: reuse the prefix by reference outright, deep-compare only
 * the boundary row where appends land, and fall back to the positional
 * deep-compare walk only when the tail probe says the prefix shifted.
 *
 * Without it every row is deep-compared — required when `prev` is a chat
 * store's log, whose rows the live stream has patched locally (tool results,
 * streaming flags), so an unchanged id says nothing about unchanged content.
 */
export function reconcileMessages(
  prev: ChatMessage[] | null,
  next: ChatMessage[],
  { settledPrefix = false }: { settledPrefix?: boolean } = {},
): ChatMessage[] {
  if (!prev || prev.length === 0) return next

  // Append fast path. Settled rows never change bytes EXCEPT the `deleted`
  // flag, which exchange soft-delete flips on mid-array rows in place
  // (server deleteExchange keeps array length). So the prefix check is a
  // cheap scalar probe — id + deleted, no serialization — and only the last
  // 2 overlap rows (where streaming text / tool results / usage still land)
  // get the deep compare. Anything off-shape falls to the full walk.
  if (settledPrefix) {
    const overlap = Math.min(prev.length, next.length)
    const deepFrom = Math.max(0, prev.length - 2)
    let appendShape = next.length >= prev.length
    for (let i = 0; appendShape && i < deepFrom; i++) {
      if (prev[i].id !== next[i].id || prev[i].deleted !== next[i].deleted) appendShape = false
    }
    if (appendShape) {
      let reusedAll = prev.length === next.length
      const out = next.slice()
      for (let i = 0; i < deepFrom; i++) out[i] = prev[i]
      for (let i = deepFrom; i < overlap; i++) {
        if (JSON.stringify(prev[i]) === JSON.stringify(next[i])) {
          out[i] = prev[i]
        } else {
          reusedAll = false
        }
      }
      return reusedAll ? prev : out
    }
  }

  // Non-append rewrite (compact, soft-delete, repair) or no settled-prefix
  // guarantee: positional deep-compare, reusing whatever still matches so
  // unchanged rows keep identity for the memo comparator.
  let reusedAll = prev.length === next.length
  const out = next.map((m, i) => {
    const old = prev[i]
    if (old && JSON.stringify(old) === JSON.stringify(m)) return old
    reusedAll = false
    return m
  })
  return reusedAll ? prev : out
}
