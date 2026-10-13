# On-device speech-to-text (`stt-local`)

A canvas extension that declares capability `stt-local` can stream microphone audio to the Halo server and get back text. Everything runs on the server: SenseVoice-Small (int8) decodes, Silero VAD cuts the audio into segments, and `sherpa-onnx-node` hosts both models. There is no cloud call and no credential to configure. Model files are downloaded the first time they're needed. Not mounted in AgentCore mode, since that mode runs neither the extension watcher nor any WS surface.

Code: `packages/server/src/stt/models.ts` (model files + downloader), `stt/engine.ts` (recognizer, VAD, decode queue), `routes/stt-ws.ts` (WS route), `extensions/watcher.ts` (`reconcileSttModels`), mounted in `index.ts` next to the Transcribe proxy.

## Models and licenses

| File (under `~/.halo/global/stt-models/`) | Bytes | Model | License |
|---|---|---|---|
| `sense-voice-zh-en-ja-ko-yue-2024-07-17/model.int8.onnx` | 239233841 | SenseVoice-Small int8 (FunAudioLLM / Alibaba), sherpa-onnx export | [FunASR Model License v1.1](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE) |
| `sense-voice-zh-en-ja-ko-yue-2024-07-17/tokens.txt` | 315894 | its token table | same |
| `silero-vad-v4/silero_vad.onnx` | 1807522 | Silero VAD v4 | MIT |

- **FunASR Model License v1.1** allows free use, copying, modification and sharing, provided you credit the source and the authors and keep the model's name (§2.2). The attribution goes on the **halo-hub extension's description page**. The hub ships no weights: the server pulls them from the sources below, the extension never does.
- The VAD is the v4 export (1.8 MB). The 643 KB export the first evaluation used exists only on GitHub releases, not on HF or ModelScope. On sherpa's `test_silero_vad.wav`, the two cut identical segments.
- Language is `auto`. SenseVoice identifies Mandarin, Cantonese, English, Japanese and Korean by itself. Setting a language on the recognizer or the stream barely changed results in testing, so there is no `lang` parameter. Output is whatever the model writes (Simplified for Mandarin); there's no Traditional conversion.

## Download

Each file has its sha256 and size pinned in `STT_MODEL_FILES` (`models.ts`), and response headers are never trusted. Each file tries its sources in order, falling back file by file:

1. **Hugging Face**, pinned to a commit: `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17@2365baea…` and `csukuangfj/vad@fba88cd2…`.
2. **ModelScope** `https://www.modelscope.cn/api/v1/models/<repo>/repo?Revision=master&FilePath=<file>` (`pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue`, `pengzhendong/silero-vad` `v4/silero_vad.onnx`). Only this API form 302s to a CDN that honours Range. `resolve/master` returns a full 200 to a Range request.

Mechanics:

- Writes `<file>.part` and resumes it with `Range: bytes=<have>-`. A **206** whose `Content-Range` starts at `<have>` appends. A **200** rewrites from zero. A **416** deletes the `.part` and moves to the next source. The sha256 is computed while writing (on a resume, the existing prefix is hashed first). Only a `.part` that matches **both** size and sha gets renamed into place.
- A sha / oversize mismatch deletes the `.part` and moves on. An HTTP error, a short body or a timeout **keeps** it, and the next source resumes it: the bytes are pinned by sha, not by source. A `.part` that is already full-size (process killed between verify and rename) is re-hashed and renamed without any request.
- Timeouts: **15 s** from request to first body byte (redirects included), then **30 s** without a new chunk counts as a stall. Either one moves to the next source.
- Transport is `node:http(s)` with ≤ 5 redirects, keeping headers (Range) on every hop. It is not `fetch`, because Node 22's bundled undici (6.28) trips an internal `assert(!this.paused)` when a `Connection: close` body ends while the parser is paused under backpressure. That surfaces as an **uncaught exception**, which kills the server (reproduced locally with a 64–100 KB body). A `User-Agent` is mandatory: ModelScope's CDN returns 403 without one (`node:http` sends none by default).
- **Single flight**: one `ensure()` promise. Concurrent triggers join it.
- **Shutdown** (`gracefulShutdown` → `stt.close()`) aborts the running request and keeps the `.part`. The next boot resumes it (logged as `resuming at N bytes`).

Measured on the dev box (temp HOME): HF, all three files, 3.5 s total (228 MB model in 2.5 s). ModelScope-only (HF forced to fail): tokens + VAD in 2.4 s. Model aborted at 43 MB, then resumed from ModelScope in 10.9 s. SIGTERM mid-download then reboot resumed from HF in 2.3 s. Every sha matched.

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
- **Extensions reconcile** (`extensions/watcher.ts` → `reconcileSttModels`): after `start()`'s first scan and after every `rescanAndBroadcast()` scan (install / uninstall / watcher event). If any valid extension declares `stt-local` and the state is neither `ready` nor `downloading`, it calls `ensure()`. This makes installing the extension the moment the ~240 MB fetch starts, and it retries an `error` on the next rescan. The watcher doesn't run in AgentCore mode.

## Engine

