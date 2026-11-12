# On-device speech-to-text (`stt-local`)

A canvas extension that declares capability `stt-local` can stream microphone audio to the Halo server and get back text. Everything runs on the server: SenseVoice-Small (int8) decodes, Silero VAD cuts the audio into segments, optionally pyannote segmentation + CAM++ label who spoke (`speakers=1`), and `sherpa-onnx-node` hosts all of them. There is no cloud call and no credential to configure. Model files are downloaded the first time they're needed. Not mounted in AgentCore mode, since that mode runs neither the extension watcher nor any WS surface.

Code: `packages/server/src/stt/models.ts` (model files + downloader), `stt/engine.ts` (recognizer, VAD, decode queue, diarizer), `stt/speakers.ts` (speaker matching + split, pure), `routes/stt-ws.ts` (WS route), `extensions/watcher.ts` (`reconcileSttModels`), mounted in `index.ts` next to the Transcribe proxy.

## Models and licenses

| File (under `~/.halo/global/stt-models/`) | Bytes | Model | License |
|---|---|---|---|
| `sense-voice-zh-en-ja-ko-yue-2024-07-17/model.int8.onnx` | 239233841 | SenseVoice-Small int8 (FunAudioLLM / Alibaba), sherpa-onnx export | [FunASR Model License v1.1](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE) |
| `sense-voice-zh-en-ja-ko-yue-2024-07-17/tokens.txt` | 315894 | its token table | same |
| `silero-vad-v4/silero_vad.onnx` | 1807522 | Silero VAD v4 | MIT |
| `pyannote-segmentation-3-0/model.int8.onnx` | 1540506 | pyannote/segmentation-3.0 (© CNRS), sherpa-onnx int8 export | MIT |
| `campplus-zh-en-advanced/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx` | 28281164 | 3D-Speaker CAM++ zh/en speaker embedding (Alibaba) | Apache-2.0 |

All five are one download set (~271 MB): an install that only uses dictation still fetches the two speaker files (~30 MB) — one state machine, one progress bar, accepted. The speaker models are only *loaded* by a `speakers=1` stream.

- **FunASR Model License v1.1** allows free use, copying, modification and sharing, provided you credit the source and the authors and keep the model's name (§2.2). The attribution goes on the **halo-hub extension's description page**. The hub ships no weights: the server pulls them from the sources below, the extension never does.
- The VAD is the v4 export (1.8 MB). The 643 KB export the first evaluation used exists only on GitHub releases, not on HF or ModelScope. On sherpa's `test_silero_vad.wav`, the two cut identical segments.
- Language is `auto`. SenseVoice identifies Mandarin, Cantonese, English, Japanese and Korean by itself. Setting a language on the recognizer or the stream barely changed results in testing, so there is no `lang` parameter. Output is whatever the model writes (Simplified for Mandarin); there's no Traditional conversion.

## Download

Each file has its sha256 and size pinned in `STT_MODEL_FILES` (`models.ts`), and response headers are never trusted. Each file tries its sources in order, falling back file by file:

1. **Hugging Face**, pinned to a commit: `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17@2365baea…`, `csukuangfj/vad@fba88cd2…`, `csukuangfj/sherpa-onnx-pyannote-segmentation-3-0@9403a690…`, `csukuangfj/speaker-embedding-models@0743f301…`.
2. **ModelScope** `https://www.modelscope.cn/api/v1/models/<repo>/repo?Revision=master&FilePath=<file>` (`pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue`, `pengzhendong/silero-vad` `v4/silero_vad.onnx`, `pengzhendong/sherpa-onnx-pyannote-segmentation-3-0`, `lijiu09/speaker-embedding-models`). Only this API form 302s to a CDN that honours Range. `resolve/master` returns a full 200 to a Range request.
3. **GitHub releases** (CAM++ only): `k2-fsa/sherpa-onnx` release `speaker-recongition-models` (sic), honours Range.

Mechanics:

