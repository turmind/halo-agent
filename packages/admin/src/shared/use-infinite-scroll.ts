'use client'

import { useEffect, useRef } from 'react'

/** Infinite-scroll trigger: attach the returned ref to a sentinel element at
 *  the bottom of the list; `loadMore` fires when it scrolls into view (64px
 *  early). Cheaper than a scroll listener and naturally handles container
 *  size changes. `itemCount` re-attaches the observer after each appended
 *  page so the sentinel's new position is observed. */
export function useInfiniteScroll<T extends Element>(loadMore: () => Promise<void>, itemCount: number) {
  const sentinelRef = useRef<T | null>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void loadMore()
    }, { rootMargin: '64px' })
    io.observe(el)
    return () => io.disconnect()
  }, [loadMore, itemCount])
  return sentinelRef
}
