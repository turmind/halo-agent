import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSttEngine, MAX_PENDING_AUDIO_S, MAX_QUEUED_SEGMENTS, PAD_AFTER_S, PAD_BEFORE_S, SttError, type SherpaDiarSegment, type SherpaModule, type SherpaResult, type SttFinal } from '../src/stt/engine.js'

/**
 * stt-local engine queue + segment handling with a fake sherpa module (no
 * native addon, no model): the fake VAD turns every non-zero 512-sample
 * window run into a segment, the fake recognizer decodes on demand.
 *  - one decode at a time server-wide, FIFO;
 *  - segments padded PAD_BEFORE_S / PAD_AFTER_S (clamped to the stream);
 *  - `<|zh|>` → `zh`, empty text dropped;
 *  - > MAX_QUEUED_SEGMENTS waiting or > MAX_PENDING_AUDIO_S per stream → busy;
 *  - abort drops the stream's queued segments; a load failure → engine;
 *  - a closed stream's VAD is reset and pooled (once), not re-created;
 *  - `speakers`: diarizer loaded lazily, once; finals split per speaker run
 *    with per-connection labels; short clusters join the nearest speaker;
 *    token/text mismatch and no diarization fall back to one final; a
 *    diarization that never settles times out without wedging the queue;
 *    end() / abort() with a diarization job in flight.
 */

const SR = 16000

/** Speaker of a fake sample: tones are written at amplitude 1000 × level. */
const levelOf = (x: number) => Math.round(x * 32768 / 1000)

/** Fake sherpa: VAD emits a segment when a run of non-zero windows ends (or on flush).
 *  Diarizer: one local cluster per tone level (numbered high level first, so
 *  local ids differ from the connection's); embedding of level k = the unit
 *  vector at k × 60° (neighbours cos 0.5, below the match threshold). */
function fakeSherpa(results: (samples: number, wave: Float32Array) => SherpaResult = () => ({ text: 'x', lang: '<|zh|>' })) {
  const decodes: Array<{ samples: number; release: () => void }> = []
  const diar = {
    ctor: 0, calls: 0, embeds: [] as number[], fail: null as Error | null, failProcess: null as Error | null, segments: null as SherpaDiarSegment[] | null,
    /** `hold`: process() waits for `releases[i]()`; `hang`: it never settles (sherpa 1.13.8 on a native error). */
    hold: false, hang: false, releases: [] as Array<() => void>, onEmbed: null as (() => void) | null,
  }
  let manual = false
  const vads = { ctor: 0 }
  const mod: SherpaModule = {
    OfflineRecognizer: {
      async createAsync() {
        return {
          createStream() {
            let wave = new Float32Array(0)
            return { acceptWaveform: (w: { samples: Float32Array }) => { wave = w.samples }, get n() { return wave.length }, get wave() { return wave } } as never
          },
          decodeAsync(stream: { n: number }) {
            return new Promise<void>((resolve) => {
              decodes.push({ samples: stream.n, release: resolve })
              if (!manual) resolve()
            })
          },
          getResult: (stream: { n: number; wave: Float32Array }) => results(stream.n, stream.wave),
        } as never
      },
    },
    Vad: class {
      pos = 0
      runStart = -1
      out: Array<{ start: number; samples: Float32Array }> = []
      constructor() { vads.ctor++ }
      acceptWaveform(w: Float32Array) {
        const speech = w.some((x) => x !== 0)
        if (speech && this.runStart < 0) this.runStart = this.pos
        if (!speech && this.runStart >= 0) this.close()
        this.pos += w.length
      }
      close() { this.out.push({ start: this.runStart, samples: new Float32Array(this.pos - this.runStart) }); this.runStart = -1 }
      isEmpty() { return this.out.length === 0 }
      front() { return this.out[0] }
      pop() { this.out.shift() }
      flush() { if (this.runStart >= 0) this.close() }
      reset() { this.pos = 0; this.runStart = -1; this.out = [] }
    } as never,
    OfflineSpeakerDiarization: class {
      handle = { fake: true }
      constructor() {
        diar.ctor++
        if (diar.fail) throw diar.fail
      }
    } as never,
    SpeakerEmbeddingExtractor: class {
      createStream() {
        let wave = new Float32Array(0)
        return { acceptWaveform: (w: { samples: Float32Array }) => { wave = w.samples }, inputFinished() {}, get wave() { return wave } }
      }
      compute(s: { wave: Float32Array }) {
        diar.embeds.push(s.wave.length)
        diar.onEmbed?.()
        const k = levelOf(s.wave.find((x) => x !== 0) ?? 0)
        return Float32Array.from([Math.cos(k * Math.PI / 3), Math.sin(k * Math.PI / 3)])
      }
    } as never,
    async offlineSpeakerDiarizationProcessAsync(_handle, samples, progress) {
      expect(typeof progress).toBe('function')
      diar.calls++
      if (diar.hang) return new Promise<never>(() => {})
      if (diar.hold) await new Promise<void>((r) => diar.releases.push(r))
      if (diar.failProcess) throw diar.failProcess
      if (diar.segments) return diar.segments
      const out: SherpaDiarSegment[] = []
      for (let i = 0; i < samples.length;) {
        const k = levelOf(samples[i])
        let j = i
        while (j < samples.length && levelOf(samples[j]) === k) j++
        if (k > 0) out.push({ start: i / SR, end: j / SR, speaker: 9 - k })
        i = j
      }
      return out
    },
  }
  return { mod, decodes, diar, vads, hold: () => { manual = true } }
}

