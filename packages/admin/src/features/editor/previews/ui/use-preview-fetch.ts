'use client'

import { useEffect, useState } from 'react'

/**
 * Fetch + parse an ArrayBuffer, with proper cancellation on unmount / url change.
 *
 * Returns { data, error, loading }:
 *   - loading true while fetch/parse is in flight
 *   - data set after success
 *   - error set on failure (AbortError is swallowed)
 *
 * The parse callback receives the fetched buffer and an AbortSignal; if it
 * calls another async API (e.g. a worker), it should forward the signal so
 * callers can cancel mid-parse.
 */
export function usePreviewFetch<T>(
  url: string,
  parse: (buf: ArrayBuffer, signal: AbortSignal) => Promise<T>,
  deps: React.DependencyList = [],
): { data: T | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    setLoading(true)
    setError(null)
    setData(null)

    async function run() {
      try {
        const res = await fetch(url, { signal: ac.signal })
        const buf = await res.arrayBuffer()
        if (cancelled) return
        const parsed = await parse(buf, ac.signal)
        if (!cancelled) {
          setData(parsed)
          setLoading(false)
        }
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      }
    }
    run()

    return () => {
      cancelled = true
      ac.abort()
    }
  }, [url, ...deps])

  return { data, error, loading }
}
