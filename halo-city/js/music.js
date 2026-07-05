// Procedurally generated ambient background music — pure Web Audio API, no
// audio assets, no network. A slow lo-fi pad drifts through a warm C-major
// I–vi–IV–V progression (maj9 / add9 voicings, ~24s per chord with long
// crossfades), plus a sparse pentatonic pluck with a soft echo tail. Every
// node runs behind one master gain + gentle lowpass so nothing is ever harsh,
// and the whole graph is independent of the canvas render loop.
//
// Browsers gate audio behind a user gesture, so the AudioContext is created
// on the first pointerdown / keydown anywhere. The 🎵 HUD button toggles it
// (preference persisted in localStorage, default on); toggling off truly
// suspends the AudioContext — zero CPU while muted.
import { t, onLangChange } from './i18n.js'

const LS_KEY = 'halo_city_music'
const MASTER_VOL = 0.055        // sleep-friendly: barely-there by default
const FADE_S = 1                // toggle fade in/out (no clicks/pops)
const CHORD_S = 24              // seconds per chord
const XFADE_S = 8               // attack/release overlap between chords

// MIDI voicings, C major, no leading-tone tension:
//   Cmaj9 → Am9 → Fmaj9 → G(add9)
// Bass sits at C3+ — sub-100Hz sustained tones (old F2/G2 roots) read as a
// headache-inducing hum, so everything below C3 was lifted an octave.
const CHORDS = [
  [48, 55, 64, 71, 74],         // C3 G3 E4 B4 D5 — Cmaj9
  [57, 64, 60, 67, 71],         // A3 E4 C4 G4 B4 — Am9
  [53, 60, 64, 67, 69],         // F3 C4 E4 G4 A4 — Fmaj9
  [55, 62, 59, 69, 74],         // G3 D4 B3 A4 D5 — G(add9)
]
const NOTE_LEVELS = [0.14, 0.11, 0.09, 0.07, 0.06]  // quieter as we go up
const PLUCK_NOTES = [60, 62, 64, 67, 69, 72]        // C major pentatonic C4–C5
                                                    // (was C5–C6 — an octave too
                                                    // eerie at night; keep it low)

const hz = (m) => 440 * Math.pow(2, (m - 69) / 12)

let musicOn = loadPref()
let ctx = null                  // created lazily on first gesture
let master = null               // master gain — all fades happen here
let pluckSend = null            // pluck → echo (feedback delay) input
let voices = []                 // live pad chords: { gain, oscs }
let chordIdx = 0
let nextChordAt = 0             // ctx time of the next chord change
let chordTimer = 0
let pluckTimer = 0
let btn = null

function loadPref() {
  try { return localStorage.getItem(LS_KEY) !== 'off' } catch { return true }
}

// ── audio graph ──
function ensureCtx() {
  if (ctx) return
  ctx = new (window.AudioContext || window.webkitAudioContext)()

  // master gain → lowpass → out. The lowpass keeps everything mellow; a very
  // slow LFO drifts its cutoff so the pad subtly breathes over ~50s.
  master = ctx.createGain()
  master.gain.value = 0
  const lowpass = ctx.createBiquadFilter()
  lowpass.type = 'lowpass'
  lowpass.frequency.value = 1100
  lowpass.Q.value = 0.4
  master.connect(lowpass)
  lowpass.connect(ctx.destination)
  const lfo = ctx.createOscillator()
  lfo.frequency.value = 0.02
  const lfoAmt = ctx.createGain()
  lfoAmt.gain.value = 350
  lfo.connect(lfoAmt)
  lfoAmt.connect(lowpass.frequency)
  lfo.start()

  // pluck echo: damped feedback delay, reverb-ish long tail
  const delay = ctx.createDelay(2)
  delay.delayTime.value = 0.5
  const damp = ctx.createBiquadFilter()
  damp.type = 'lowpass'
  damp.frequency.value = 1000
  const fb = ctx.createGain()
  fb.gain.value = 0.45
  delay.connect(damp)
  damp.connect(fb)
  fb.connect(delay)
  damp.connect(master)
  pluckSend = ctx.createGain()
  pluckSend.gain.value = 0.7
  pluckSend.connect(delay)
}

function fadeTo(v) {
  const g = master.gain, now = ctx.currentTime
  g.cancelScheduledValues(now)
  g.setValueAtTime(g.value, now)
  g.linearRampToValueAtTime(v, now + FADE_S)
}