/** Fake SenseVoice for tone input: one token per 0.25 s of tone — `a` for
 *  level 1, `b` for 2… — timed at the quarter's middle (where its level is
 *  read), then `。`. */
function toneTokens(_n: number, wave: Float32Array): SherpaResult {
  const tokens: string[] = []
  const timestamps: number[] = []
  for (let i = SR / 8; i < wave.length; i += SR / 4) {
    const k = levelOf(wave[i])
    if (k > 0) { tokens.push(String.fromCharCode(96 + k)); timestamps.push(i / SR) }
  }
  tokens.push('。')
  timestamps.push(wave.length / SR - 0.1)
  return { text: tokens.join(''), lang: '<|zh|>', tokens, timestamps }
}

/** Back-to-back tones `[seconds, level]` (one VAD segment), then `gap` s of silence. */
function voices(parts: Array<[number, number]>, gap = 1): Buffer {
  const total = parts.reduce((n, [s]) => n + s, 0)
  const b = Buffer.alloc(Math.round((total + gap) * SR) * 2)
  let at = 0
  for (const [s, k] of parts) {
    for (let i = 0; i < Math.round(s * SR); i++) b.writeInt16LE(1000 * k, (at + i) * 2)
    at += Math.round(s * SR)
  }
  return b
}

/** `seconds` of tone then `gap` s of silence, as s16le. */
function speech(seconds: number, gap = 1): Buffer {
  const b = Buffer.alloc(Math.round((seconds + gap) * SR) * 2)
  for (let i = 0; i < seconds * SR; i++) b.writeInt16LE(1000, i * 2)
  return b
}

async function open(fake = fakeSherpa(), speakers = false) {
  const engine = createSttEngine({ loadSherpa: async () => fake.mod, models: { filePath: (p) => p } })
  await engine.load({ speakers })
  const finals: SttFinal[] = []
  const errors: SttError[] = []
  const stream = engine.open({ onFinal: (f) => finals.push(f), onError: (e) => errors.push(e) }, { speakers })
  return { engine, stream, finals, errors, fake }
}

