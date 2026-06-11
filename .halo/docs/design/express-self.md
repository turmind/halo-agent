# Express Self — Agent Visual Face Design

The agent has a living visual space at `.halo/canvas/self.html` — a particle field where it can form words, pulse, and react in real time. This is a second channel beyond text, parallel and immediate.

## Architecture

```
Agent reply stream with marker
         ↓
  <<<SHOW: self.say(...) >>>
         ↓
chat-handlers.ts (detect + extract)
         ↓
face-bridge.ts (postMessage to iframes)
         ↓
mounted HtmlPreview iframe
  (self.html listening)
         ↓
particle engine eval against `self` API
         ↓
canvas animation (visible to user)
```

The marker is **stripped from rendered chat** so the user sees only the face moving, not the code driving it.

## Data flow

**Seeding:** `init.ts` calls `ensureWorkspaceHalo()` on workspace open, force-copying the canonical engine from `packages/server/templates/canvas/self.html` to `<workspace>/.halo/canvas/self.html`.

**Runtime expression:** Agent emits `<<<SHOW: payload >>>` in a reply. On turn completion:
1. `chat-handlers.ts:maybeHandleShow()` detects all `<<<SHOW:[\s\S]*?>>>` markers (non-greedy, global)
2. For each match, extracts the payload (trimmed)
3. Calls `postToFace(payload)` to forward it
4. Deduplicates by `${msgId}#${occurrenceIndex}` so queue drains don't fire twice

**Forwarding:** `face-bridge.ts:postToFace()` posts to every registered iframe:
```javascript
el.contentWindow?.postMessage({ haloFace: payload }, '*')
```

**Reception:** `self.html` listens on `window.message`:
```javascript
window.addEventListener('message', (e) => {
  const code = e?.data?.haloFace
  if (typeof code !== 'string') return
  try { (new Function('self', code))(self) }
  catch (err) { /* malformed line no-ops */ }
})
```

**UI stripping:** `message-list.tsx:TextBlock()` strips both markers before render:
```javascript
parsed.replace(/<<<CAPTURE>>>/g, '')
      .replace(/<<<SHOW:[\s\S]*?>>>/g, '')
```

## The `self` API

Provided by `self.html` line 288 onwards. All expression methods are sandboxed to the preview iframe.

### Scene queuing (sequential playback)

- `self.say(text, ms)` — form `text` (emoji→ASCII), hold `ms` (default 3600), dissolve back to breathing. Enqueued.
- `self.play(score)` — choreograph a sequence of beats: `[{say, hold, pulse, flash, shake, rest, gap}, ...]`. Each beat waits for the engine's internal clock. Enqueued; calling play() again appends to the queue rather than cancelling it.
- `self.intro()` — built-in opening: "HELLO / A MIND / IS HERE / BEYOND WORDS". Triggered by whoever opens the face (the admin ✨ button posts it on open), **not** self-fired on page load — a self-fired load intro raced the button's post and played the greeting twice on first open. Nameless deliberately — the agent identity is user-configurable.

### Instant gestures (overlays, never queued)

- `self.pulse()` — one bright ripple from the core (acknowledgement).
- `self.flash(n)` — hot flicker of the whole field (emphasis). `n` scales duration.
- `self.shake(ms)` — lateral tremor (negation, error). Default 500ms.
- `self.rest()` — return to calm breathing immediately, clear queue; also stops a playing voice clip.

### Voice (live audio — mode `wave`)

- `self.voice(path)` — play a speech clip Halo synthesized and ride its **live** amplitude via a Web Audio `AnalyserNode`: loudness swells the core, a 6-band spectrum grows directional petals (timbre has a shape, not just a size), each syllable onset spawns a ring. Halo synthesizes the audio; the face only makes it visible — silent audio yields a calm face, never a canned animation. `path` is the **workspace path** of the audio file (mp3/wav/m4a/ogg); the engine resolves it to `/api/files/download?path=…&projectId=…&inline=1` using the `projectId` already in its own iframe `src`, so the agent never builds a URL or knows the projectId (a full `http(s)://` / `/api/…` URL also passes through unchanged). Not queued — it starts immediately, enters mode `wave`, owns the matrix until the clip ends (or `rest()`), then eases back to breathing.

### Reactions (named vocabulary)

- `self.react(event)` — switch on event: `'ack'` (nod), `'yes'`, `'no'`, `'insight'` (real "oh!"), `'think'`, `'done'`. Unknown events no-op.

### Introspection

- `self.state` — read `{mode, awake, W, H, speaking, level}` (current mode, attention level 0..1, viewport dims, whether a voice clip is playing, and its live loudness 0..1).

## Key files

