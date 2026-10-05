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

**Runtime expression:** Agent emits `<<<SHOW: payload >>>` in a reply. On `chat:complete`:
1. `chat-handlers.ts` takes the round's replies with `takeRoundReplies()` (`chat-store.ts`) — every main assistant bubble since the previous `chat:complete`, in log order, each handed out once. A round can span several bubbles (the head an interjection split off, a turnId split, the follow-up answering a queued message), so scanning only the last bubble would miss earlier markers
2. `maybeHandleShow(replies)` detects all `<<<SHOW:[\s\S]*?>>>` markers (non-greedy, global) in those bubbles; `maybeHandleCapture(wsClient, tabStore, replies)` looks for `<<<CAPTURE>>>` in the same set
3. For each match, extracts the payload (trimmed)
4. Calls `postToFace(payload)` to forward it

`takeRoundReplies()` runs on every tab (it resets that tab's round), but steps 2–4 run only for the tab on screen — a background session must not drive the face the user is looking at.

**No dedup set.** `takeRoundReplies()` advances a cursor (`roundStart`) past what it returned, so the duplicate `chat:complete`s a queue drain emits find no new bubbles and fire nothing. `setMessages` (history load, snapshot restore, reattach) and `clear()` reset the cursor to the end of the loaded log, so markers in already-loaded history never fire.

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

Provided by `self.html` as `const self = {…}`. All expression methods are sandboxed to the preview iframe.

### Scene queuing (sequential playback)

- `self.say(text, ms)` — form `text` (emoji→ASCII), hold `ms` (default 3600), dissolve back to breathing. Enqueued.
- `self.play(score)` — choreograph a sequence of beats: `[{say, show, hold, pulse, flash, shake, rest, gap}, ...]` (`show` = an image, see [Image](#image-show--a-picture-gathered-out-of-the-dots)). Each beat waits for the engine's internal clock. Enqueued; calling play() again appends to the queue rather than cancelling it.
- `self.intro()` — built-in opening: "HELLO / A MIND / IS HERE / BEYOND / WORDS". Triggered by whoever opens the face (the admin ✨ button posts it on open), **not** self-fired on page load — a self-fired load intro raced the button's post and played the greeting twice on first open. Nameless deliberately — the agent identity is user-configurable.

### Instant gestures (overlays, never queued)

- `self.pulse()` — one bright ripple from the core (acknowledgement).
- `self.flash(n)` — hot flicker of the whole field (emphasis). `n` scales duration.
- `self.shake(ms)` — lateral tremor (negation, error). Default 500ms.
- `self.rest()` — return to calm breathing immediately, clear queue (and cancel the running scene's remaining beats); also stops a playing voice clip and removes a shown image at once.

### Voice (live audio — mode `wave`)

- `self.voice(path)` — play a speech clip Halo synthesized and ride its **live** amplitude via a Web Audio `AnalyserNode`: loudness swells the core, a 6-band spectrum grows directional petals (timbre has a shape, not just a size), each syllable onset spawns a ring. Halo synthesizes the audio; the face only makes it visible — silent audio yields a calm face, never a canned animation. `path` is the **workspace path** of the audio file (mp3/wav/m4a/ogg); the engine resolves it to `/api/files/download?path=…&projectId=…&inline=1` using the `projectId` already in its own iframe `src`, so the agent never builds a URL or knows the projectId (a full `http(s)://` / `/api/…` URL also passes through unchanged). Voice clips queue with each other — successive `voice()` calls play in sequence — but bypass the scene queue: the first call enters mode `wave` and owns the matrix until the queue drains (or `rest()` clears it). When the queue is empty the face eases back to breathing.

### Image (`show` — a picture gathered out of the dots)

- `self.show(path, ms)` — put a workspace image on the face. Enqueued as a one-beat scene, so it plays in order with `say()` / `play()`; inside `play()` it is the `{show: path, hold, gap}` beat (`hold` = how long the image stays fully visible, `gap` = pause after it is gone). `path` is the workspace path, resolved by the same `resolveFileUrl()` as `voice()` (`/api/files/download?path=…&projectId=…&inline=1`, which already serves images incl. svg with an image MIME — no server change). Formats: png / jpg / jpeg / webp / gif / svg. `.excalidraw` / `.drawio` are editor sources and are **not** supported (no editor libs in `self.html`) — for a diagram the agent writes an SVG and shows that.
- **Timeline:** the dots fly in to the image's outline (`PIC_GATHER` 1.0 s) → the real image fades in over them (`PIC_FADE` 0.6 s) → fully visible for `ms` (default `PIC_HOLD` 6000; `Infinity` = until the next scene is enqueued, `rest()`, or a click/tap on the page) → fades out (0.6 s) while the dots let go and ease home; the next beat starts after the fade. The image is a real DOM `<img class="pic">` over the canvas (fit ≈80% of the viewport, aspect preserved, centered; re-laid out on resize) — dots alone (one per ~7 px) can't carry chart text, so the overlay is mandatory.
- **Outline sampling (`sampleImage`):** a photo has no alpha, so the text sampler's "alpha > 128" would fill the rectangle. Instead the image is drawn to the offscreen sampler canvas and a 7 px grid point is kept when it sits on an **edge** (channel difference > 48 against its left/right/up/down neighbour one step away); fewer than 120 edge points falls back to the opaque area, and a tainted canvas (cross-origin URL) to a plain frame of dots. `assignTargets()` then hands those points to the particles; the particles on the outline (`p.pic`) hold their place with a faint shimmer and stay lit.
- **Independent of the particle mode:** the gather/hold step (`holdPic`) runs after the mode's own targets, so a `self.voice()` clip keeps rippling the field (the outline dots are nudged, not pulled off the picture) and the image timers are plain timeouts — a voice taking mode `wave` doesn't end the picture.
- **Failure never stalls the queue:** 404, a non-image body or a decode error → `console.warn('[self] show failed: …')`, a small `self.shake()`, and the beat is skipped. An SVG with no intrinsic size (`naturalWidth/Height` 0) gets the whole 80 % box (`object-fit: contain` keeps its aspect).
- One picture at a time; `QUEUE_MAX` and the drop-oldest rule apply as for any scene.

### Reactions (named vocabulary)

- `self.react(event)` — switch on event: `'ack'` (nod), `'yes'`, `'no'`, `'insight'` (real "oh!"), `'think'`, `'done'`. Unknown events no-op.

### Introspection

- `self.state` — read `{mode, awake, W, H, speaking, level, showing}` (current mode, attention level 0..1, viewport dims, whether a voice clip is playing, its live loudness 0..1, and whether an image is on the face).

## Key files

- **Engine template:** `packages/server/templates/canvas/self.html` — particle field, mode switching, API surface, voice audio graph, image overlay (`show`). Canonical source; force-copied to every workspace on open.
- **Skill instruction:** `packages/server/templates/skills/self/SKILL.md` — teaches the agent when/how to use the face.
- **Marker detection:** `packages/admin/src/shared/ws-handlers/chat-handlers.ts:maybeHandleShow()` — regex match `<<<SHOW:([\s\S]*?)>>>` on the round's replies at `chat:complete`; the replies come from `takeRoundReplies()` in `chat-store.ts`, which hands each bubble out once.
- **Iframe registration:** `packages/admin/src/features/editor/face-bridge.ts` — module-level registry of mounted previews; `postToFace()` forwards payloads via `postMessage`.
- **Preview component:** `packages/admin/src/features/editor/html-preview.tsx` — sandboxed iframe with `allow-scripts` + `allow-same-origin` and `allow="autoplay"` (so `self.voice` audio, triggered by postMessage rather than a click, isn't gated), calls `registerFaceIframe()` on mount.
- **Marker stripping:** `packages/admin/src/shared/components/message-list.tsx:TextBlock()` — strips both `<<<CAPTURE>>>` and `<<<SHOW:...>>>` before rendering.
- **Workspace init:** `packages/server/src/init.ts:ensureWorkspaceHalo()` — force-copies engine on workspace open. `self` is in `BUILTIN_SKILL_IDS` so the skill is always available.

## Engine architecture

The face is a fixed grid of particles. Each knows its current position and a target position, easing between them every frame.

- **Grid:** 22px spacing, 60fps animation loop
- **Modes:** `rest` (breathing grid), `text` (forming letters), `wave` (particles ride live audio amplitude during `self.voice`). An image shown by `self.show` is **not** a mode: it is a DOM overlay plus `holdPic()` (outline dots pinned to the picture), layered on whatever mode is current.
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
- **Once-only:** Each marker fires exactly once — `takeRoundReplies()` hands every bubble out a single time, so duplicate queue-drain `chat:complete` events find nothing new, and markers in loaded history never fire
- **Window:** Markers are dropped silently if no face preview is open; the registry is empty so `postToFace()` has no targets

### Trust model — why `new Function` is acceptable here

The marker payload is agent-authored JavaScript evaluated inside the face iframe, which is `allow-scripts` + `allow-same-origin`. That is a deliberate trade-off, not an oversight:

- **The agent already holds more than this grants.** A `<<<SHOW>>>` runs in the admin origin of the person who is *already* driving this agent with `full`-level tools (shell, file write, git push). Code execution in their own browser tab adds no privilege the agent doesn't already have on the host.
- **The admin is single-tenant.** There is one admin cookie per server and it equals full control of the server process (see [dev/api.md](../dev/api.md) → *Trust model*). There is no second, lower-privilege admin user whose session a marker could hijack.
- **Untrusted text is not a vector.** Markers are extracted from the *assistant's* reply only, never from user or tool-result text, and only in the admin chat panel — IM channels, the web channel and halo-city never evaluate them.
- **`allow-same-origin` is required** for `self.voice(path)` to fetch synthesized clips and for the preview to register with `registerFaceIframe()`; a sandboxed-opaque origin would break both.

The cost we accept: a prompt-injected agent could emit a marker that reads admin `localStorage` or issues admin API calls from the operator's tab — but the same injected agent, at `full` access, already has a shell on the server host, which is strictly more. If Halo ever gains multi-user admin, this section is the first thing to revisit (move the face to an opaque origin and replace the JS payload with a declarative command list).

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

Supported: all `self` API calls (say/play/intro/react/pulse/flash/shake/voice/show/rest); queue management; particle animation; attention/gaze tracking; CJK text; emoji-to-ASCII translation; live voice playback with amplitude-driven waveform (mode `wave`); workspace images (png/jpg/webp/gif/svg) gathered out of the dots and shown in full (`show`).

Not supported: TTS synthesis itself (Halo produces the audio; the face only plays a given URL); editor-source diagrams (`.excalidraw` / `.drawio` — write an SVG instead); file editing of the engine; escape from sandbox; custom particle physics.
