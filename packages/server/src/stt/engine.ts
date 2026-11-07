/**
 * On-device STT engine (`stt-local`): one SenseVoice recognizer for the whole
 * server, one Silero VAD per open stream (pooled, reset on reuse), one global
 * decode queue.
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
 * - Speaker labels (`open(…, { speakers: true })`): the diarizer (pyannote
 *   segmentation + CAM++) and a CAM++ extractor are created on the first
 *   `load({ speakers: true })` only, then stay resident like the recognizer.
 *   Each segment is diarized inside the same FIFO job, right after its
 *   decode, so per-stream final order holds (stt/speakers.ts).
 *
 * Spec: .halo/docs/design/stt-local.md
 */
import os from 'node:os'
import { CAMPLUS_MODEL, PYANNOTE_SEG_MODEL, SENSE_VOICE_MODEL, SENSE_VOICE_TOKENS, SILERO_VAD_MODEL, sttModels, type SttModelManager } from './models.js'
import { createSpeakerTracker, splitBySpeakerRuns, type SpeakerPiece, type SpeakerRun } from './speakers.js'

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

/** pyannote clustering inside one segment (unknown speaker count): 0.6
 *  reproduced sherpa's reference labels on its 4-speaker test file. */
const DIAR_CLUSTER_THRESHOLD = 0.6
const DIAR_MIN_ON_S = 0.3
const DIAR_MIN_OFF_S = 0.5
/** Audio fed to one CAM++ embedding: `compute` is sync on the event loop
 *  (~9 ms per 0.5 s, ~94 ms per 10 s), so this bounds the block. */
const EMBED_MAX_S = 6
/** Ceiling for one native diarization call (~1 s per 17 s of audio measured).
 *  sherpa-onnx-node 1.13.8's SpeakerDiarizationProcessWorker has no OnError,
 *  so a native failure never settles its promise and would wedge the global
 *  queue (all on-device STT) until restart; the real fix belongs upstream. */
const DIAR_TIMEOUT_MS = 60_000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms) })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

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
  OfflineSpeakerDiarization: new (config: Record<string, unknown>) => { handle: unknown }
  SpeakerEmbeddingExtractor: new (config: Record<string, unknown>) => SherpaEmbeddingExtractor
  /** From `addon.js` — the class only has a sync `process()`. Exactly 3 args. */
  offlineSpeakerDiarizationProcessAsync(handle: unknown, samples: Float32Array, progress: () => void): Promise<SherpaDiarSegment[]>
}
export interface SherpaRecognizer {
  createStream(): SherpaStream
  decodeAsync(stream: SherpaStream): Promise<unknown>
  getResult(stream: SherpaStream): SherpaResult
}
export interface SherpaResult {
  text?: string
  lang?: string
  /** Per token; `timestamps` in seconds from the decoded samples' start. */
  tokens?: string[]
  timestamps?: number[]
}
export interface SherpaStream {
  acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void
}
export interface SherpaEmbeddingExtractor {
  createStream(): SherpaStream & { inputFinished(): void }
  compute(stream: SherpaStream, enableExternalBuffer?: boolean): Float32Array
}
/** Seconds from the processed samples' start; `speaker` is local to that call. */
export interface SherpaDiarSegment { start: number; end: number; speaker: number }
export interface SherpaVad {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  front(enableExternalBuffer?: boolean): { start: number; samples: Float32Array }
  pop(): void
  flush(): void
  reset(): void
}

export interface SttFinal {
  /** Seconds from the stream's first accepted audio sample (padded bounds =
   *  exactly the audio that was decoded). */
  start: number
  end: number
  text: string
  /** `zh` / `en` / `yue` / `ja` / `ko` (SenseVoice's `<|…|>` stripped). */
  lang: string
  /** `speakers` streams only: `"0"`, `"1"`… per connection, in order of
   *  first appearance. A segment several people spoke in arrives as one
   *  final per speaker run. */
  speaker?: string
}

export interface SttStream {
  /** s16le mono 16 kHz, any length (an odd trailing byte carries over). */
  write(pcm: Buffer): void
  /** Flush the VAD; resolves once every segment of this stream has been
   *  decoded and its final emitted (or the stream failed). */
  end(): Promise<void>
  /** Client gone: drop this stream's segments that haven't started decoding. */
  abort(): void
  /** `speakers`: distinct speakers labelled so far (`speakers` streams only). */
  stats(): { segments: number; audioSeconds: number; speakers?: number }
}

export interface SttEngine {
  /** Import sherpa + create the recognizer once (+ the diarizer once, with
   *  `speakers`); rejects with `SttError('engine')`. */
  load(opts?: { speakers?: boolean }): Promise<void>
  /** Requires a resolved `load()` (with `speakers` if asked here). Throws
   *  `SttError('engine')` if the VAD can't be created. */
  open(handlers: { onFinal(final: SttFinal): void; onError(err: SttError): void }, opts?: { speakers?: boolean }): SttStream
}