describe('stt engine', () => {
  it('pads each segment, strips <|lang|>, reports seconds from the first sample', async () => {
    const { stream, finals, errors } = await open()
    stream.write(Buffer.alloc(SR * 2)) // 1 s silence
    stream.write(speech(2))
    await stream.end()
    expect(errors).toEqual([])
    expect(finals).toHaveLength(1)
    // Fake VAD is window-quantized (512): speech 1.0 s → window starting at 0.992.
    const segStart = Math.floor(SR / 512) * 512 / SR
    expect(finals[0].start).toBeCloseTo(segStart - PAD_BEFORE_S, 3)
    expect(finals[0].lang).toBe('zh')
    expect(finals[0].end - finals[0].start).toBeGreaterThan(2 + PAD_BEFORE_S)
    expect(finals[0].end - finals[0].start).toBeLessThan(2 + PAD_BEFORE_S + PAD_AFTER_S + 0.1)
  })

  it('drops segments whose text is empty', async () => {
    const { stream, finals } = await open(fakeSherpa(() => ({ text: '  ', lang: '<|nospeech|>' })))
    stream.write(speech(1))
    await stream.end()
    expect(finals).toEqual([])
    expect(stream.stats().segments).toBe(1)
  })

  it('decodes one segment at a time across streams, FIFO', async () => {
    const fake = fakeSherpa()
    fake.hold()
    const a = await open(fake)
    const b = a.engine.open({ onFinal: (f) => a.finals.push({ ...f, text: 'b' }), onError: () => {} })
    a.stream.write(speech(1))
    b.write(speech(2))
    a.stream.write(speech(3))
    await vi.waitFor(() => expect(fake.decodes).toHaveLength(1))
    // Only one in flight while the first is held.
    await new Promise((r) => setTimeout(r, 20))
    expect(fake.decodes).toHaveLength(1)
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(fake.decodes).toHaveLength(i + 1))
      fake.decodes[i].release()
    }
    // Submission order: a's 1 s, b's 2 s, a's 3 s (each + padding).
    const lens = fake.decodes.map((d) => d.samples / SR)
    expect(lens[0]).toBeLessThan(lens[1])
    expect(lens[1]).toBeLessThan(lens[2])
    await vi.waitFor(() => expect(a.finals.map((f) => f.text)).toEqual(['x', 'b', 'x']))
  })

  it(`more than ${MAX_QUEUED_SEGMENTS} segments waiting → busy`, async () => {
    const fake = fakeSherpa()
    fake.hold()
    const { stream, errors } = await open(fake)
    // One decoding + MAX_QUEUED_SEGMENTS waiting fill the queue; the next is busy.
    for (let i = 0; i < MAX_QUEUED_SEGMENTS + 2 && errors.length === 0; i++) stream.write(speech(0.3, 0.3))
    expect(errors.map((e) => e.code)).toEqual(['busy'])
    expect(errors[0].message).toContain(`${MAX_QUEUED_SEGMENTS} segments`)
  })

  it(`more than ${MAX_PENDING_AUDIO_S}s of one stream's audio pending → busy`, async () => {
    const fake = fakeSherpa()
    fake.hold()
    const { stream, errors } = await open(fake)
    for (let i = 0; i < 5 && errors.length === 0; i++) stream.write(speech(15))
    expect(errors.map((e) => e.code)).toEqual(['busy'])
    expect(errors[0].message).toContain(`${MAX_PENDING_AUDIO_S}s`)
  })

  it('abort drops the stream\'s queued segments (the one decoding finishes silently)', async () => {
    const fake = fakeSherpa()
    fake.hold()
    const { engine, stream, finals } = await open(fake)
    stream.write(speech(1))
    stream.write(speech(1))
    stream.write(speech(1))
    await vi.waitFor(() => expect(fake.decodes).toHaveLength(1))
    stream.abort()
    fake.decodes[0].release()
    // A fresh stream's segment is next in line — the aborted ones are gone.
    const other: SttFinal[] = []
    const s2 = engine.open({ onFinal: (f) => other.push(f), onError: () => {} })
    s2.write(speech(1))
    await vi.waitFor(() => expect(fake.decodes).toHaveLength(2))
    fake.decodes[1].release()
    await s2.end()
    expect(fake.decodes).toHaveLength(2)
    expect(finals).toEqual([])
    expect(other).toHaveLength(1)
  })

  it('a closed stream\'s VAD is reset and reused; only concurrent streams create one', async () => {
    const { engine, stream, fake } = await open()
    const open2 = (finals: SttFinal[] = []) => engine.open({ onFinal: (f) => finals.push(f), onError: () => {} })
    // Aborted mid-speech: the VAD has an open run + 2 s of position.
    stream.write(Buffer.alloc(SR * 2))
    stream.write(speech(1, 0))
    stream.abort()
    const finals: SttFinal[] = []
    const b = open2(finals)
    const c = open2()
    expect(fake.vads.ctor).toBe(2)
    // Reset: one segment, at b's own 0.5 s (no leftover run, no carried position).
    b.write(Buffer.alloc(SR)) // 0.5 s silence
    b.write(speech(1))
    await b.end()
    b.abort() // the WS route aborts on close after end(): must not pool it twice
    expect(finals).toHaveLength(1)
    expect(finals[0].start).toBeCloseTo(Math.floor(SR / 2 / 512) * 512 / SR - PAD_BEFORE_S, 3)
    await c.end()
    open2()
    open2()
    expect(fake.vads.ctor).toBe(2)
    open2()
    expect(fake.vads.ctor).toBe(3)
  })

  it('a sherpa load failure is an engine error and is retried on the next load()', async () => {
    let fail = true
    const fake = fakeSherpa()
    const engine = createSttEngine({ loadSherpa: async () => { if (fail) throw new Error('Cannot find module sherpa-onnx-linux-x64'); return fake.mod }, models: { filePath: (p) => p } })
    await expect(engine.load()).rejects.toMatchObject({ code: 'engine' })
    expect(() => engine.open({ onFinal: () => {}, onError: () => {} })).toThrow(SttError)
    fail = false
    await engine.load()
    expect(() => engine.open({ onFinal: () => {}, onError: () => {} })).not.toThrow()
  })
})