// One pad chord: per note a detuned sine+triangle pair into a note gain, all
// through a chord gain running a slow attack → sustain → release envelope.
// Envelope times use ctx.currentTime (sample-accurate); only the composition
// clock (which chord when) rides setTimeout.
function playChord() {
  const notes = CHORDS[chordIdx % CHORDS.length]
  chordIdx++
  const now = ctx.currentTime
  const end = now + CHORD_S + XFADE_S
  const chordGain = ctx.createGain()
  chordGain.gain.setValueAtTime(0, now)
  chordGain.gain.linearRampToValueAtTime(1, now + XFADE_S)
  chordGain.gain.setValueAtTime(1, now + CHORD_S)
  chordGain.gain.linearRampToValueAtTime(0, end)
  chordGain.connect(master)

  const oscs = []
  notes.forEach((m, i) => {
    const ng = ctx.createGain()
    ng.gain.value = NOTE_LEVELS[i] || 0.06
    ng.connect(chordGain)
    // One pure sine per note. The old sine+triangle pair hummed two ways:
    // the triangle's odd harmonics buzz in the low register, and any pair
    // of oscillators beats. Pure sines have no harmonics at all — nothing
    // left to buzz.
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.value = hz(m)
    o.connect(ng)
    o.start(now)
    o.stop(end + 0.1)
    oscs.push(o)
  })
  const voice = { gain: chordGain, oscs }
  voices.push(voice)
  oscs[0].onended = () => {
    chordGain.disconnect()
    voices = voices.filter((v) => v !== voice)
  }

  nextChordAt = now + CHORD_S
  chordTimer = setTimeout(playChord, CHORD_S * 1000)
}

// Sparse texture: one soft pentatonic note every 9–23s, long echo tail.
function playPluck() {
  const now = ctx.currentTime
  const o = ctx.createOscillator()
  o.type = 'triangle'
  o.frequency.value = hz(PLUCK_NOTES[Math.floor(Math.random() * PLUCK_NOTES.length)])
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, now)
  g.gain.exponentialRampToValueAtTime(0.035, now + 0.08)
  g.gain.exponentialRampToValueAtTime(0.0001, now + 4.5)
  o.connect(g)
  g.connect(master)
  g.connect(pluckSend)
  o.start(now)
  o.stop(now + 4.6)
  o.onended = () => g.disconnect()
}

function schedulePluck() {
  pluckTimer = setTimeout(() => { playPluck(); schedulePluck() }, 9000 + Math.random() * 14000)
}

// ── transport ──
function start() {
  ensureCtx()
  if (ctx.state === 'suspended') ctx.resume()
  clearTimeout(chordTimer)
  clearTimeout(pluckTimer)
  fadeTo(MASTER_VOL)
  // If re-toggled during the fade-out window, the old chord is still ringing
  // on schedule — rejoin at its planned change instead of stacking a new one.
  const delay = voices.length ? Math.max(0, nextChordAt - ctx.currentTime) * 1000 : 0
  if (delay > 0) chordTimer = setTimeout(playChord, delay)
  else playChord()
  schedulePluck()
}

function stop() {
  if (!ctx) return
  clearTimeout(chordTimer)
  clearTimeout(pluckTimer)
  fadeTo(0)
  // after the fade lands: silence the voices and suspend — zero CPU when off
  setTimeout(() => {
    if (musicOn) return   // re-toggled on during the fade
    for (const v of voices) {
      for (const o of v.oscs) { o.onended = null; try { o.stop() } catch { /* already stopped */ } }
      v.gain.disconnect()
    }
    voices = []
    ctx.suspend()
  }, FADE_S * 1000 + 80)
}

// ── UI ──
function syncBtn() {
  if (!btn) return
  btn.textContent = musicOn ? '🎵' : '🔇'
  btn.title = t(musicOn ? 'musicOn' : 'musicOff')
}

export function toggleMusic() {
  musicOn = !musicOn
  try { localStorage.setItem(LS_KEY, musicOn ? 'on' : 'off') } catch { /* ignore */ }
  if (musicOn) start()   // the click itself is a user gesture — safe to (re)start
  else stop()
  syncBtn()
}

export function initMusic() {
  btn = document.getElementById('btn-music')
  btn.addEventListener('click', toggleMusic)
  syncBtn()
  onLangChange(syncBtn)

  // audio is gated behind a user gesture: arm one-shot listeners; if the
  // preference is off, the toggle button (itself a gesture) starts it later
  const arm = () => {
    window.removeEventListener('pointerdown', arm)
    window.removeEventListener('keydown', arm)
    if (musicOn) start()
  }
  window.addEventListener('pointerdown', arm)
  window.addEventListener('keydown', arm)

  // debug/test handle (same convention as window.__world)
  window.__music = {
    isOn: () => musicOn,
    ctxState: () => (ctx ? ctx.state : null),
    masterGain: () => (master ? master.gain.value : 0),
    voiceCount: () => voices.length,
  }
}
