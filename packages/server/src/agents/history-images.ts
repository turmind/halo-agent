/**
 * Image blocks in the replayed conversation history.
 *
 * Every request re-sends the whole history, images included, so their base64
 * accumulates turn over turn. Token-based auto-compact doesn't see it (an
 * image costs ~1.5K tokens but can be >1 MB of base64): a session with 31
 * view_image'd 896px PNGs sat at 113K tokens yet a 34 MB request body, over
 * Bedrock's ~32 MB cap ("Input is too long."). `trimHistoryImages` bounds the
 * total before each model call; `replaceImageBlocks` is the 4xx-multimodal
 * degrade that drops them all.
 */
import type { AnthropicMessage, ContentBlock } from './agent-loop.js'

/** Trim when history images exceed either ceiling, then cut down to half of
 *  both — the slack means one trim per ~half-budget of new images instead of
 *  one per call (each trim rewrites early history, busting the prompt cache).
 *  20 MB leaves headroom under Bedrock's ~32 MB body cap for the text; 100 is
 *  Anthropic's per-request image count cap. */
const MAX_IMAGE_B64 = 20 * 1024 * 1024
const MAX_IMAGES = 100

const TRIM_PLACEHOLDER = '[image removed: older image dropped to keep the request under the size limit — view_image it again if still needed]'

/** Rebuild the history with each image block (top-level uploads AND images
 *  nested in tool_result content, e.g. view_image) passed through `fn` in
 *  order, oldest first; a returned string replaces the block with that text.
 *  Reassigns each message's `content` array (blocks are copied, not edited).
 *  Returns the number replaced. */
function mapImageBlocks(messages: AnthropicMessage[], fn: (index: number) => string | null): number {
  let index = 0
  let replaced = 0
  const visit = <B extends { type: string }>(b: B): B | { type: 'text'; text: string } => {
    if (b.type !== 'image') return b
    const text = fn(index++)
    if (text === null) return b
    replaced++
    return { type: 'text', text }
  }
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    m.content = m.content.map((b): ContentBlock => (
      b.type === 'tool_result' && Array.isArray(b.content) ? { ...b, content: b.content.map(visit) } : visit(b)
    ))
  }
  return replaced
}

/** base64 length of every history image, oldest first. */
function imageSizes(messages: AnthropicMessage[]): number[] {
  const sizes: number[] = []
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b.type === 'image') sizes.push(b.source.data.length)
      else if (b.type === 'tool_result' && Array.isArray(b.content)) {
        for (const ib of b.content) if (ib.type === 'image') sizes.push(ib.source.data.length)
      }
    }
  }
  return sizes
}

/** Replace every image block with a text placeholder. Used by runAgentTurn's
 *  4xx-multimodal degrade path: once a provider rejects an image, the block
 *  re-fails EVERY subsequent request (history is replayed wholesale), so
 *  removal is the only way to unbrick the session. */
export function replaceImageBlocks(messages: AnthropicMessage[], reason: string): number {
  return mapImageBlocks(messages, () => `[image removed: ${reason}]`)
}

/** Over either ceiling → replace the OLDEST images with a placeholder until
 *  both are back under half. Runs before every model call (cheap scan when
 *  under budget). Mutates `messages` in place; returns the number replaced. */
export function trimHistoryImages(messages: AnthropicMessage[]): number {
  const sizes = imageSizes(messages)
  let total = sizes.reduce((a, b) => a + b, 0)
  if (total <= MAX_IMAGE_B64 && sizes.length <= MAX_IMAGES) return 0
  let drop = 0
  while (drop < sizes.length && (total > MAX_IMAGE_B64 / 2 || sizes.length - drop > MAX_IMAGES / 2)) {
    total -= sizes[drop++]
  }
  return mapImageBlocks(messages, (i) => (i < drop ? TRIM_PLACEHOLDER : null))
}
