import { describe, it, expect } from 'vitest'
import { createSpeakerTracker, MIN_NEW_SPEAKER_S, SPEAKER_MATCH_THRESHOLD, splitBySpeakerRuns, type SpeakerRun } from '../src/stt/speakers.js'

/**
 * stt-local speaker logic (stt/speakers.ts), no audio:
 *  - tracker: cosine ≥ threshold joins, else a new speaker — unless the
 *    cluster is under MIN_NEW_SPEAKER_S and someone exists (joins nearest);
 *  - split: tokens → runs by timestamp (containing, else nearest), punctuation
 *    stays with the current piece, pieces tile the segment; tokens that don't
 *    spell the text → one piece under the speaker with the most audio.
 */

const at = (deg: number) => Float32Array.from([Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180)])

describe('speaker tracker', () => {
  it('matches by cosine against running centroids, founds new speakers below the threshold', () => {
    const t = createSpeakerTracker()
    expect(t.assign(at(0), 3)).toBe(0)
    // cos 30° = 0.87 → same; cos 80° = 0.17 → new.
    expect(t.assign(at(30), 3)).toBe(0)
    expect(t.assign(at(80), 3)).toBe(1)
    // Centroid of 0 is now at 15°: 60° is cos 0.71 from it, 20° from 1.
    expect(t.assign(at(60), 3)).toBe(1)
    expect(t.count).toBe(2)
    expect(SPEAKER_MATCH_THRESHOLD).toBeLessThan(Math.cos(Math.PI / 4))
  })

  it(`a cluster under ${MIN_NEW_SPEAKER_S}s joins the nearest speaker without moving its centroid`, () => {
    const t = createSpeakerTracker()
    expect(t.assign(at(0), 0.4)).toBe(0) // nobody yet → founds one regardless
    expect(t.assign(at(90), 5)).toBe(1)
    // 180°: cos −1 / 0 — matches nobody, but too short to found speaker 2.
    expect(t.assign(at(180), MIN_NEW_SPEAKER_S - 0.01)).toBe(1)
    expect(t.assign(at(180), MIN_NEW_SPEAKER_S)).toBe(2)
    // Speaker 1 still sits at 90° (cos 60° = 0.87 → 1); had the short cluster
    // pulled it to 135°, 60° would match nobody (0.26 / 0.5 / −0.5).
    expect(t.assign(at(60), 5)).toBe(1)
  })
})

describe('splitBySpeakerRuns', () => {
  const runs: SpeakerRun[] = [{ start: 0.2, end: 2, speaker: 0 }, { start: 2.4, end: 4, speaker: 1 }]

  it('one piece per speaker run; punctuation stays put; pieces tile the segment', () => {
    const tokens = ['你', '好', '。', '我', '是', '，', '二', '。']
    const timestamps = [0.3, 0.8, 1.5, 2.1, 2.6, 3.0, 3.4, 3.9]
    // 2.1 sits in the gap → nearest run (0 ends at 2, 1 starts at 2.4 → 0).
    expect(splitBySpeakerRuns('你好。我是，二。', tokens, timestamps, runs, 4.2)).toEqual([
      { start: 0, end: 2.4, text: '你好。我', speaker: 0 },
      { start: 2.4, end: 4.2, text: '是，二。', speaker: 1 },
    ])
  })

  it('English sub-word tokens with leading spaces: pieces trimmed, cut at the run start', () => {
    const tokens = ['Hi', ' there', '.', ' I', "'m", ' Bob', '.']
    const timestamps = [0.3, 0.9, 1.4, 2.5, 2.6, 3.1, 3.8]
    expect(splitBySpeakerRuns("Hi there. I'm Bob.", tokens, timestamps, runs, 4.2)).toEqual([
      { start: 0, end: 2.4, text: 'Hi there.', speaker: 0 },
      { start: 2.4, end: 4.2, text: "I'm Bob.", speaker: 1 },
    ])
  })

  it('the cut never falls outside the two tokens it separates', () => {
    // Speaker 1 interjects inside speaker 0's run: `b` (in both) goes to the
    // later-starting run; `c`'s piece would start at run 0's start (0), which
    // is before `b` — clamped to `b`'s time.
    const overlap: SpeakerRun[] = [{ start: 0, end: 3, speaker: 0 }, { start: 1, end: 1.5, speaker: 1 }]
    const tokens = ['a', 'b', 'c']
    const timestamps = [0.5, 1.2, 2]
    expect(splitBySpeakerRuns('abc', tokens, timestamps, overlap, 3).map((p) => [p.start, p.end, p.text, p.speaker])).toEqual([
      [0, 1, 'a', 0],
      [1, 1.2, 'b', 1],
      [1.2, 3, 'c', 0],
    ])
    // A token just before a run (nearest) → that piece starts at the token.
    const gap: SpeakerRun[] = [{ start: 0, end: 1, speaker: 0 }, { start: 2, end: 3, speaker: 1 }]
    expect(splitBySpeakerRuns('ab', ['a', 'b'], [0.5, 1.9], gap, 3).map((p) => [p.start, p.end])).toEqual([[0, 1.9], [1.9, 3]])
  })

  it('a later run reusing the same speaker merges with consecutive same-speaker tokens', () => {
    const same: SpeakerRun[] = [{ start: 0, end: 1, speaker: 3 }, { start: 1.5, end: 3, speaker: 3 }, { start: 3, end: 4, speaker: 1 }]
    expect(splitBySpeakerRuns('xyz', ['x', 'y', 'z'], [0.5, 2, 3.5], same, 4).map((p) => [p.text, p.speaker])).toEqual([['xy', 3], ['z', 1]])
  })

  it('a single speaker → the whole text, untouched', () => {
    expect(splitBySpeakerRuns('a b', ['a', ' b'], [0.1, 1], [{ start: 0, end: 1, speaker: 2 }, { start: 1.5, end: 2, speaker: 2 }], 2.5)).toEqual([{ start: 0, end: 2.5, text: 'a b', speaker: 2 }])
  })

  it('tokens that do not spell the text, or missing timestamps → whole text under the speaker with the most audio', () => {
    const whole = [{ start: 0, end: 4.2, text: '你好。我是二。', speaker: 1 }]
    const longer1: SpeakerRun[] = [{ start: 0, end: 1, speaker: 0 }, { start: 1, end: 4, speaker: 1 }]
    expect(splitBySpeakerRuns('你好。我是二。', ['你', '好'], [0.1, 0.5], longer1, 4.2)).toEqual(whole)
    expect(splitBySpeakerRuns('你好。我是二。', ['你好。', '我是二。'], undefined, longer1, 4.2)).toEqual(whole)
    expect(splitBySpeakerRuns('你好。我是二。', ['你好。', '我是二。'], [0.1], longer1, 4.2)).toEqual(whole)
  })

  it('only punctuation tokens → one piece (speaker with the most audio)', () => {
    expect(splitBySpeakerRuns('。', ['。'], [0.5], runs, 4.2)).toEqual([{ start: 0, end: 4.2, text: '。', speaker: 0 }])
  })
})