// The async diarization entry point exists only on the native addon (the
// class wraps the sync one); the package has no `exports` map, so the subpath
// resolves. Both are the same CJS instance (shared require cache).
const defaultLoadSherpa = async (): Promise<SherpaModule> => {
  const [m, addon] = await Promise.all([import('sherpa-onnx-node'), import('sherpa-onnx-node/addon.js')])
  return { ...m.default, offlineSpeakerDiarizationProcessAsync: addon.default.offlineSpeakerDiarizationProcessAsync } as SherpaModule
}

const errMsg = (err: unknown) => err instanceof Error ? err.message : String(err)
const round3 = (s: number) => Math.round(s * 1000) / 1000

interface Job {
  owner: Owner
  samples: Float32Array
  start: number
  end: number
}
interface Owner {
  /** Live: a `speakers` stream that hasn't stopped — worth diarizing for. */
  wantsSpeakers(): boolean
  /** `diar`: this job's diarization (`wantsSpeakers()` + non-empty text only).
   *  Awaited by the queue, so a stream's finals stay in segment order. */
  done(job: Job, result: SherpaResult, diar: SherpaDiarSegment[] | null): Promise<void>
  fail(err: SttError): void
}

export function createSttEngine(deps: { loadSherpa?: () => Promise<SherpaModule>; models?: Pick<SttModelManager, 'filePath'> } = {}): SttEngine {
  const loadSherpa = deps.loadSherpa ?? defaultLoadSherpa
  const models = deps.models ?? sttModels
  let sherpa: SherpaModule | null = null
  let recognizer: SherpaRecognizer | null = null
  let loading: Promise<void> | null = null
  let diarizer: { handle: unknown } | null = null
  let extractor: SherpaEmbeddingExtractor | null = null
  let diarLoading: Promise<void> | null = null
  const queue: Job[] = []
  let decoding = false
  /** Reset VADs of finished streams. A `new Vad` per stream left each one's
   *  native onnx session + buffer (~4.6 MB) to a GC finalizer the small JS
   *  heap rarely runs: +690 MB RSS over 150 streams, flat with `gc()`. Grows
   *  to the peak number of open streams. */
  const vadPool: SherpaVad[] = []

  async function load(opts: { speakers?: boolean } = {}): Promise<void> {
    // Not cached on failure: the next stream retries (a broken native install
    // fails fast again; a transient one recovers).
    if (!recognizer) await (loading ??= doLoad().finally(() => { loading = null }))
    if (opts.speakers && !diarizer) await (diarLoading ??= doLoadDiarizer().finally(() => { diarLoading = null }))
  }

  /** Sync constructors (~0.3 s each, once per process): sherpa has no async
   *  factory for either. */
  async function doLoadDiarizer(): Promise<void> {
    const t0 = Date.now()
    try {
      const embedding = { model: models.filePath(CAMPLUS_MODEL), numThreads: NUM_THREADS, provider: 'cpu', debug: 0 }
      const d = new sherpa!.OfflineSpeakerDiarization({
        segmentation: { pyannote: { model: models.filePath(PYANNOTE_SEG_MODEL) }, numThreads: NUM_THREADS, provider: 'cpu', debug: 0 },
        embedding,
        clustering: { numClusters: -1, threshold: DIAR_CLUSTER_THRESHOLD },
        minDurationOn: DIAR_MIN_ON_S,
        minDurationOff: DIAR_MIN_OFF_S,
      })
      extractor = new sherpa!.SpeakerEmbeddingExtractor(embedding)
      diarizer = d
      console.log(`[STT] speaker diarizer loaded in ${Date.now() - t0}ms`)
    } catch (err) {
      console.log(`[STT] speaker diarizer load failed: ${errMsg(err)}`)
      throw new SttError('engine', `speaker labelling unavailable: ${errMsg(err)}`)
    }
  }

  /** CAM++ embedding of `samples`, at most EMBED_MAX_S of them. */
  function embed(samples: Float32Array): Float32Array {
    const s = extractor!.createStream()
    s.acceptWaveform({ samples: samples.subarray(0, EMBED_MAX_S * SAMPLE_RATE), sampleRate: SAMPLE_RATE })
    s.inputFinished()
    // Copy (false): Electron forbids external buffers.
    return extractor!.compute(s, false)
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
      let phase = 'decode'
      try {
        const stream = recognizer.createStream()
        stream.acceptWaveform({ samples: job.samples, sampleRate: SAMPLE_RATE })
        await recognizer.decodeAsync(stream)
        const result = recognizer.getResult(stream)
        let diar: SherpaDiarSegment[] | null = null
        if (job.owner.wantsSpeakers() && (result.text ?? '').trim()) {
          phase = 'speaker diarization'
          diar = await withTimeout(sherpa!.offlineSpeakerDiarizationProcessAsync(diarizer!.handle, job.samples, () => {}), DIAR_TIMEOUT_MS)
        }
        await job.owner.done(job, result, diar)
      } catch (err) {
        job.owner.fail(new SttError('engine', `${phase} failed: ${errMsg(err)}`))
      }
    }
    decoding = false
  }

  function open(handlers: { onFinal(final: SttFinal): void; onError(err: SttError): void }, opts: { speakers?: boolean } = {}): SttStream {
    if (!sherpa) throw new SttError('engine', 'speech engine not loaded')
    if (opts.speakers && !diarizer) throw new SttError('engine', 'speaker labelling not loaded')
    const speakers = opts.speakers ? createSpeakerTracker() : null
    /** Tracker index → wire label, assigned when first sent ("0", "1"…), so
     *  labels number in order of appearance even if a tracked speaker never
     *  ends up owning any text. */
    const labels = new Map<number, string>()
    let vad: SherpaVad
    try {
      vad = vadPool.pop() ?? new sherpa.Vad({
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
    /** end() flushed it or abort(): nothing feeds this VAD any more. */
    let vadReleased = false
    const releaseVad = () => {
      if (vadReleased) return
      vadReleased = true
      // A reset that throws (native alloc) drops this VAD instead of pooling it;
      // end() / abort() run in WS callbacks, where a throw would kill the process.
      try { vad.reset(); vadPool.push(vad) } catch (err) { console.log(`[STT] VAD reset failed, not pooled: ${errMsg(err)}`) }
    }

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
    /** One segment's local clusters → connection speakers → time runs.
     *  Longest cluster first, so a short one in the same segment already has
     *  someone to join (wire labels are numbered at send time, not here).
     *  Nothing diarized → the whole segment is one run. Yields before each
     *  (sync) embedding, so one segment blocks the loop for one embedding at
     *  a time, not all of them back to back; `null` = the stream stopped
     *  (abort / failure) during a yield — the rest isn't computed. */
    async function speakerRuns(samples: Float32Array, diar: SherpaDiarSegment[]): Promise<SpeakerRun[] | null> {
      const duration = samples.length / SAMPLE_RATE
      const tick = async () => { await new Promise<void>((r) => setImmediate(r)); return !stopped }
      if (diar.length === 0) return await tick() ? [{ start: 0, end: duration, speaker: speakers!.assign(embed(samples), duration) }] : null
      const clusters = new Map<number, SherpaDiarSegment[]>()
      for (const d of [...diar].sort((a, b) => a.start - b.start)) clusters.set(d.speaker, [...(clusters.get(d.speaker) ?? []), d])
      const seconds = (segs: SherpaDiarSegment[]) => segs.reduce((n, d) => n + d.end - d.start, 0)
      const runs: SpeakerRun[] = []
      for (const segs of [...clusters.values()].sort((a, b) => seconds(b) - seconds(a))) {
        // Its runs' audio back to back, capped (embed() caps again).
        const parts = segs.map((d) => samples.subarray(Math.round(d.start * SAMPLE_RATE), Math.round(d.end * SAMPLE_RATE)))
        const audio = new Float32Array(Math.min(parts.reduce((n, p) => n + p.length, 0), EMBED_MAX_S * SAMPLE_RATE))
        let at = 0
        for (const p of parts) { if (at >= audio.length) break; audio.set(p.subarray(0, audio.length - at), at); at += p.length }
        if (!await tick()) return null
        const speaker = speakers!.assign(embed(audio), seconds(segs))
        for (const d of segs) runs.push({ start: d.start, end: d.end, speaker })
      }
      return runs
    }

    const owner: Owner = {
      wantsSpeakers: () => speakers !== null && !stopped,
      async done(job, result, diar) {
        const text = (result.text ?? '').trim()
        // Labelled before inFlight drops: end() must not resolve while this
        // segment's finals are still being computed.
        let pieces: SpeakerPiece[] | null = null
        if (text && diar && !stopped) {
          try {
            const runs = await speakerRuns(job.samples, diar)
            if (runs) pieces = splitBySpeakerRuns(text, result.tokens, result.timestamps, runs, job.samples.length / SAMPLE_RATE)
          } catch (err) {
            failStream(new SttError('engine', `speaker labelling failed: ${errMsg(err)}`))
          }
        }
        pendingSamples -= job.samples.length
        inFlight--
        if (!stopped) {
          segments++
          decodedSamples += job.samples.length
          const lang = (result.lang ?? '').replace(/<\|([^|]*)\|>/g, '$1')
          const start = job.start / SAMPLE_RATE
          const end = job.end / SAMPLE_RATE
          if (pieces) {
            for (const p of pieces) {
              if (!labels.has(p.speaker)) labels.set(p.speaker, String(labels.size))
              handlers.onFinal({ start: round3(start + p.start), end: round3(Math.min(start + p.end, end)), text: p.text, lang, speaker: labels.get(p.speaker)! })
            }
          } else if (text) handlers.onFinal({ start: round3(start), end: round3(end), text, lang })
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
        if (stopped || vadReleased) return
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
        if (!stopped && !vadReleased) {
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
        // Segments are already copied out of the ring: the VAD is done.
        releaseVad()
        return new Promise<void>((resolve) => { drained = resolve; checkDrain() })
      },
      abort() {
        stopped = true
        releaseVad()
        dropQueued()
        checkDrain()
      },
      stats: () => ({ segments, audioSeconds: round3(decodedSamples / SAMPLE_RATE), ...(speakers ? { speakers: labels.size } : {}) }),
    }
  }

  return { load, open }
}

/** The server's instance. */
export const sttEngine = createSttEngine()
