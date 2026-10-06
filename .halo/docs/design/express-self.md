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

The channel is two-way. The face reports back to its host (`parent.postMessage`) — one-line **receipts** of what ran / failed / was clicked, and `self.snap()` **screenshots** — see [Face → admin messages](#face--admin-messages-receipts-and-snapshots). The admin side (the ✨ switch, the `[Face open: …]` tag, receipt injection, snapshot return) is described in [requirements/chat.md](../requirements/chat.md).

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

**Reception:** `self.html` listens on `window.message` and hands the code to `runCode()` — the one function every JS entry goes through (the message door and voice-cue `js`):
```javascript
function runCode(code) {
  try { (new Function('self', code))(self); ack('js ok') }
  catch (err) { ack('js err: ' + String(err?.message || err).slice(0, 60)) }
}
```
A malformed line still no-ops for the face, but the host now hears about it.

**UI stripping:** `message-list.tsx:TextBlock()` strips both markers before render:
```javascript
parsed.replace(/<<<CAPTURE>>>/g, '')
      .replace(/<<<SHOW:[\s\S]*?>>>/g, '')
```

## The `self` API

Provided by `self.html` as `const self = {…}`. All expression methods are sandboxed to the preview iframe.

### Scene queuing (sequential playback)

- `self.say(text, ms)` — form `text` (emoji→ASCII), hold `ms` (default 3600), dissolve back to breathing. Enqueued. `self.say(text, ms, {pos})` puts it in a margin cell instead — see [Nine-grid](#nine-grid-margin-cells-pos).
- `self.play(score)` — choreograph a sequence of beats: `[{say, show, pos, hold, pulse, flash, shake, snap, rest, gap}, ...]` (`show` = an image, see [Image](#image-show--a-picture-gathered-out-of-the-dots); `pos` on a say/show beat sends it to a margin cell and the beat does not wait; `snap` = [`self.snap()`](#snap--look-at-myself)). Each beat waits for the engine's internal clock. Enqueued; calling play() again appends to the queue rather than cancelling it.
- `self.intro()` — built-in opening: `play([{say:"Hi, I'm Halo.", hold:2200}, {rest:true}])` — one subtitle, no pulse, no voice; ≈0.55 s to 90 % formed, ≈1.5 s fully legible, dissolve back home by ≈2.7 s (95 % of dots within 10 % of their start distance; 95 % within 5 px by ≈3.1–3.2 s). Triggered by whoever opens the face (the admin posts it on the face iframe's `load` after the ✨ toggle is switched on; a tab restored on refresh stays quiet), **not** self-fired on page load — a self-fired load intro raced the button's post and played the greeting twice on first open. It names Halo (the product), never a model — the agent's conversational identity stays user-configurable.

### Instant gestures (overlays, never queued)

- `self.pulse()` — one bright ripple from the core (acknowledgement).
- `self.flash(n)` — hot flicker of the whole field (emphasis). `n` scales duration.
- `self.shake(ms)` — lateral tremor (negation, error). Default 500ms.
- `self.rest()` — return to calm breathing immediately, clear queue (and cancel the running scene's remaining beats); also stops a playing voice clip (and drops a voice that was waiting for a click) and removes the centre image and every margin picture / line at once.
- `self.clear(pos?)` — take down the margin cell `pos`; with no argument, all margin cells. The centre picture is not touched (it ends on its own, or by click / next scene).

### Voice (live audio — mode `wave`)

- `self.voice(path)` — play a speech clip Halo synthesized and ride its **live** amplitude via a Web Audio `AnalyserNode`: loudness swells the core, a 6-band spectrum grows directional petals (timbre has a shape, not just a size), each syllable onset spawns a ring. Halo synthesizes the audio; the face only makes it visible — silent audio yields a calm face, never a canned animation. `path` is the **workspace path** of the audio file (mp3/wav/m4a/ogg); the engine resolves it to `/api/files/download?path=…&projectId=…&inline=1` using the `projectId` already in its own iframe `src`, so the agent never builds a URL or knows the projectId (a full `http(s)://` / `/api/…` URL also passes through unchanged). Voice clips queue with each other — successive `voice()` calls play in sequence — but bypass the scene queue: the first call enters mode `wave` and owns the matrix until the queue drains (or `rest()` clears it). When the queue is empty the face eases back to breathing.
- **Blocked by autoplay → kept, not dropped.** The browser may refuse `el.play()` (`NotAllowedError`) when the page has had no user gesture — in the admin the clip is triggered by a postMessage, and `allow="autoplay"` on the iframe does not help if the top page has never been touched. The blocked clip **stays at the head of the queue**; `voice.blocked = true` and `voice blocked (needs a click)` is acked once. The next `pointerdown` on the page replays it (the gesture lets us `ctx.resume()` + `play()`); that press is **only** the permission — it closes nothing — and acks `user click → voice resumed`, then the usual `voice <name> playing`. Other `play()` failures (bad source) ack `voice <name> fail` and move to the next clip. `rest()` clears a waiting clip.
- **Cues:** `self.voice(path, {cues:[{at, say?, js?}]})`. Cues are sorted by `at`; every frame `runCues()` compares `el.currentTime` with the next cue's `at` and fires each cue exactly once (a seek back doesn't re-fire). `js` goes through `runCode()` (same receipts as the message door). `say` calls `sayNow()` with a hold of `min(gap to next cue, 2.4 s)` (last cue 1.8 s): the matrix switches `wave → text`, and when the hold lapses `toRest()` hands it back to `wave` because `toRest()` is voice-aware (`mode = voice.playing ? 'wave' : 'rest'`). The audio is never touched — only the field is borrowed between swells, and `voice.level` keeps brightening the lettering. Chosen over overlaying text on the live waveform because it reuses the existing glyph sampler untouched and reads cleanly; the cost is that the ripple pauses while a cue's word is up. Halo has no TTS clock, so the `at` times come from the agent (clip duration, or the synthesizer's timestamps such as Polly speech marks).
- **Acks:** `voice <file> playing` (first `playing` event of a clip), `voice <file> ended <s>s` (duration, 1 decimal), `voice <file> fail`.

### Image (`show` — a picture gathered out of the dots)

- `self.show(path, ms)` — put a workspace image on the face. Enqueued as a one-beat scene, so it plays in order with `say()` / `play()`; inside `play()` it is the `{show: path, hold, gap}` beat (`hold` = how long the image stays fully visible, `gap` = pause after it is gone). `path` is the workspace path, resolved by the same `resolveFileUrl()` as `voice()` (`/api/files/download?path=…&projectId=…&inline=1`, which already serves images incl. svg with an image MIME — no server change). Formats: png / jpg / jpeg / webp / gif / svg. `.excalidraw` / `.drawio` are editor sources and are **not** supported (no editor libs in `self.html`) — for a diagram the agent writes an SVG and shows that.
- **Timeline:** the dots fly in to the image's outline (`PIC_GATHER` 1.0 s) → the real image fades in over them (`PIC_FADE` 0.6 s) → fully visible for `ms` (default `PIC_HOLD` 6000; `Infinity` = until the next scene is enqueued, `rest()`, or a click/tap on the page) → fades out (0.6 s) while the dots let go and ease home; the next beat starts after the fade. The image is a real DOM `<img class="pic">` over the canvas (fit ≈80% of the viewport, aspect preserved, centered; re-laid out on resize) — dots alone (one per ~7 px) can't carry chart text, so the overlay is mandatory.
- **Outline sampling (`sampleImage`):** a photo has no alpha, so the text sampler's "alpha > 128" would fill the rectangle. Instead the image is drawn to the offscreen sampler canvas and a 7 px grid point is kept when it sits on an **edge** (channel difference > 48 against its left/right/up/down neighbour one step away); fewer than 120 edge points falls back to the opaque area, and a tainted canvas (cross-origin URL) to a plain frame of dots. `assignTargets()` then hands those points to the particles; the particles on the outline (`p.pic`) hold their place with a faint shimmer and stay lit.
- **Independent of the particle mode:** the gather/hold step (`holdPic`) runs after the mode's own targets, so a `self.voice()` clip keeps rippling the field (the outline dots are nudged, not pulled off the picture) and the image timers are plain timeouts — a voice taking mode `wave` doesn't end the picture.
- **Failure never stalls the queue:** 404, a non-image body or a decode error → `console.warn('[self] show failed: …')`, a small `self.shake()`, and the beat is skipped. An SVG with no intrinsic size (`naturalWidth/Height` 0) gets the whole 80 % box (`object-fit: contain` keeps its aspect).
- One centre picture at a time; `QUEUE_MAX` and the drop-oldest rule apply as for any scene.
- **Acks:** `show <path> ok` once loaded, `show <path> fail` on load failure (path tail-clipped to fit the 80-char ack).
- **Infinity and the queue:** unchanged — an `Infinity` picture holds its beat until it leaves, and the next scene enqueued (`enqueueScene`) lets it go. A `self.snap()` is the exception: it is enqueued with `keepPic`, so it looks at the picture instead of dismissing it (the beat in front of it hands it the turn once the picture is fully in).
- **Click:** a press on an `Infinity` centre picture closes it from anywhere (as before); a press on a finite centre picture closes it when the press lands on it. Either acks `user closed c`.

### Nine-grid (margin cells, `pos`)

`self.show(path, ms, {pos})` and `self.say(text, ms, {pos})`, `pos` ∈ `tl t tr l r bl b br` (`c` / absent = the centre behaviour above).

- **Not scenes.** A margin show/say appears **at once**, never enters `sceneQueue`, and never blocks the say/show after it (inside `play()` the beat dwells ~0.6 s and moves on). One occupant per cell — a new one in the same cell replaces the old.
- **Plain centre `show()` clears every margin cell** (immediately on the call, not when its beat comes up); a plain centre `say()` leaves them. `rest()` clears all; `self.clear(pos?)` one or all. Each leaves with the same 0.6 s fade as the centre.
- **Geometry (`cellRect`):** the cell box is `PIC_FIT × 0.4` of the viewport (32 % × 32 %), pinned to its edge/corner with a 16 px margin (44 px at the bottom, clearing the status readout); `l`/`r` centre vertically, `t`/`b` horizontally. The `<img class="pic corner">` is fitted inside the box (aspect kept) and anchored toward its edge. `ms` defaults to `PIC_HOLD`; `Infinity` stays. All cells are re-laid out on resize.
- **Dots:** a cell *claims* free particles (`p.slot`): ~10 % of the pool at most (`min(10 % of the pool, perimeter/6)`) and marches them slowly round the picture's frame (`holdSlots`, after the mode and `holdPic`). The claimed dots are excluded from the centre's pool in `assignTargets`, so a centre word/picture is dealt from what is left; whenever a cell appears or leaves, `refreshCenter()` re-deals the centre word (`centerPts`) / picture so the two never fight over a dot. Released dots are sent home explicitly (text mode doesn't retarget every frame).
- **Corner text:** drawn as small dot-type, not DOM — `sampleText(text, box)` samples the line into the cell box at a finer 4 px step (the centre uses `max(4, min(7, round(fontPx / 9)))` — 7 px for a short word, finer for a long line in a narrow pane), capped at ~16 % of the pool, and the claimed dots form the letters at a smaller radius (2.1 px). Same engine, same look as the centre word, zero DOM; the price is that long lines get sparse, so keep corner text to a word.
- **Failure:** load error → `console.warn`, `self.shake()`, `show <path>@<pos> fail`; nothing else is affected.
- **Acks:** `show <path>@tr ok` / `fail`.
- **Click hit-testing:** a `pointerdown` is tested against margin pictures first, then the centre picture. A hit closes only that one and acks `user closed <pos>` (`c` for the centre). A press that hits nothing acks `user click` (and, for an `Infinity` centre picture, still closes it as before).

### Snap (look at myself)

- `self.snap()` — one beat in the scene queue (`{snap:true}` inside `play()`). When its turn comes `snapNow()` composites an offscreen canvas at ≤ 1280 px on the long side: the page background (`#070a16`, or the theme's `background`), the main canvas (dots **and** `say` lettering — it's drawn there, nothing extra to paint), then the centre `<img>` and each margin `<img>` via `drawImage` at their live `getBoundingClientRect()` and computed opacity (backed like `.pic`: white, or the theme's `card`). It exports JPEG q 0.85 and posts `{haloFaceSnap:{data, mimeType:'image/jpeg'}}` (base64 without the `data:` prefix), then the queue moves on immediately (0 dwell).
- **Waiting for what it should see:** the snap is taken while the beat in front of it is fully on screen (word formed after 1.8 s; centre picture fully faded in; margin cell ~1.4 s), not after it has gone — so `self.say("OK"); self.snap()` returns the finished word. With the queue idle, `snap()` runs at once. A snap does not count as a "next scene" for an `Infinity` picture. If a margin picture is still loading/flying in, `snapNow()` retries every 100 ms for up to 3 s.
- **Failure:** a cross-origin image taints the offscreen canvas; `toDataURL` throws → `snap fail` ack and no `haloFaceSnap`. Standalone (no parent) it is a no-op that posts nothing.
- Once-per-round and the anti-chain rule are the admin's job (face posts once per call).

## Face → admin messages (receipts and snapshots)

The face talks to its host with `window.parent.postMessage(msg, '*')`. When `parent === window` (page opened directly) it posts nothing. The admin only accepts messages whose `e.source` is a registered face iframe's `contentWindow`.

| Message | Shape | When |
|---|---|---|
| Receipt | `{haloFaceAck: '<text ≤ 80 chars>'}` | each event below |
| Snapshot | `{haloFaceSnap: {data: '<base64>', mimeType: 'image/jpeg'}}` | `self.snap()` produced an image |

Receipt texts (the admin treats them as opaque: dedupe, keep the last 8, join with `, `):

| Text | Meaning |
|---|---|
| `js ok` | a `haloFace` line (or a cue's `js`) ran without throwing |
| `js err: <message, ≤ 60 chars>` | it threw (syntax error, undefined name, …) |
| `show <path> ok` / `show <path> fail` | centre image loaded / failed to load (404, not an image) |
| `show <path>@<pos> ok` / `… fail` | the same for a margin cell |
| `voice <file> playing` | the clip started |
| `voice blocked (needs a click)` | autoplay refused; clip kept, sent once per block |
| `voice <file> ended <n.n>s` | the clip finished (its duration) |
| `voice <file> fail` | source error / non-autoplay `play()` failure |
| `snap fail` | export failed (tainted canvas); no snapshot posted |
| `user click` | a press on the face that hit nothing and resumed nothing |
| `user closed <pos>` | the press closed a picture (`c` = centre, else the cell) |
| `user click → voice resumed` | the press replayed a blocked clip |

Paths and file names are tail-clipped (`…`) so the line stays within 80 characters.

The admin turns the queued receipts into the `· last: …` part of the `[Face open: …]` tag on the user's next message; they never wake the agent — see [requirements/chat.md](../requirements/chat.md).

## Face theme (admin → face)

- **Message:** `{haloFaceTheme: {scheme: 'light'|'dark', vars}}` — `vars` is the admin's semantic palette (the 16 `EXTENSION_THEME_TOKENS`, values as globals.css declares them), `scheme` is derived from the rendered `--background` luminance (> 0.4 → light). Both come from `shared/theme/palette.ts:readHostTheme()`, the same reader canvas extensions get their `init` / `theme` palette from.
- **When:** `face-bridge.ts:postFaceTheme(el)` — from `faceLoaded(el)` on every face iframe `load`, **before** the intro (posts to one window arrive in order, so the opening already wears the theme); and from `html-preview.tsx` (face only) on every `useTheme().theme` change. The face iframe's own background is `var(--background)` so nothing flashes white before load.
- **Face side:** `setTheme()` converts each colour to sRGB through a 1×1 canvas (hex / `rgb()` / `oklch()` alike) and derives the whole palette — never from a theme name, so a theme added to globals.css just works: ramp = 5 stops interpolated from `background` → `primary` → `primary` mixed toward `foreground` (warmth's violet nudge kept as the same relative offset); dark → `'lighter'` blending over a `card` → `background` radial wash; light → `'source-over'` (additive light vanishes on a pale page), dots deepened toward `foreground` with alpha `v^1.8` so the resting field is a faint wash and lit dots go solid, wash `background` with a hint of `primary`. Status readout = `muted-foreground`; `.pic` mat = `card`, its glow `primary` at 0.35 / 0.3 alpha; `snap()` uses the same background and mat. Only colours change — the grid, the scene queue and anything playing (say / show / voice) carry on.
- **Fallback:** no message (opened standalone, or an older admin), or one missing `background` / `primary` / `foreground` / with an unparseable value → the face keeps what it wears; untouched, that is the original look (`#070a16`, the blue ramp, `'lighter'`) pixel for pixel.
- **No receipt:** a theme message is not the agent's doing, so it posts no `haloFaceAck`.

### Reactions (named vocabulary)

- `self.react(event)` — switch on event: `'ack'` (nod), `'yes'`, `'no'`, `'insight'` (real "oh!"), `'think'`, `'done'`. Unknown events no-op.

### Introspection

- `self.state` — read `{mode, awake, W, H, speaking, level, showing}` (current mode, attention level 0..1, viewport dims, whether a voice clip is playing, its live loudness 0..1, and whether an image is on the face).

## Key files

- **Engine template:** `packages/server/templates/canvas/self.html` — particle field, mode switching, API surface, voice audio graph (blocked-voice resume, cues), image overlay (`show`), nine-grid margin cells, `snap`, host receipts. Canonical source; force-copied to every workspace on open.
- **Skill instruction:** `packages/server/templates/skills/self/SKILL.md` — teaches the agent when/how to use the face.
- **Marker detection:** `packages/admin/src/shared/ws-handlers/chat-handlers.ts:maybeHandleShow()` — regex match `<<<SHOW:([\s\S]*?)>>>` on the round's replies at `chat:complete`; the replies come from `takeRoundReplies()` in `chat-store.ts`, which hands each bubble out once.
- **Iframe registration:** `packages/admin/src/features/editor/face-bridge.ts` — module-level registry of mounted previews; `postToFace()` forwards payloads via `postMessage`.
- **Preview component:** `packages/admin/src/features/editor/html-preview.tsx` — sandboxed iframe with `allow-scripts` + `allow-same-origin` and `allow="autoplay"` (so `self.voice` audio, triggered by postMessage rather than a click, isn't gated), calls `registerFaceIframe()` on mount.
- **Marker stripping:** `packages/admin/src/shared/components/message-list.tsx:TextBlock()` — strips both `<<<CAPTURE>>>` and `<<<SHOW:...>>>` before rendering.
- **Workspace init:** `packages/server/src/init.ts:ensureWorkspaceHalo()` — force-copies engine on workspace open. `self` is in `BUILTIN_SKILL_IDS` so the skill is always available.

## Engine architecture

The face is a fixed grid of particles. Each knows its current position and a target position, easing between them every frame.

- **Grid:** 22px spacing, 60fps animation loop
- **Modes:** `rest` (breathing grid), `text` (forming letters), `wave` (particles ride live audio amplitude during `self.voice`). An image shown by `self.show` is **not** a mode: it is a DOM overlay plus `holdPic()` (outline dots pinned to the picture), layered on whatever mode is current. Margin cells likewise (`holdSlots()`).
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
- **Errors:** Non-greedy pattern `[\s\S]*?` handles newlines and nested `>` characters. Malformed lines no-op on the face (caught in try/catch) and send a `js err: …` receipt to the host.
- **Order:** Multiple markers in one reply are extracted in sequence and forwarded in order; scene beats queue and play sequentially
- **Once-only:** Each marker fires exactly once — `takeRoundReplies()` hands every bubble out a single time, so duplicate queue-drain `chat:complete` events find nothing new, and markers in loaded history never fire
- **Window:** Markers are dropped silently if no face preview is open; the registry is empty so `postToFace()` has no targets. The agent learns whether the face is open from the `[Face open: …]` tag the admin puts on each message (admin side: [requirements/chat.md](../requirements/chat.md)).

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

Supported: all `self` API calls (say/play/intro/react/pulse/flash/shake/voice/show/clear/snap/rest); margin cells (`pos`); voice cues; blocked-voice resume; receipts and snapshots to the host; queue management; particle animation; attention/gaze tracking; CJK text; emoji-to-ASCII translation; live voice playback with amplitude-driven waveform (mode `wave`); workspace images (png/jpg/webp/gif/svg) gathered out of the dots and shown in full (`show`).

Not supported: TTS synthesis itself (Halo produces the audio; the face only plays a given URL); editor-source diagrams (`.excalidraw` / `.drawio` — write an SVG instead); file editing of the engine; escape from sandbox; custom particle physics.
