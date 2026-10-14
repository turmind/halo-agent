/** Weak If-None-Match comparison: `*`, or any listed tag equal once `W/` is dropped. */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false
  const bare = etag.replace(/^W\//, '')
  return header.split(',').some((t) => {
    const tag = t.trim()
    return tag === '*' || tag.replace(/^W\//, '') === bare
  })
}
