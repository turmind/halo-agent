/**
 * Split `text` into chunks of at most `limit` chars for block-oriented
 * channels. Each cut prefers the last paragraph break (`\n\n`) inside the
 * window when it lies past the halfway mark, otherwise hard-cuts at `limit`.
 * The remainder is `trimStart`ed so a chunk never opens with the break's
 * leftover whitespace. Never yields an empty chunk.
 */
export function splitText(text: string, limit: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    const lastPara = window.lastIndexOf('\n\n')
    const cut = lastPara > limit / 2 ? lastPara + 2 : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).trimStart()
  }
  if (rest) out.push(rest)
  return out
}
