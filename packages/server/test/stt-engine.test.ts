import { describe, it, expect, vi } from 'vitest'
import { createSttEngine, MAX_PENDING_AUDIO_S, MAX_QUEUED_SEGMENTS, PAD_AFTER_S, PAD_BEFORE_S, SttError, type SherpaModule, type SttFinal } from '../src/stt/engine.js'

/**
 * stt-local engine queue + segment handling with a fake sherpa module (no
 * native addon, no model): the fake VAD turns every non-zero 512-sample
 * window run into a segment, the fake recognizer decodes on demand.
 *  - one decode at a time server-wide, FIFO;
 *  - segments padded PAD_BEFORE_S / PAD_AFTER_S (clamped to the stream);
 *  - `<|zh|>` → `zh`, empty text dropped;
 *  - > MAX_QUEUED_SEGMENTS waiting or > MAX_PENDING_AUDIO_S per stream → busy;
 *  - abort drops the stream's queued segments; a load failure → engine.
 */

const SR = 16000

/** Fake sherpa: VAD emits a segment when a run of non-zero windows ends (or on flush). */
function fakeSherpa(results: (samples: number) => { text: string; lang: string } = () => ({ text: 'x', lang: '<|zh|>' })) {
  const decodes: Array<{ samples: number; release: () => void }> = []
  let manual = false
  const mod: SherpaModule = {
    OfflineRecognizer: {
      async createAsync() {
        return {
          createStream() {
            let n = 0
            return { acceptWaveform: (w: { samples: Float32Array }) => { n = w.samples.length }, get n() { return n } } as never
          },
          decodeAsync(stream: { n: number }) {
            return new Promise<void>((resolve) => {
              decodes.push({ samples: stream.n, release: resolve })
              if (!manual) resolve()
            })
          },
          getResult: (stream: { n: number }) => results(stream.n),
        } as never
      },
    },
    Vad: class {
      pos = 0
      runStart = -1
      out: Array<{ start: number; samples: Float32Array }> = []
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
    } as never,
  }
  return { mod, decodes, hold: () => { manual = true } }
}

/** `seconds` of tone then `gap` s of silence, as s16le. */
function speech(seconds: number, gap = 1): Buffer {
  const b = Buffer.alloc(Math.round((seconds + gap) * SR) * 2)
  for (let i = 0; i < seconds * SR; i++) b.writeInt16LE(1000, i * 2)
  return b
}

async function open(fake = fakeSherpa()) {
  const engine = createSttEngine({ loadSherpa: async () => fake.mod, models: { filePath: (p) => p } })
  await engine.load()
  const finals: SttFinal[] = []
  const errors: SttError[] = []
  const stream = engine.open({ onFinal: (f) => finals.push(f), onError: (e) => errors.push(e) })
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
