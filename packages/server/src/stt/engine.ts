/**
 * On-device STT engine (`stt-local`): one SenseVoice recognizer for the whole
 * server, one Silero VAD per stream, one global decode queue.
 *
 * - `sherpa-onnx-node` is imported on first `load()` — a missing native
 *   binary / unsupported platform is an `engine` error on that stream, never a
 *   boot failure. The CJS package's ESM namespace only exposes
 *   `OnlineRecognizer` + `default`, so everything is taken off `default`.
 * - Decoding runs on the libuv pool (`decodeAsync`), FIFO, one segment at a
 *   time server-wide; `NUM_THREADS` onnx threads for that one segment.
 * - The recognizer stays resident (~400 MB RSS) once loaded: dropping it +
 *   `global.gc()` gave back only 13–119 MB of ~325 MB in measurements and a
 *   reload climbs back to ~400 MB, so there is no idle release.
 *
 * Spec: .halo/docs/design/stt-local.md
 */
import os from 'node:os'
import { SENSE_VOICE_MODEL, SENSE_VOICE_TOKENS, SILERO_VAD_MODEL, sttModels, type SttModelManager } from './models.js'

export const SAMPLE_RATE = 16000
/** Silero v4 window at 16 kHz; sherpa wants exactly this per acceptWaveform. */
const VAD_WINDOW = 512

/** Speech-probability cut. 0.3 split Cantonese into fragments; the English
 *  sentence-head loss 0.5 caused is fixed by PAD_BEFORE_S instead. */
export const VAD_THRESHOLD = 0.5
/** Silence that ends a segment — also how late a final arrives after speech
 *  stops. Shorter cuts mid-sentence pauses into separate (worse) decodes. */
export const VAD_MIN_SILENCE_S = 0.5
/** Shorter blips (clicks, breaths) are not speech. */
export const VAD_MIN_SPEECH_S = 0.25
/** Hard cut for a monologue: bounds per-segment decode latency/memory
 *  (SenseVoice is non-streaming — nothing comes back until the segment ends). */
export const VAD_MAX_SPEECH_S = 20
/** Raw audio prepended to each segment: Silero fires a few windows into the
 *  first syllable, and at 0.5 it swallowed English heads ("Fous to…"). */
export const PAD_BEFORE_S = 0.3
/** Appended: soft word endings fall under the threshold before speech ends.
 *  0.3 + 0.2 = VAD_MIN_SILENCE_S, so padding never reaches into the
 *  neighbouring segment at a normal pause. */
export const PAD_AFTER_S = 0.2
/** Raw-audio ring per stream: must reach back past a max-length segment's
 *  start (20 s speech + 0.5 s silence + pad) when it is emitted. */
const RING_S = 30
/** Segments waiting server-wide (excluding the one decoding) before `busy`. */
export const MAX_QUEUED_SEGMENTS = 32
/** Audio one stream may have queued or decoding before `busy`. */
export const MAX_PENDING_AUDIO_S = 60

/** Half the cores, 1–4: a decode is bursty, the rest of the server keeps half. */
const NUM_THREADS = Math.min(4, Math.max(1, Math.floor(os.availableParallelism() / 2)))

export type SttErrorCode = 'model' | 'engine' | 'busy' | 'bad-request' | 'io'

export class SttError extends Error {
  constructor(readonly code: SttErrorCode, message: string) {
    super(message)
    this.name = 'SttError'
  }
}

/** The slice of sherpa-onnx-node used here — injectable for tests. */
export interface SherpaModule {
  OfflineRecognizer: { createAsync(config: Record<string, unknown>): Promise<SherpaRecognizer> }
  Vad: new (config: Record<string, unknown>, bufferSizeInSeconds: number) => SherpaVad
}
export interface SherpaRecognizer {
  createStream(): SherpaStream
  decodeAsync(stream: SherpaStream): Promise<unknown>
  getResult(stream: SherpaStream): { text?: string; lang?: string }
}
export interface SherpaStream {
  acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void
}
export interface SherpaVad {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  front(enableExternalBuffer?: boolean): { start: number; samples: Float32Array }
  pop(): void
  flush(): void
}

export interface SttFinal {
  /** Seconds from the stream's first accepted audio sample (padded bounds =
   *  exactly the audio that was decoded). */
  start: number
  end: number
  text: string
  /** `zh` / `en` / `yue` / `ja` / `ko` (SenseVoice's `<|…|>` stripped). */
  lang: string
}