- Writes `<file>.part` and resumes it with `Range: bytes=<have>-`. A **206** whose `Content-Range` starts at `<have>` appends. A **200** rewrites from zero. A **416** deletes the `.part` and moves to the next source. The sha256 is computed while writing (on a resume, the existing prefix is hashed first). Only a `.part` that matches **both** size and sha gets renamed into place.
- A sha / oversize mismatch deletes the `.part` and moves on. An HTTP error, a short body or a timeout **keeps** it, and the next source resumes it: the bytes are pinned by sha, not by source. A `.part` that is already full-size (process killed between verify and rename) is re-hashed and renamed without any request.
- Timeouts: **15 s** from request to first body byte (redirects included), then **30 s** without a new chunk counts as a stall. Either one moves to the next source.
- Transport is `node:http(s)` with ≤ 5 redirects, keeping headers (Range) on every hop. It is not `fetch`, because Node 22's bundled undici (6.28) trips an internal `assert(!this.paused)` when a `Connection: close` body ends while the parser is paused under backpressure. That surfaces as an **uncaught exception**, which kills the server (reproduced locally with a 64–100 KB body). A `User-Agent` is mandatory: ModelScope's CDN returns 403 without one (`node:http` sends none by default).
- **Single flight**: one `ensure()` promise. Concurrent triggers join it.
- **Shutdown** (`gracefulShutdown` → `stt.close()`) aborts the running request and keeps the `.part`. The next boot resumes it (logged as `resuming at N bytes`).

Measured on the dev box (temp HOME), before the two speaker files were added: HF, all three files then in the set, 3.5 s total (228 MB model in 2.5 s). ModelScope-only (HF forced to fail): tokens + VAD in 2.4 s. Model aborted at 43 MB, then resumed from ModelScope in 10.9 s. SIGTERM mid-download then reboot resumed from HF in 2.3 s. Every sha matched.

### State machine

```
missing ──ensure()──▶ downloading{received,total} ──all files ok──▶ ready
   ▲                         │
   │                         └─ some file: every source failed ─▶ error{message}
   └──────── next ensure() (WS connect / extensions rescan) retries ◀─┘
```

- `ready` means every final file exists **with its pinned size**. Boot doesn't re-hash: only verified files were ever renamed in.
- `received` / `total` count bytes across all files (already-present files included), so the progress bar covers the whole set.
- Pushes go to subscribers: state changes immediately, progress at most every 500 ms (≤ 2/s).

### Triggers

- **WS connect** (`routes/stt-ws.ts`): if the model isn't ready, `ensure()` runs, and that socket then receives `model` frames until `ready` or `error`.
- **Extensions reconcile** (`extensions/watcher.ts` → `reconcileSttModels`): after `start()`'s first scan and after every `rescanAndBroadcast()` scan (install / uninstall / watcher event). If any valid, switched-on extension declares `stt-local` and the state is neither `ready` nor `downloading`, it calls `ensure()`. This makes installing the extension the moment the ~271 MB fetch starts, and it retries an `error` on the next rescan. The watcher doesn't run in AgentCore mode.

## Engine

