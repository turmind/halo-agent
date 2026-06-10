/**
 * Bridge between the chat layer and the assistant's "face" — the live
 * `self.html` preview (see `.halo/canvas/self.html` + the `self`
 * skill). When the assistant emits a `<<<SHOW: …js… >>>` marker in a reply,
 * chat-handlers extracts the payload and calls `postToFace(payload)`, which
 * forwards it verbatim to every mounted HTML-preview iframe via postMessage.
 * The face page evals it against its own `self` API (sandboxed to the preview);
 * non-face HTML pages have no `haloFace` listener, so a stray post is a
 * harmless no-op.
 *
 * A module-level registry (rather than a DOM query or window broadcast) keeps
 * the iframe ref captured exactly where it's created — decoupled from URL
 * formatting, correct for split panes (every mounted preview registers and
 * receives the message), and a no-op when nothing is open (empty set).
 */
const faceIframes = new Set<HTMLIFrameElement>()

/** HtmlPreview calls this on mount; the returned fn unregisters on unmount. */
export function registerFaceIframe(el: HTMLIFrameElement): () => void {
  faceIframes.add(el)
  return () => { faceIframes.delete(el) }
}

/** Forward a line of face JS to every mounted preview. Verbatim — Halo never
 *  parses the face vocabulary, it only pipes the string through. */
export function postToFace(payload: string): void {
  for (const el of faceIframes) {
    try {
      el.contentWindow?.postMessage({ haloFace: payload }, '*')
    } catch {
      /* iframe torn down mid-iteration — ignore */
    }
  }
}
