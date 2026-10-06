/**
 * Bridge between the chat layer and the assistant's "face" — the live
 * `self.html` preview (see `.halo/canvas/self.html` + the `self`
 * skill). When the assistant emits a `<<<SHOW: …js… >>>` marker in a reply,
 * chat-handlers extracts the payload and calls `postToFace(payload)`, which
 * forwards it verbatim to every mounted face iframe via postMessage. The face
 * page evals it against its own `self` API (sandboxed to the preview).
 *
 * A module-level registry (rather than a DOM query or window broadcast) keeps
 * the iframe ref captured exactly where it's created — decoupled from URL
 * formatting, correct for split panes, and a no-op when nothing is open
 * (empty set). Only previews of `FACE_PATH` register (html-preview `face`).
 *
 * The way back (protocol: .halo/tmp/face-protocol.md): the face posts
 * `{ haloFaceAck: '<short text>' }` receipts and `{ haloFaceSnap: { data,
 * mimeType } }` frames (`self.snap()`) to its parent. Only messages whose
 * `source` is a registered face iframe's window are accepted. Receipts never
 * wake the agent: they wait here (deduped, last ACK_MAX) until the user's next
 * message carries them on its `[Face open: …]` line (use-chat). Snaps go to
 * the handler chat-handlers installs, behind the loop gate below.
 */

import { readHostTheme } from '@/shared/theme/palette'
import type { Lang } from '@/shared/i18n'

/** The face page, seeded into every workspace (server init). */
export const FACE_PATH = '.halo/canvas/self.html'

const faceIframes = new Set<HTMLIFrameElement>()

/** HtmlPreview (face) calls this on mount; the returned fn unregisters on unmount. */
export function registerFaceIframe(el: HTMLIFrameElement): () => void {
  faceIframes.add(el)
  ensureListener()
  return () => { faceIframes.delete(el) }
}

/** Forward a line of face JS to every mounted face. Verbatim — Halo never
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

// ── Intro on open ──────────────────────────────────────────────────────
// Turning the toggle on mounts a fresh iframe, and a post sent before its page
// listens is lost — so the intro waits for that iframe's `load` instead of a
// guessed delay. A face restored on refresh doesn't greet (nobody asked).
let introPending = false

export function requestFaceIntro(): void { introPending = true }

/** Hand one face the admin's current palette (`{ haloFaceTheme: { scheme,
 *  vars } }`). The face re-colours in place and sends no receipt — a theme
 *  switch is not something the agent needs to hear about. */
export function postFaceTheme(el: HTMLIFrameElement): void {
  const { theme, themeVars } = readHostTheme()
  try { el.contentWindow?.postMessage({ haloFaceTheme: { scheme: theme, vars: themeVars } }, '*') } catch { /* torn down */ }
}

/** Tell one face the admin's UI language (`{ haloFaceLang }`); it only
 *  remembers it for the next intro — a switch replays nothing, no receipt. */
export function postFaceLang(el: HTMLIFrameElement, lang: Lang): void {
  try { el.contentWindow?.postMessage({ haloFaceLang: lang }, '*') } catch { /* torn down */ }
}

/** HtmlPreview (face) calls this on iframe load. Theme and language go first:
 *  posts to one window arrive in order, so the intro already plays in its
 *  colours and its language. */
export function faceLoaded(el: HTMLIFrameElement, lang: Lang): void {
  postFaceTheme(el)
  postFaceLang(el, lang)
  if (!introPending) return
  introPending = false
  try { el.contentWindow?.postMessage({ haloFace: 'self.intro()' }, '*') } catch { /* torn down */ }
}

// ── Receipts ───────────────────────────────────────────────────────────
const ACK_MAX = 8
const ACK_LEN = 100
let acks: string[] = []

/** Queue one receipt. Brackets / newlines are flattened so a receipt can never
 *  close the `[Face open: …]` line early (titles strip it with `[^\]]*`). The
 *  same text twice keeps one copy, at the newest position. */
export function pushFaceAck(text: string): void {
  const line = text.replace(/[[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, ACK_LEN)
  if (!line) return
  acks = acks.filter((a) => a !== line)
  acks.push(line)
  if (acks.length > ACK_MAX) acks = acks.slice(-ACK_MAX)
}

/** Hand out the queued receipts and empty the queue. */
export function takeFaceAcks(): string[] {
  const out = acks
  acks = []
  return out
}

export function clearFaceAcks(): void { acks = [] }

/** The line every user message carries while the face toggle is on. */
export function faceContextLine(receipts: string[]): string {
  return `[Face open: ${FACE_PATH}${receipts.length ? ` · last: ${receipts.join(', ')}` : ''}]`
}

// ── Snapshots + loop gate ──────────────────────────────────────────────
// A snap becomes an image message, which starts a turn, whose reply may snap
// again. Two rules stop that: at most one snap per round (one chat:complete's
// replies — `faceRoundSettled`), and none at all from a round the snapshot
// itself started (`chain`, cleared only when the user sends a real message).
type SnapHandler = (data: string, mimeType: string) => boolean
let snapHandler: SnapHandler | null = null
let snapTaken = false
let snapChain = false
const SNAP_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])
const SNAP_MAX_CHARS = 8 * 1024 * 1024

/** chat-handlers installs the sender; it returns false when it declined
 *  (no session / tab no longer on screen — it records its own receipt). */
export function onFaceSnap(fn: SnapHandler): () => void {
  snapHandler = fn
  return () => { if (snapHandler === fn) snapHandler = null }
}

/** A round with replies settled on the tab on screen: a new snap budget. */
export function faceRoundSettled(): void { snapTaken = false }

/** The user sent a message of their own: the snap chain is broken. */
export function faceUserMessage(): void { snapChain = false }

function handleSnap(data: string, mimeType: string): void {
  if (snapTaken) { pushFaceAck('snap skipped (1 per round)'); return }
  if (snapChain) { pushFaceAck('snap skipped (chain)'); return }
  if (!snapHandler) { pushFaceAck('snap skipped'); return }
  if (snapHandler(data, mimeType)) { snapTaken = true; snapChain = true }
}

/** Route one window message. Exported for tests (jsdom can't stamp a
 *  MessageEvent's `source` with an iframe window). */
export function handleFaceMessage(data: unknown, source: unknown): void {
  if (!data || typeof data !== 'object') return
  const d = data as { haloFaceAck?: unknown; haloFaceSnap?: unknown }
  if (d.haloFaceAck === undefined && d.haloFaceSnap === undefined) return
  let fromFace = false
  for (const el of faceIframes) if (el.contentWindow && el.contentWindow === source) fromFace = true
  if (!fromFace) return
  if (typeof d.haloFaceAck === 'string') pushFaceAck(d.haloFaceAck)
  const snap = d.haloFaceSnap as { data?: unknown; mimeType?: unknown } | undefined
  if (snap && typeof snap.data === 'string' && snap.data && snap.data.length <= SNAP_MAX_CHARS
    && typeof snap.mimeType === 'string' && SNAP_MIME.has(snap.mimeType)) {
    handleSnap(snap.data, snap.mimeType)
  }
}

let listening = false
function ensureListener(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('message', (e) => handleFaceMessage(e.data, e.source))
}

/** Test-only: reset module state between cases. */
export function __resetFaceBridgeForTest(): void {
  acks = []; snapTaken = false; snapChain = false; introPending = false
}
