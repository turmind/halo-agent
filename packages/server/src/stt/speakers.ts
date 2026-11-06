/**
 * Speaker labels for `speakers=1` streams (stt/engine.ts), pure logic only:
 *  - `createSpeakerTracker`: per-connection CAM++ centroids — a segment's
 *    local clusters (pyannote) are matched by cosine against them, so labels
 *    stay stable across VAD segments;
 *  - `splitBySpeakerRuns`: one decoded segment's tokens → one piece per
 *    speaker run, by the tokens' timestamps.
 *
 * Spec: .halo/docs/design/stt-local.md
 */

/** Cosine to a connection speaker's centroid at or above this = same speaker.
 *  CAM++ on four.wav: same speaker 0.59–0.78, different 0.40–0.50. */
export const SPEAKER_MATCH_THRESHOLD = 0.55
/** A local cluster with less audio than this never founds a new speaker once
 *  one exists — too little audio for a trustworthy embedding; it joins the
 *  nearest. */
export const MIN_NEW_SPEAKER_S = 1.0

export interface SpeakerRun {
  /** Seconds from the decoded segment's first sample. */
  start: number
  end: number
  /** Connection speaker index (`createSpeakerTracker().assign`). */
  speaker: number
}

export interface SpeakerPiece {
  /** Seconds from the decoded segment's first sample; pieces tile [0, duration]. */
  start: number
  end: number
  text: string
  speaker: number
}

function normalize(v: Float32Array): Float32Array {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return v.map((x) => x / n)
}

function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0, x = 0, y = 0
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i] }
  return x && y ? d / Math.sqrt(x * y) : 0
}

export function createSpeakerTracker(threshold = SPEAKER_MATCH_THRESHOLD) {
  /** Running sums of unit embeddings — cosine only needs the direction. */
  const centroids: Float32Array[] = []
  return {
    /** One local cluster (its embedding + seconds of audio) → speaker index. */
    assign(embedding: Float32Array, seconds: number): number {
      const e = normalize(embedding)
      let best = -1
      let bestSim = -2
      centroids.forEach((c, k) => {
        const s = cosine(c, e)
        if (s > bestSim) { bestSim = s; best = k }
      })
      if (best < 0 || (bestSim < threshold && seconds >= MIN_NEW_SPEAKER_S)) {
        centroids.push(e)
        return centroids.length - 1
      }
      // A short cluster forced onto its nearest speaker doesn't move that
      // speaker's centroid — only a real match does.
      if (bestSim >= threshold) {
        const c = centroids[best]
        for (let i = 0; i < c.length; i++) c[i] += e[i]
      }
      return best
    },
    get count() { return centroids.length },
  }
}

/** The run a token at `t` belongs to: containing (the latest-starting one if
 *  runs overlap), else the nearest. */
function runAt(runs: SpeakerRun[], t: number): SpeakerRun {
  let hit: SpeakerRun | null = null
  for (const r of runs) if (r.start <= t && t <= r.end && (!hit || r.start > hit.start)) hit = r
  if (hit) return hit
  let best = runs[0]
  let dist = Infinity
  for (const r of runs) {
    const d = Math.min(Math.abs(t - r.start), Math.abs(t - r.end))
    if (d < dist) { dist = d; best = r }
  }
  return best
}

const WORD = /[\p{L}\p{N}]/u

/**
 * `text` (trimmed) of one decoded segment → one piece per speaker run.
 * Consecutive same-speaker tokens form one piece; punctuation / whitespace
 * tokens stay with the current piece (a piece never starts with `，`). Piece
 * k > 0 starts where its speaker's run starts, clamped between the previous
 * piece's last token and its own first token; the first starts at 0, the last
 * ends at `duration`. `runs` must be non-empty. Tokens that don't spell out
 * `text` (or no timestamps) → the whole text under the speaker with the most
 * audio — the same rule as the Transcribe proxy's `splitBySpeaker`.
 */
export function splitBySpeakerRuns(text: string, tokens: string[] | undefined, timestamps: number[] | undefined, runs: SpeakerRun[], duration: number): SpeakerPiece[] {
  const audio = new Map<number, number>()
  for (const r of runs) audio.set(r.speaker, (audio.get(r.speaker) ?? 0) + r.end - r.start)
  const top = [...audio.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0]
  const whole = [{ start: 0, end: duration, text, speaker: top }]
  if (audio.size === 1 || !tokens || !timestamps || tokens.length !== timestamps.length || tokens.join('').trim() !== text) return whole

  const pieces: Array<{ speaker: number; first: number; last: number; at: number }> = []
  for (let i = 0; i < tokens.length; i++) {
    const cur = pieces.at(-1)
    // Leading non-word tokens are picked up by the first piece (first = 0).
    if (!WORD.test(tokens[i])) { if (cur) cur.last = i; continue }
    const run = runAt(runs, timestamps[i])
    if (cur && cur.speaker === run.speaker) { cur.last = i; continue }
    pieces.push(cur
      ? { speaker: run.speaker, first: i, last: i, at: Math.min(Math.max(run.start, timestamps[cur.last]), timestamps[i]) }
      : { speaker: run.speaker, first: 0, last: i, at: 0 })
  }
  if (pieces.length === 0) return whole
  return pieces.map((p, k) => ({
    start: p.at,
    end: pieces[k + 1]?.at ?? duration,
    text: tokens.slice(p.first, p.last + 1).join('').trim(),
    speaker: p.speaker,
  }))
}