describe('stt engine speakers', () => {
  it('without speakers: no diarizer, finals carry no speaker (even on a speakers-loaded engine)', async () => {
    const fake = fakeSherpa(toneTokens)
    const plain = await open(fake)
    plain.stream.write(voices([[1.5, 1], [1.5, 2]]))
    await plain.stream.end()
    expect(fake.diar.ctor).toBe(0)
    expect(plain.finals).toHaveLength(1)
    expect(Object.keys(plain.finals[0]).sort()).toEqual(['end', 'lang', 'start', 'text'])
    expect(plain.stream.stats()).not.toHaveProperty('speakers')

    await plain.engine.load({ speakers: true })
    const finals: SttFinal[] = []
    const s = plain.engine.open({ onFinal: (f) => finals.push(f), onError: () => {} })
    s.write(voices([[1.5, 1], [1.5, 2]]))
    await s.end()
    expect(fake.diar.calls).toBe(0)
    expect(finals.map((f) => f.speaker)).toEqual([undefined])
  })

  it('loads the diarizer lazily, once; open({speakers}) before that is an engine error', async () => {
    const fake = fakeSherpa()
    const engine = createSttEngine({ loadSherpa: async () => fake.mod, models: { filePath: (p) => p } })
    await engine.load()
    expect(fake.diar.ctor).toBe(0)
    expect(() => engine.open({ onFinal: () => {}, onError: () => {} }, { speakers: true })).toThrow(SttError)
    await Promise.all([engine.load({ speakers: true }), engine.load({ speakers: true })])
    await engine.load({ speakers: true })
    expect(fake.diar.ctor).toBe(1)
    expect(() => engine.open({ onFinal: () => {}, onError: () => {} }, { speakers: true })).not.toThrow()
  })

  it('a diarizer load failure is an engine error on that stream only, retried next time', async () => {
    const fake = fakeSherpa()
    fake.diar.fail = new Error('model.int8.onnx: no such file')
    const engine = createSttEngine({ loadSherpa: async () => fake.mod, models: { filePath: (p) => p } })
    await expect(engine.load({ speakers: true })).rejects.toMatchObject({ code: 'engine', message: expect.stringContaining('no such file') })
    // The recognizer did load: plain streams keep working.
    expect(() => engine.open({ onFinal: () => {}, onError: () => {} })).not.toThrow()
    fake.diar.fail = null
    await engine.load({ speakers: true })
    expect(fake.diar.ctor).toBe(2)
  })

  it('splits a segment into one final per speaker run, labels in order of appearance', async () => {
    const { stream, finals, errors } = await open(fakeSherpa(toneTokens), true)
    stream.write(voices([[1.5, 1], [1.5, 2], [1.5, 1]]))
    await stream.end()
    expect(errors).toEqual([])
    // One VAD segment (from 0, so no pre-pad) → three non-overlapping finals.
    expect(finals.map(({ speaker, text }) => ({ speaker, text }))).toEqual([
      { speaker: '0', text: 'aaaaaa' },
      { speaker: '1', text: 'bbbbbb' },
      { speaker: '0', text: 'aaaaaa。' },
    ])
    expect(finals.map((f) => [f.start, f.end])).toEqual([[0, 1.5], [1.5, 3], [3, finals[2].end]])
    expect(finals[2].end).toBeGreaterThan(4.5)
    expect(finals.every((f) => f.lang === 'zh')).toBe(true)
    expect(stream.stats().speakers).toBe(2)
  })

  it('keeps labels across segments of one connection; a new connection starts over', async () => {
    const { engine, stream, finals } = await open(fakeSherpa(toneTokens), true)
    stream.write(voices([[2, 2]]))
    stream.write(voices([[2, 1], [2, 2]]))
    await stream.end()
    // Letter = tone level; the later segment's pre-pad shifts the fake's
    // 0.25 s token grid, so counts aren't asserted.
    const shape = (fs: SttFinal[]) => fs.map((f) => `${f.speaker}:${f.text.replace(/(.)\1+/g, '$1')}`)
    expect(shape(finals)).toEqual(['0:b。', '1:a', '0:b。'])
    const other: SttFinal[] = []
    const s2 = engine.open({ onFinal: (f) => other.push(f), onError: () => {} }, { speakers: true })
    s2.write(voices([[2, 1]]))
    await s2.end()
    expect(other.map((f) => f.speaker)).toEqual(['0'])
  })

  it('a cluster under 1 s joins the nearest speaker instead of founding one', async () => {
    const { stream, finals } = await open(fakeSherpa(toneTokens), true)
    stream.write(voices([[3, 1], [0.5, 3]]))
    stream.write(voices([[3, 1], [1.5, 3]]))
    await stream.end()
    // The short `c` cluster stays with speaker 0; a long one founds speaker 1.
    expect(finals.map((f) => f.speaker)).toEqual(['0', '0', '1'])
    expect(finals[0].text).toBe('aaaaaaaaaaaacc。')
    expect(finals[1].text).toMatch(/^a+c?$/)
    expect(finals[2].text).toMatch(/^c+。$/)
  })

  it('tokens that do not spell the text → whole text under the speaker with the most audio', async () => {
    const { stream, finals } = await open(fakeSherpa(() => ({ text: ' 你好，世界。 ', lang: '<|zh|>', tokens: ['你', '好'], timestamps: [0.1, 0.5] })), true)
    stream.write(voices([[1, 1], [2, 2]]))
    await stream.end()
    expect(finals).toHaveLength(1)
    expect(finals[0]).toMatchObject({ start: 0, text: '你好，世界。', speaker: '0' })
    expect(finals[0].end).toBeGreaterThan(3)
  })

  it('nothing diarized → the whole segment is one final under one speaker', async () => {
    const fake = fakeSherpa(toneTokens)
    fake.diar.segments = []
    const { stream, finals } = await open(fake, true)
    stream.write(voices([[1.5, 1], [1.5, 2]]))
    await stream.end()
    expect(finals.map((f) => [f.speaker, f.text])).toEqual([['0', 'aaaaaabbbbbb。']])
  })

  it('caps the audio fed to one embedding at 6 s; skips diarization for empty text', async () => {
    let text = true
    const fake = fakeSherpa((n, w) => (text ? toneTokens(n, w) : { text: '', lang: '<|nospeech|>' }))
    const { stream, finals } = await open(fake, true)
    stream.write(voices([[10, 1]]))
    await vi.waitFor(() => expect(finals).toHaveLength(1))
    expect(fake.diar.embeds).toEqual([6 * SR])
    text = false
    stream.write(voices([[1, 1]]))
    await stream.end()
    expect(fake.diar.calls).toBe(1)
  })

  it('a diarization failure fails the stream with engine', async () => {
    const fake = fakeSherpa(toneTokens)
    fake.diar.failProcess = new Error('onnx run failed')
    const { stream, finals, errors } = await open(fake, true)
    stream.write(voices([[1, 1]]))
    await stream.end()
    expect(finals).toEqual([])
    expect(errors.map((e) => [e.code, e.message])).toEqual([['engine', 'speaker diarization failed: onnx run failed']])
  })

  describe('with a diarization job in flight', () => {
    afterEach(() => { vi.useRealTimers() })

    it('a diarization that never settles times out → engine error; the queue keeps going', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const fake = fakeSherpa(toneTokens)
      fake.diar.hang = true
      const a = await open(fake, true)
      const other: SttFinal[] = []
      const b = a.engine.open({ onFinal: (f) => other.push(f), onError: () => {} })
      a.stream.write(voices([[1, 1]]))
      b.write(speech(1))
      await vi.advanceTimersByTimeAsync(0)
      expect(fake.diar.calls).toBe(1)
      expect(fake.decodes).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(59_000)
      expect(a.errors).toEqual([])
      expect(other).toEqual([])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(a.errors.map((e) => [e.code, e.message])).toEqual([['engine', 'speaker diarization failed: timed out']])
      expect(a.finals).toEqual([])
      // The other stream's segment, queued behind the hung one, decodes.
      await b.end()
      expect(fake.decodes).toHaveLength(2)
      expect(other).toHaveLength(1)
    })

    it('end() waits for it, then resolves with its finals', async () => {
      const fake = fakeSherpa(toneTokens)
      fake.diar.hold = true
      const { stream, finals } = await open(fake, true)
      stream.write(voices([[1.5, 1], [1.5, 2]]))
      let ended = false
      const end = stream.end().then(() => { ended = true })
      await vi.waitFor(() => expect(fake.diar.releases).toHaveLength(1))
      await new Promise((r) => setTimeout(r, 20))
      expect(ended).toBe(false)
      fake.diar.releases[0]()
      await end
      expect(finals.map((f) => f.speaker)).toEqual(['0', '1'])
    })

    it('abort() drops its result and the stream\'s queued segments; the next stream runs', async () => {
      const fake = fakeSherpa(toneTokens)
      fake.diar.hold = true
      const { engine, stream, finals, errors } = await open(fake, true)
      stream.write(voices([[1, 1]]))
      stream.write(voices([[1, 2]]))
      await vi.waitFor(() => expect(fake.diar.releases).toHaveLength(1))
      stream.abort()
      fake.diar.releases[0]()
      const other: SttFinal[] = []
      const s2 = engine.open({ onFinal: (f) => other.push(f), onError: () => {} })
      s2.write(speech(1))
      await s2.end()
      expect(finals).toEqual([])
      expect(errors).toEqual([])
      expect(fake.diar.calls).toBe(1)
      expect(fake.diar.embeds).toEqual([])
      expect(fake.decodes).toHaveLength(2)
      expect(other).toHaveLength(1)
    })

    it('abort() during the embedding loop stops before the next embedding', async () => {
      const fake = fakeSherpa(toneTokens)
      const { engine, stream, finals } = await open(fake, true)
      fake.diar.onEmbed = () => stream.abort()
      stream.write(voices([[1.5, 1], [1.5, 2]]))
      // abort() resolves end() at once; a stream queued behind the job ends
      // only after the job (and its embedding loop) has finished.
      const s2 = engine.open({ onFinal: () => {}, onError: () => {} })
      s2.write(speech(1))
      await stream.end()
      await s2.end()
      // Two clusters, one embedding: the loop saw `stopped` after its yield.
      expect(fake.diar.embeds).toHaveLength(1)
      expect(finals).toEqual([])
    })
  })
})