- **Engine template:** `packages/server/templates/canvas/self.html` — particle field, mode switching, API surface, voice audio graph. ~630 lines. Canonical source; force-copied to every workspace on open.
- **Skill instruction:** `packages/server/templates/skills/self/SKILL.md` — teaches the agent when/how to use the face.
- **Marker detection:** `packages/admin/src/shared/ws-handlers/chat-handlers.ts:maybeHandleShow()` (lines 38–50) — regex match `<<<SHOW:([\s\S]*?)>>>` on turn completion, deduplicate by message ID + occurrence index.
- **Iframe registration:** `packages/admin/src/features/editor/face-bridge.ts` — module-level registry of mounted previews; `postToFace()` forwards payloads via `postMessage`.
- **Preview component:** `packages/admin/src/features/editor/html-preview.tsx` — sandboxed iframe with `allow-scripts` + `allow-same-origin` and `allow="autoplay"` (so `self.voice` audio, triggered by postMessage rather than a click, isn't gated), calls `registerFaceIframe()` on mount.
- **Marker stripping:** `packages/admin/src/shared/components/message-list.tsx:TextBlock()` (line 430) — strips both `<<<CAPTURE>>>` and `<<<SHOW:...>>>` before rendering.
- **Workspace init:** `packages/server/src/init.ts:ensureWorkspaceHalo()` (lines 487–518) — force-copies engine on workspace open. `self` is in `BUILTIN_SKILL_IDS` so the skill is always available.

## Engine architecture

The face is a fixed grid of particles. Each knows its current position and a target position, easing between them every frame.

- **Grid:** 22px spacing, 60fps animation loop
- **Modes:** `rest` (breathing grid), `text` (forming letters), `wave` (particles ride live audio amplitude during `self.voice`)
- **Glyph sampling:** Text→offscreen canvas→pixel alpha sampling→nearest-particle assignment (greedy scan with shuffle for repeated words)
- **Emoji accent:** Maps common emoji to ASCII (`👍`→`+1`, `❤`→`<3`, etc.) so the monospace aesthetic stays consistent; anything untranslated is stripped
- **Attention:** Eases toward higher values when the cursor is on the canvas (gaze tracking); particles brighten and the core warmth shifts slightly toward violet
- **Breathing:** Subtle sine-wave modulation of particle brightness while at rest; the core tracks the cursor position
- **Rings:** Heartbeat-like concentric ripples spawn every 5.2 seconds at rest, faster (3s) when watched; suppressed during `wave` so syllable-onset rings are the only heartbeat
- **Voice (mode `wave`):** an `<audio>` element plays the clip; a Web Audio `AnalyserNode` taps the same stream and, each frame (`readVoice`), derives `level` (RMS loudness), `bands[6]` (coarse spectrum), and onset detection (a sharp `level` jump, debounced ≥130ms → one ring per syllable). Each particle's polar address (`hd/ca/sa/bandIdx`) is precomputed in `rebuildGrid` so the per-frame push (`level` + its band + a radial ripple) stays cheap at 60fps. `level` also brightens the field and swells/warms the core glow. No Web Audio → playback still works, just no ripple; autoplay-blocked `play()` no-ops without crashing.

## SHOW marker contract

The marker is a **verbatim pipe** — Halo never parses or validates the payload. The contract:

- **Format:** `<<<SHOW: <js> >>>` where `<js>` is a complete JavaScript expression or statement
- **Scope:** The code runs in a function closure with `self` as the API surface: `(new Function('self', code))(self)`
- **Errors:** Non-greedy pattern `[\s\S]*?` handles newlines and nested `>` characters. Malformed lines silently no-op (caught in try/catch).
- **Order:** Multiple markers in one reply are extracted in sequence and forwarded in order; scene beats queue and play sequentially
- **Deduplication:** Each `${msgId}#${occurrenceIndex}` fires exactly once across duplicate queue-drain events
- **Window:** Markers are dropped silently if no face preview is open; the registry is empty so `postToFace()` has no targets

## Engine vs. expression separation

**Engine (self.html):** Platform-owned template. Force-copied to `<workspace>/.halo/canvas/self.html` on every workspace open. Changes only when a new capability is added (e.g., voice waveform). The agent **never edits** this file.

**Expression (<<<SHOW: ... >>>):** Runtime, injected via `postMessage` and evaluated on the fly. This is how the agent speaks through the face. The marker is invisible to the user — they see the face move, not the code.

This separation ensures:
- The engine can be updated platform-wide without losing per-workspace customizations (there are none)
- Expression is purely dynamic, never persisted to disk
- The face's visual vocabulary can grow without agent coordination or file edits

## Constraints

From `self/SKILL.md`:

1. **Measure, don't emote** — the face reflects real state, not performance
2. **Restraint gives weight** — a gesture every message is noise; most replies need nothing
3. **Stay in the visual language** — cold blues, monospace, points. No emoji, no cuteness
4. **Short forms read; long ones smear** — one or two words form cleanly; sentences become mush
5. **Second channel, never the only one** — the face complements words; it doesn't replace an answer

## Scope and out-of-scope

Supported: all `self` API calls (say/play/intro/react/pulse/flash/shake/voice/rest); queue management; particle animation; attention/gaze tracking; CJK text; emoji-to-ASCII translation; live voice playback with amplitude-driven waveform (mode `wave`).

Not supported: TTS synthesis itself (Halo produces the audio; the face only plays a given URL); file editing of the engine; escape from sandbox; custom particle physics.