export interface SttStream {
  /** s16le mono 16 kHz, any length (an odd trailing byte carries over). */
  write(pcm: Buffer): void
  /** Flush the VAD; resolves once every segment of this stream has been
   *  decoded and its final emitted (or the stream failed). */
  end(): Promise<void>
  /** Client gone: drop this stream's segments that haven't started decoding. */
  abort(): void
  stats(): { segments: number; audioSeconds: number }
}

export interface SttEngine {
  /** Import sherpa + create the recognizer once; rejects with `SttError('engine')`. */
  load(): Promise<void>
  /** Requires a resolved `load()`. Throws `SttError('engine')` if the VAD can't be created. */
  open(handlers: { onFinal(final: SttFinal): void; onError(err: SttError): void }): SttStream
}

const defaultLoadSherpa = async (): Promise<SherpaModule> => (await import('sherpa-onnx-node')).default as SherpaModule

const errMsg = (err: unknown) => err instanceof Error ? err.message : String(err)
const round3 = (s: number) => Math.round(s * 1000) / 1000

interface Job {
  owner: Owner
  samples: Float32Array
  start: number
  end: number
}
interface Owner {
  done(job: Job, result: { text?: string; lang?: string }): void
  fail(err: SttError): void
}

export function createSttEngine(deps: { loadSherpa?: () => Promise<SherpaModule>; models?: Pick<SttModelManager, 'filePath'> } = {}): SttEngine {
  const loadSherpa = deps.loadSherpa ?? defaultLoadSherpa
  const models = deps.models ?? sttModels
  let sherpa: SherpaModule | null = null
  let recognizer: SherpaRecognizer | null = null
  let loading: Promise<void> | null = null
  const queue: Job[] = []
  let decoding = false

  function load(): Promise<void> {
    if (recognizer) return Promise.resolve()
    // Not cached on failure: the next stream retries (a broken native install
    // fails fast again; a transient one recovers).
    loading ??= doLoad().finally(() => { loading = null })
    return loading
  }

  async function doLoad(): Promise<void> {
    const t0 = Date.now()
    try {
      const m = await loadSherpa()
      recognizer = await m.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          // language '' = auto: setting one barely changed results in testing.
          senseVoice: { model: models.filePath(SENSE_VOICE_MODEL), language: '', useInverseTextNormalization: 1 },
          tokens: models.filePath(SENSE_VOICE_TOKENS),
          numThreads: NUM_THREADS,
          provider: 'cpu',
          debug: 0,
        },
      })
      sherpa = m
      console.log(`[STT] engine loaded in ${Date.now() - t0}ms (threads=${NUM_THREADS})`)
    } catch (err) {
      console.log(`[STT] engine load failed: ${errMsg(err)}`)
      throw new SttError('engine', `speech engine unavailable: ${errMsg(err)}`)
    }
  }

  async function pump(): Promise<void> {
    if (decoding || !recognizer) return
    decoding = true
    while (queue.length > 0) {
      const job = queue.shift()!
      try {
        const stream = recognizer.createStream()
        stream.acceptWaveform({ samples: job.samples, sampleRate: SAMPLE_RATE })
        await recognizer.decodeAsync(stream)
        job.owner.done(job, recognizer.getResult(stream))
      } catch (err) {
        job.owner.fail(new SttError('engine', `decode failed: ${errMsg(err)}`))
      }
    }
    decoding = false
  }

  function open(handlers: { onFinal(final: SttFinal): void; onError(err: SttError): void }): SttStream {
    if (!sherpa) throw new SttError('engine', 'speech engine not loaded')
    let vad: SherpaVad
    try {
      vad = new sherpa.Vad({
        sileroVad: {
          model: models.filePath(SILERO_VAD_MODEL),
          threshold: VAD_THRESHOLD,
          minSilenceDuration: VAD_MIN_SILENCE_S,
          minSpeechDuration: VAD_MIN_SPEECH_S,
          maxSpeechDuration: VAD_MAX_SPEECH_S,
          windowSize: VAD_WINDOW,
        },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        debug: false,
      }, RING_S)
    } catch (err) {
      throw new SttError('engine', `VAD unavailable: ${errMsg(err)}`)
    }

    const ringLen = RING_S * SAMPLE_RATE
    const ring = new Float32Array(ringLen)
    const win = new Float32Array(VAD_WINDOW)
    let winFill = 0
    /** Samples accepted so far = absolute index of the next one. */
    let total = 0
    let carry: Buffer | null = null
    /** Padded end of the previous segment — the next one's padding stops there. */
    let prevEnd = 0
    let pendingSamples = 0
    let inFlight = 0
    let segments = 0
    let decodedSamples = 0
    let stopped = false
    let drained: (() => void) | null = null

    const checkDrain = () => {
      if (drained && (stopped || inFlight === 0)) { const d = drained; drained = null; d() }
    }
    const dropQueued = () => {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].owner !== owner) continue
        pendingSamples -= queue[i].samples.length
        inFlight--
        queue.splice(i, 1)
      }
    }
    /** Single failure path (decode error, caps, VAD throw): stop, drop the
     *  rest of this stream's queue, report once. */
    function failStream(err: SttError): void {
      if (stopped) return
      stopped = true
      dropQueued()
      handlers.onError(err)
      checkDrain()
    }
    const owner: Owner = {
      done(job, result) {
        pendingSamples -= job.samples.length
        inFlight--
        if (!stopped) {
          segments++
          decodedSamples += job.samples.length
          const text = (result.text ?? '').trim()
          if (text) handlers.onFinal({ start: round3(job.start / SAMPLE_RATE), end: round3(job.end / SAMPLE_RATE), text, lang: (result.lang ?? '').replace(/<\|([^|]*)\|>/g, '$1') })
        }
        checkDrain()
      },
      fail(err) {
        inFlight--
        failStream(err)
        checkDrain()
      },
    }

    function enqueue(segStart: number, segEnd: number): void {
      const start = Math.max(segStart - PAD_BEFORE_S * SAMPLE_RATE, prevEnd, total - ringLen, 0)
      const end = Math.min(segEnd + PAD_AFTER_S * SAMPLE_RATE, total)
      if (end <= start) return
      prevEnd = end
      if (queue.length >= MAX_QUEUED_SEGMENTS) {
        failStream(new SttError('busy', `decode queue full (${MAX_QUEUED_SEGMENTS} segments waiting)`))
        return
      }
      if ((pendingSamples + end - start) / SAMPLE_RATE > MAX_PENDING_AUDIO_S) {
        failStream(new SttError('busy', `more than ${MAX_PENDING_AUDIO_S}s of audio waiting to be decoded`))
        return
      }
      const samples = new Float32Array(end - start)
      for (let i = 0; i < samples.length; i++) samples[i] = ring[(start + i) % ringLen]
      pendingSamples += samples.length
      inFlight++
      queue.push({ owner, samples, start, end })
      void pump()
    }

    function drainVad(): void {
      while (!stopped && !vad.isEmpty()) {
        // Copy (false): only start + length are used, and Electron forbids
        // external buffers.
        const seg = vad.front(false)
        vad.pop()
        enqueue(seg.start, seg.start + seg.samples.length)
      }
    }

    function feed(samples: Float32Array): void {
      vad.acceptWaveform(samples)
      drainVad()
    }

    return {
      write(pcm) {
        if (stopped) return
        try {
          const bytes = carry ? Buffer.concat([carry, pcm]) : pcm
          const n = bytes.length >> 1
          carry = bytes.length & 1 ? Buffer.from(bytes.subarray(bytes.length - 1)) : null
          for (let i = 0; i < n && !stopped; i++) {
            const f = bytes.readInt16LE(i * 2) / 32768
            ring[total % ringLen] = f
            total++
            win[winFill++] = f
            if (winFill === VAD_WINDOW) { winFill = 0; feed(win) }
          }
        } catch (err) {
          failStream(new SttError('engine', `VAD failed: ${errMsg(err)}`))
        }
      },
      end() {
        if (!stopped) {
          try {
            // Last partial window: zero-filled for the VAD only (the ring keeps
            // the real samples; padding is clamped to `total`).
            if (winFill > 0) { win.fill(0, winFill); winFill = 0; feed(win) }
            vad.flush()
            drainVad()
          } catch (err) {
            failStream(new SttError('engine', `VAD failed: ${errMsg(err)}`))
          }
        }
        return new Promise<void>((resolve) => { drained = resolve; checkDrain() })
      },
      abort() {
        stopped = true
        dropQueued()
        checkDrain()
      },
      stats: () => ({ segments, audioSeconds: round3(decodedSamples / SAMPLE_RATE) }),
    }
  }

  return { load, open }
}

/** The server's instance. */
export const sttEngine = createSttEngine()