- `sherpa-onnx-node` is `await import()`ed on first `load()`. The CJS package's ESM namespace only has `OnlineRecognizer` + `default`, so `OfflineRecognizer` / `Vad` come off `default`. A failure (unsupported platform, missing native package) is a `SttError('engine')` on that stream and is retried on the next stream. It can never fail server boot.
- **One recognizer**, created on first use: `numThreads = clamp(floor(os.availableParallelism() / 2), 1, 4)`, `provider: 'cpu'`, `language: ''`, `useInverseTextNormalization: 1`. Load takes ~0.9 s. **It stays resident, about 400 MB RSS** (temp server: 472 MB total after a session). There is no idle release: dropping the recognizer + `global.gc()` for 20 s gave back only 13–119 MB of the ~325 MB it added (varied run to run), and reloading climbs straight back to ~400 MB. sherpa has no explicit free, and the onnxruntime / glibc arenas don't return to the OS. After the load, each decoded segment adds about 0.14 MB that is never returned: a standalone engine was at 471 MB after 10 segments and 486 MB after 120, still growing linearly (2.2.5, 2026-11). A long-running server that has used STT therefore sits several hundred MB above a fresh one; deploy.md's [Memory and swap](../dev/deploy.md#memory-and-swap) has the sizing.
- **Global decode queue**: FIFO, concurrency 1 server-wide, via `decodeAsync` (libuv pool; the event loop keeps running). 10 s of speech decodes in ~0.2–0.3 s.
- **Caps → `busy`**: more than **32** segments waiting server-wide, or more than **60 s** of one stream's audio queued or decoding. The stream fails, and its own queued segments are dropped.
- Results: `lang` `<|zh|>` → `zh` (`zh` / `en` / `yue` / `ja` / `ko`). A segment whose text is empty after trimming is dropped (no frame), but still counts in the segment log.
- **Speaker diarizer** (`speakers=1` streams only): `OfflineSpeakerDiarization` (pyannote seg int8 + CAM++) and one `SpeakerEmbeddingExtractor` (CAM++), created by the first `load({ speakers: true })`, then resident like the recognizer. A plain stream never loads them. Both constructors are sync (~0.6 s together, once per process). A load failure is `SttError('engine')` (`speaker labelling unavailable: …`) on that stream, retried on the next; the recognizer and plain streams are unaffected. Measured on the dev box: **+86 MB RSS** at load; after a 57 s four-speaker session the process sat at ~610 MB vs ~480 MB without speakers (onnxruntime arenas), growing ~15–20 MB per further session like the plain path does.
- `sherpa-onnx-node`'s diarization class only has a sync `process()`. The engine calls the addon's `offlineSpeakerDiarizationProcessAsync(handle, samples, progressCb)` instead (exactly 3 args; libuv pool, same segments), imported from `sherpa-onnx-node/addon.js` — the package has no `exports` map, and the ESM `default` doesn't expose the addon. The call is wrapped in a 60 s timeout (see Known limits). An `abort()` during a segment's labelling stops before the next embedding.

### Speaker labels (`speakers=1`)

Per VAD segment, inside the same FIFO job as its decode (so a stream's finals stay in order), only when the decoded text is non-empty:

1. **Diarize the segment** (`clustering: { numClusters: -1, threshold: 0.6 }`, `minDurationOn 0.3`, `minDurationOff 0.5`) → local runs with local cluster ids. A segment's VAD cut often holds several people back to back (four.wav's first segment is 0.61–18.03 s, three speakers), which is why a per-segment embedding alone isn't enough (it found 3 of 4 speakers).
2. **Local cluster → connection speaker** (`stt/speakers.ts` `createSpeakerTracker`): one CAM++ embedding per cluster, from its runs' audio back to back, capped at **6 s** (`compute` is sync on the event loop: ~9 ms per 0.5 s, ~94 ms per 10 s; the engine yields before each one). Longest cluster first. Cosine against the connection's centroids (running sums of unit embeddings): best **≥ 0.55** → that speaker, centroid updated; else a new speaker. A cluster with **< 1.0 s** of audio never founds a new speaker once one exists: it joins the nearest without moving its centroid. Nothing diarized (pyannote found no speech) → the whole segment is one run with one embedding.
3. **Text → runs** (`splitBySpeakerRuns`): SenseVoice's `tokens[]` + `timestamps[]` (seconds into the decoded samples; `tokens.join('') === text`, ITN included, checked on zh / en). Each word token goes to the run containing its timestamp (the later-starting one if runs overlap), else the nearest; punctuation / whitespace tokens stay with the current piece, so a piece never starts with `，`. Consecutive same-speaker tokens form one `final`. A new piece starts at its speaker run's start, clamped between the previous piece's last token and its own first token; the first piece starts at the segment's padded start, the last ends at its padded end, so the finals tile the segment without overlap. A piece that would span zero seconds (overlapping runs clamp its start onto its only token) is merged into its neighbour, and same-speaker neighbours left by that merge are joined. Tokens that don't spell the trimmed text (or no timestamps) → the whole text under the speaker with the most audio in the segment, the same rule as the Transcribe proxy's `splitBySpeaker`.
4. **Wire label**: `"0"`, `"1"`… numbered per connection in order of first *sent* appearance.

Thresholds: CAM++ cosine on four.wav, pairwise over its nine reference turns (all ≥ 1 s, each embedding capped at 6 s), was 0.75–0.83 for the same speaker (6 pairs) and 0.03–0.52 between different ones (30 pairs); in the engine every match threshold from 0.45 to 0.7 gave the same labels, so 0.55 sits in the gap. **Acceptance** (sherpa's 4-speaker zh test `four.wav`, 56.9 s, 16 kHz mono, converted to s16le and streamed through `createSttEngine()` with the real models in 100 ms frames, `speakers` on): 8 finals labelled `0 1 2 | 0 | 3 | 3 | 2 | 0`, matching the reference (`A B B C | A | D | D | C | A`, sherpa's two S1 runs fall in one piece here) up to renaming, the first segment split at 7.03 s and 13.78 s into its three speakers' sentences. Total 3.4 s for 57 s of audio (1.8 s without speakers); longest event-loop gap 70 ms.

### VAD (one per open stream, pooled)

Silero v4, 512-sample windows at 16 kHz, internal buffer 30 s. Each open stream holds one; on `end()` (after the flush) or `abort()` it is `reset()` and goes back to a per-engine pool that `open()` draws from first, so the pool only grows to the most streams ever open at once and pooled VADs are never freed (~4.6 MB native each). A `new Vad` per stream left that native memory to a GC finalizer the small JS heap rarely runs: +150 MB RSS over 150 streams through the engine (+690 MB for raw new-and-feed), flat with `gc()`. The per-segment recognizer / CAM++ streams are still finalizer-freed (the addon has no release call), ≈ 0.2 MB per decode. Constants in `engine.ts`:

| Constant | Value | Why |
|---|---|---|
| `VAD_THRESHOLD` | 0.5 | 0.3 split Cantonese into fragments; the English head loss 0.5 caused is fixed by padding instead |
| `VAD_MIN_SILENCE_S` | 0.5 | Silence that ends a segment. It is also the final's latency after speech stops. Shorter values cut mid-sentence pauses into separate, worse decodes |
| `VAD_MIN_SPEECH_S` | 0.25 | Shorter blips (clicks, breaths) aren't speech |
| `VAD_MAX_SPEECH_S` | 20 | Hard cut for a monologue. SenseVoice is non-streaming, so nothing comes back until a segment ends. This bounds latency and per-segment memory |
| `PAD_BEFORE_S` | 0.3 | Raw audio prepended. Silero fires a few windows into the first syllable, and at 0.5 it swallowed English heads ("Fous to foreigners…") |
| `PAD_AFTER_S` | 0.2 | Soft endings fall under the threshold early. 0.3 + 0.2 = min-silence, so at a normal pause padding doesn't reach into the neighbour |

Each stream keeps a 30 s ring of raw samples (it must reach back past a 20 s segment plus pad when that segment is emitted), and each segment is cut from the ring. The pre-pad is clamped to the previous segment's padded end, so no audio is decoded twice. The final's `start` / `end` are the **padded** bounds: exactly the audio that was decoded.

**Concatenation test** (zh / en / yue + ja / ko from the SenseVoice HF repo's `test_wavs/`, joined with 1.2 s of silence, streamed through `engine.ts` in 100 ms s16le frames, each final compared with a whole-file decode of the same clip): 5/5 clips produced one segment each, with the right language. **No head or tail word was dropped** in any language: after stripping punctuation and spaces, each streamed text has exactly as many characters as its whole-file decode (zh 13/13, en 66/66, yue 15/15, ja 34/34, ko 17/17). Exact string match was 1/5 (yue). The other four are substitutions, not losses: zh 开饭→开放 (one homophone, at the head), en "code"→"gold" (at the tail; the clip actually says *gold*), ja an extra `、`, ko word-spaced Hangul (identical letters). Isolating which differences come from padding: decoding the unpadded VAD segment alone already gives the ja / ko variants, while zh 开放 and en "gold" appear only with the pre-pad. Both are single-token flips, not dropped audio. For context, a sweep over pre/post pads of 0–0.5 s never got more than 2/5 exact. On sherpa's 60 s English `test_silero_vad.wav`, 8 of 10 padded segments decode identically to the unpadded ones. One gains a comma. One changes both ways: "Capital in thet century argues for a 4%" becomes "Capital in the 21st century argue for a a 4%".

## WS `/api/stt/stream?ext=<id>`

`noServer` ws server behind `ws/upgrade-router.ts`, same structure as the Transcribe proxy (`routes/transcribe-ws.ts`).

- **Query**: `ext=<id>` (required) and optional `speakers=1`. Only the exact value `1` turns speaker labels on (loading the diarizer if this is the first such stream); absent or any other value = no labels, byte-identical frames to before. voice-input never sends it; htrans ≥ 1.0.10 does when "Identify speakers" is ticked with the on-device engine.

- **Handshake**: login cookie (`isAuthenticated(getTokenFromCookieHeader(cookie))`), else **401**. `ext` must be installed, switched on and declare `stt-local`, else **403**. Frames are capped at 1 MiB (`maxPayload`). Every socket has an `error` listener, so a protocol violation (oversize → 1009, bad UTF-8 → 1007) closes only that socket.
- **Server → client** (text JSON):
  - `{"type":"model","state":"missing"|"downloading"|"ready"|"error","received"?,"total"?,"message"?}`: always the **first** frame. While the model isn't ready, more `model` frames follow (progress ≤ 2/s, plus every state change). `received` / `total` are present only for `downloading`, `message` only for `error`.
  - `{"type":"ready"}`: model ready **and** engine loaded. Audio is accepted from here on.
  - `{"type":"final","start":<s>,"end":<s>,"text":"…","lang":"zh"|"en"|"yue"|"ja"|"ko"}`: one per non-empty segment. `start` / `end` are seconds (3 decimals) from this connection's first accepted audio sample.
  - With `speakers=1`, every `final` also carries `"speaker":"0"|"1"|…`: a **string**, numbered per connection in order of first appearance — the same shape as the Transcribe proxy's (htrans shows `Number(speaker) + 1` as "Speaker N"). A segment several people spoke in arrives as **one `final` per speaker run** (see [Speaker labels](#speaker-labels-speakers1)), in time order, non-overlapping, never zero-length, sharing the segment's `lang`; their `start` / `end` tile the segment's padded bounds.
  - `{"type":"error","code":"model"|"engine"|"busy"|"bad-request"|"io","message":"…"}`, then close **1011**. `model` = download failed (the reason is also in the preceding `model` frame's `message`), `engine` = native load / VAD / decode / diarizer load or run failure, `busy` = queue caps above, `bad-request` = a text frame other than `{"type":"end"}`, `io` = anything else.
- **Client → server**:
  - binary = PCM s16le mono 16 kHz, any frame length (an odd trailing byte carries over). **Binary sent before `ready` is dropped**, because there's no stream yet to feed. A client should start sending only after `ready` (`start` / `end` count from the first audio sent after it).
  - text `{"type":"end"}`: flush the VAD, wait for every remaining segment of this connection to be decoded and its `final` sent, then close **1000**. Sent before `ready`, it closes 1000 at once (nothing was accepted).
- **Disconnect**: this connection's segments that haven't started decoding are removed from the global queue. A segment already decoding finishes, and its result is discarded.
- **Shutdown**: open sockets close 1001 and the download is aborted, keeping its `.part`.

## Logs

`[STT] …` only, with counts and durations: `stream open ext=…[ speakers=1]`, `stream closed after Ns ext=… segments=N audio=Ns[ speakers=N]`, `stream error ext=… code=…`, `engine loaded in Nms (threads=N)` / `engine load failed: …`, `speaker diarizer loaded in Nms` / `speaker diarizer load failed: …`, `model download start`, `downloaded <file> from <source> (N MB in Ns)`, `download <file> from <source> failed: <reason>`, `<file>: resuming at N bytes`. **Recognized text and audio are never logged.** The server's default level is `warn`, so these `console.log` lines show up at `general.logging.level: info` (or `HALO_LOG_LEVEL=info`).

## Known limits

- **Proxies**: neither `fetch` nor `node:http(s)` reads `HTTPS_PROXY` / `HTTP_PROXY` on Node 22 by default (verified: with an unreachable `HTTPS_PROXY`, both connected directly). `NODE_USE_ENV_PROXY=1` (experimental in Node 22, prints `UNDICI-EHPA` warnings) makes both honour it. A server behind a mandatory egress proxy can't download the models without it. The workaround is to drop the five files into `~/.halo/global/stt-models/` by hand with the exact names and sizes above.
- ~400 MB resident once any stream has loaded the engine (no idle release, see above), plus ~90–130 MB once a `speakers=1` stream has loaded the diarizer. The decode burst uses up to 4 cores.
- **Speaker labels are per connection**: a reconnect (htrans's Pause → Resume starts a new run) renumbers from `"0"`, and the same person may get a different number. Labels are never names. Overlapping speech, far-field / room microphones, telephone audio and more than ~4 speakers are **unmeasured** — the only acceptance file is sherpa's clean four-speaker zh test. A speaker whose only turns are under 1 s is folded into the nearest existing one. A speaker change inside a SenseVoice token (rare; tokens are ~0.1–0.3 s) is cut at the token boundary.
- **The direct-wav acceptance above is the optimistic case.** Through a real browser capture path (htrans browser e2e: Chrome captures the 16 kHz source at 48 kHz, the htrans worklet downsamples back to 16 kHz) one 2.5 s stretch of four.wav (11.2–13.8 s, reference speaker B) was labelled as another speaker in every run, and one run produced a 5th speaker for a misrecognised D sentence. The same 48 → 16 kHz round trip done with ffmpeg reproduces it, and real microphones always go through this path.
- **Diarization timeout**: one native diarization call is capped at 60 s (`DIAR_TIMEOUT_MS`), then the stream fails `engine` (`speaker diarization failed: timed out`). sherpa-onnx-node 1.13.8's async diarization worker has no `OnError`, so a native exception would otherwise leave its promise pending and stall the server-wide decode queue until restart. The native call itself can't be cancelled: if it is really still running, it keeps one libuv thread busy until it returns.
- One decode at a time: with many concurrent speakers, latency grows linearly until `busy`.
- No partial results (SenseVoice is non-streaming): a final arrives ~0.5 s after the speaker pauses, at most 20 s after a segment starts.
- Desktop (win-x64 / darwin-arm64): `stage-runtime.mjs` `installSherpaBinary()` ships the target's `sherpa-onnx-<platform>-<arch>` package (see [dev/desktop-packaging.md](../dev/desktop-packaging.md)). A build without it fails streams with `engine`, never server boot. The macOS addon declares minimum 14.0; older macOS is unverified.