- `sherpa-onnx-node` is `await import()`ed on first `load()`. The CJS package's ESM namespace only has `OnlineRecognizer` + `default`, so `OfflineRecognizer` / `Vad` come off `default`. A failure (unsupported platform, missing native package) is a `SttError('engine')` on that stream and is retried on the next stream. It can never fail server boot.
- **One recognizer**, created on first use: `numThreads = clamp(floor(os.availableParallelism() / 2), 1, 4)`, `provider: 'cpu'`, `language: ''`, `useInverseTextNormalization: 1`. Load takes ~0.9 s. **It stays resident, about 400 MB RSS** (temp server: 472 MB total after a session). There is no idle release: dropping the recognizer + `global.gc()` for 20 s gave back only 13–119 MB of the ~325 MB it added (varied run to run), and reloading climbs straight back to ~400 MB. sherpa has no explicit free, and the onnxruntime / glibc arenas don't return to the OS.
- **Global decode queue**: FIFO, concurrency 1 server-wide, via `decodeAsync` (libuv pool; the event loop keeps running). 10 s of speech decodes in ~0.2–0.3 s.
- **Caps → `busy`**: more than **32** segments waiting server-wide, or more than **60 s** of one stream's audio queued or decoding. The stream fails, and its own queued segments are dropped.
- Results: `lang` `<|zh|>` → `zh` (`zh` / `en` / `yue` / `ja` / `ko`). A segment whose text is empty after trimming is dropped (no frame), but still counts in the segment log.

### VAD (one per stream)

Silero v4, 512-sample windows at 16 kHz, internal buffer 30 s. Constants in `engine.ts`:

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

- **Handshake**: login cookie (`isAuthenticated(getTokenFromCookieHeader(cookie))`), else **401**. `ext` must be installed and declare `stt-local`, else **403**. Frames are capped at 1 MiB (`maxPayload`). Every socket has an `error` listener, so a protocol violation (oversize → 1009, bad UTF-8 → 1007) closes only that socket.
- **Server → client** (text JSON):
  - `{"type":"model","state":"missing"|"downloading"|"ready"|"error","received"?,"total"?,"message"?}`: always the **first** frame. While the model isn't ready, more `model` frames follow (progress ≤ 2/s, plus every state change). `received` / `total` are present only for `downloading`, `message` only for `error`.
  - `{"type":"ready"}`: model ready **and** engine loaded. Audio is accepted from here on.
  - `{"type":"final","start":<s>,"end":<s>,"text":"…","lang":"zh"|"en"|"yue"|"ja"|"ko"}`: one per non-empty segment. `start` / `end` are seconds (3 decimals) from this connection's first accepted audio sample.
  - `{"type":"error","code":"model"|"engine"|"busy"|"bad-request"|"io","message":"…"}`, then close **1011**. `model` = download failed (the reason is also in the preceding `model` frame's `message`), `engine` = native load / VAD / decode failure, `busy` = queue caps above, `bad-request` = a text frame other than `{"type":"end"}`, `io` = anything else.
- **Client → server**:
  - binary = PCM s16le mono 16 kHz, any frame length (an odd trailing byte carries over). **Binary sent before `ready` is dropped**, because there's no stream yet to feed. A client should start sending only after `ready` (`start` / `end` count from the first audio sent after it).
  - text `{"type":"end"}`: flush the VAD, wait for every remaining segment of this connection to be decoded and its `final` sent, then close **1000**. Sent before `ready`, it closes 1000 at once (nothing was accepted).
- **Disconnect**: this connection's segments that haven't started decoding are removed from the global queue. A segment already decoding finishes, and its result is discarded.
- **Shutdown**: open sockets close 1001 and the download is aborted, keeping its `.part`.

## Logs

`[STT] …` only, with counts and durations: `stream open ext=…`, `stream closed after Ns ext=… segments=N audio=Ns`, `stream error ext=… code=…`, `engine loaded in Nms (threads=N)` / `engine load failed: …`, `model download start`, `downloaded <file> from <source> (N MB in Ns)`, `download <file> from <source> failed: <reason>`, `<file>: resuming at N bytes`. **Recognized text and audio are never logged.** The server's default level is `warn`, so these `console.log` lines show up at `general.logging.level: info` (or `HALO_LOG_LEVEL=info`).

## Known limits

- **Proxies**: neither `fetch` nor `node:http(s)` reads `HTTPS_PROXY` / `HTTP_PROXY` on Node 22 by default (verified: with an unreachable `HTTPS_PROXY`, both connected directly). `NODE_USE_ENV_PROXY=1` (experimental in Node 22, prints `UNDICI-EHPA` warnings) makes both honour it. A server behind a mandatory egress proxy can't download the models without it. The workaround is to drop the three files into `~/.halo/global/stt-models/` by hand with the exact names and sizes above.
- ~400 MB resident once any stream has loaded the engine (no idle release, see above). The decode burst uses up to 4 cores.
- One decode at a time: with many concurrent speakers, latency grows linearly until `busy`.
- No partial results (SenseVoice is non-streaming): a final arrives ~0.5 s after the speaker pauses, at most 20 s after a segment starts.
- Desktop (win-x64 / darwin-arm64): `stage-runtime.mjs` `installSherpaBinary()` ships the target's `sherpa-onnx-<platform>-<arch>` package (see [dev/desktop-packaging.md](../dev/desktop-packaging.md)). A build without it fails streams with `engine`, never server boot. The macOS addon declares minimum 14.0; older macOS is unverified.
