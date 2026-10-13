/**
 * On-device STT model files (`stt-local`): SenseVoice-Small int8 + Silero VAD
 * v4 under `~/.halo/global/stt-models/`, downloaded on demand.
 *
 * State machine: `missing` → `downloading` (received / total) → `ready`, or
 * `error` once every source of some file failed; the next trigger (a WS
 * connection, an extensions rescan) retries. `ready` = every final file exists
 * with its pinned size — only a size+sha256-verified `.part` is ever renamed
 * into place, so boot never re-hashes.
 *
 * Per file: sources in order (HF pinned commit, then ModelScope), resuming
 * `<file>.part` with `Range: bytes=<have>-` (206 → append, 200 → rewrite from
 * zero), hashing while writing. A size / sha mismatch deletes the `.part` and
 * moves on; a timeout or HTTP error keeps it (the next source resumes it —
 * the bytes are pinned by sha, not by source). One download at a time
 * (singleton promise), progress pushed at most every 500 ms, `close()` aborts
 * and keeps the `.part` for the next boot.
 *
 * Spec: .halo/docs/design/stt-local.md
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { globalSttModelsDir } from '../paths.js'

/** GET following up to 5 redirects (ModelScope 302s to its CDN), headers
 *  (Range) kept on every hop. node:http rather than fetch: Node 22's bundled
 *  undici trips an internal assert — an uncaught exception, fatal for the
 *  server — when a `Connection: close` body ends while its parser is paused
 *  under backpressure. The User-Agent is required: ModelScope's CDN answers
 *  403 to a request without one (node:http sends none by default). */
function httpGet(url: string, headers: Record<string, string>, signal: AbortSignal, hops = 5): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = (u.protocol === 'https:' ? https : http).get(u, { headers: { 'User-Agent': 'halo-stt', ...headers }, signal }, (res) => {
      // A response dropped unread (non-2xx) still errors on the final abort;
      // a consumer's for-await sees errors regardless of this listener.
      res.on('error', () => {})
      const location = res.headers.location
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
        res.resume()
        if (hops === 0) reject(new Error('too many redirects'))
        else resolve(httpGet(new URL(location, u).toString(), headers, signal, hops - 1))
        return
      }
      resolve(res)
    })
    req.on('error', reject)
  })
}

export const SENSE_VOICE_MODEL = 'sense-voice-zh-en-ja-ko-yue-2024-07-17/model.int8.onnx'
export const SENSE_VOICE_TOKENS = 'sense-voice-zh-en-ja-ko-yue-2024-07-17/tokens.txt'
export const SILERO_VAD_MODEL = 'silero-vad-v4/silero_vad.onnx'

export interface SttModelFile {
  /** Path relative to the models dir. */
  path: string
  size: number
  sha256: string
  /** Tried in order; `name` is for logs and error messages. */
  sources: Array<{ name: string; url: string }>
}

const HF_SENSE_VOICE = 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07'
// ModelScope: only the `api/v1/.../repo?FilePath=` form honours Range (302 to
// a CDN); `resolve/master` answers a Range request with a full 200.
const MS_SENSE_VOICE = 'https://www.modelscope.cn/api/v1/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/repo?Revision=master&FilePath='

/** Sizes and hashes are pinned here — response headers are never trusted. */
export const STT_MODEL_FILES: SttModelFile[] = [
  {
    path: SENSE_VOICE_MODEL,
    size: 239233841,
    sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    sources: [
      { name: 'huggingface', url: `${HF_SENSE_VOICE}/model.int8.onnx` },
      { name: 'modelscope', url: `${MS_SENSE_VOICE}model.int8.onnx` },
    ],
  },
  {
    path: SENSE_VOICE_TOKENS,
    size: 315894,
    sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
    sources: [
      { name: 'huggingface', url: `${HF_SENSE_VOICE}/tokens.txt` },
      { name: 'modelscope', url: `${MS_SENSE_VOICE}tokens.txt` },
    ],
  },
  {
    path: SILERO_VAD_MODEL,
    size: 1807522,
    sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28',
    sources: [
      { name: 'huggingface', url: 'https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx' },
      { name: 'modelscope', url: 'https://www.modelscope.cn/api/v1/models/pengzhendong/silero-vad/repo?Revision=master&FilePath=v4/silero_vad.onnx' },
    ],
  },
]

export type SttModelState = 'missing' | 'downloading' | 'ready' | 'error'

export interface SttModelStatus {
  state: SttModelState
  /** `downloading` only: bytes on disk across all files / their pinned total. */
  received?: number
  total?: number
  /** `error` only. */
  message?: string
}

export interface SttModelManager {
  status(): SttModelStatus
  /** Start (or join) the download unless every file is ready. Never rejects —
   *  the outcome is the next `status()` / pushed frame. */
  ensure(): Promise<void>
  /** Status pushes (state changes immediately, progress throttled). */
  subscribe(listener: (status: SttModelStatus) => void): () => void
  filePath(rel: string): string
  /** Shutdown: abort the running download (its `.part` stays for the resume). */
  close(): void
}

export interface SttModelManagerOptions {
  dir?: string
  files?: SttModelFile[]
  /** Request sent → first body byte. */
  connectTimeoutMs?: number
  /** Max gap between body chunks once bytes flow. */
  stallTimeoutMs?: number
  progressIntervalMs?: number
}

export function createSttModelManager(opts: SttModelManagerOptions = {}): SttModelManager {
  const files = opts.files ?? STT_MODEL_FILES
  const connectTimeoutMs = opts.connectTimeoutMs ?? 15_000
  const stallTimeoutMs = opts.stallTimeoutMs ?? 30_000
  const progressIntervalMs = opts.progressIntervalMs ?? 500
  // Lazy: HOME (hence globalDir) is read at use time, not import time.
  const filePath = (rel: string) => path.join(opts.dir ?? globalSttModelsDir(), rel)
  const total = files.reduce((n, f) => n + f.size, 0)

  const listeners = new Set<(s: SttModelStatus) => void>()
  let inflight: Promise<void> | null = null
  let received = 0
  let lastError = ''
  let lastEmit = 0
  let current: AbortController | null = null
  let closed = false

  const fileReady = (f: SttModelFile) => {
    try { return fs.statSync(filePath(f.path)).size === f.size } catch { return false }
  }

  function status(): SttModelStatus {
    if (inflight) return { state: 'downloading', received, total }
    if (files.every(fileReady)) return { state: 'ready' }
    if (lastError) return { state: 'error', message: lastError }
    return { state: 'missing' }
  }

  function emit(): void {
    lastEmit = Date.now()
    const s = status()
    for (const l of listeners) l(s)
  }

  /** One attempt of one source. Resolves when the verified file is in place. */
  async function fetchFile(f: SttModelFile, url: string, base: number): Promise<void> {
    const final = filePath(f.path)
    const part = `${final}.part`
    fs.mkdirSync(path.dirname(final), { recursive: true })
    let have = 0
    try { have = fs.statSync(part).size } catch { /* no .part yet */ }
    if (have > f.size) { fs.rmSync(part, { force: true }); have = 0 }
    received = base + have
    if (have === f.size) {
      // Complete but never renamed (killed between verify and rename).
      const hash = createHash('sha256')
      for await (const chunk of fs.createReadStream(part)) hash.update(chunk as Buffer)
      if (hash.digest('hex') === f.sha256) { fs.renameSync(part, final); return }
      fs.rmSync(part, { force: true })
      have = 0
    }

    const ac = new AbortController()
    current = ac
    let reason = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    const arm = (ms: number, why: string) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { reason = why; ac.abort() }, ms)
    }
    arm(connectTimeoutMs, `no data within ${connectTimeoutMs / 1000}s`)
    try {
      const res = await httpGet(url, have > 0 ? { Range: `bytes=${have}-` } : {}, ac.signal)
      if (res.statusCode === 416) {
        // .part (shorter than the pinned size) isn't a range this source can
        // extend — it can't be trusted as a prefix; the next source starts over.
        fs.rmSync(part, { force: true })
        throw new Error('HTTP 416')
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) throw new Error(`HTTP ${res.statusCode}`)
      const resume = res.statusCode === 206
      if (resume && !(res.headers['content-range'] ?? '').startsWith(`bytes ${have}-`)) {
        throw new Error(`unexpected Content-Range ${res.headers['content-range'] ?? '(none)'}`)
      }
      if (have > 0) console.log(`[STT] ${f.path}: ${resume ? `resuming at ${have} bytes` : `source ignored Range, restarting from 0 (had ${have} bytes)`}`)
      const hash = createHash('sha256')
      let got = 0
      if (resume) {
        for await (const chunk of fs.createReadStream(part)) hash.update(chunk as Buffer)
        got = have
      }
      const fh = await fsp.open(part, resume ? 'a' : 'w')
      try {
        for await (const value of res as AsyncIterable<Buffer>) {
          arm(stallTimeoutMs, `stalled for ${stallTimeoutMs / 1000}s`)
          got += value.length
          if (got > f.size) break
          hash.update(value)
          await fh.write(value)
          received = base + got
          if (Date.now() - lastEmit >= progressIntervalMs) emit()
        }
      } finally {
        await fh.close()
      }
      // Short body (connection ended early): the .part is still a valid
      // prefix — keep it, the next source / trigger resumes it.
      if (got < f.size) throw new Error(`truncated (${got} of ${f.size} bytes)`)
      if (got > f.size || hash.digest('hex') !== f.sha256) {
        fs.rmSync(part, { force: true })
        throw new Error(got > f.size ? `size mismatch (more than ${f.size} bytes)` : 'sha256 mismatch')
      }
      fs.renameSync(part, final)
    } catch (err) {
      if (reason) throw new Error(reason)
      throw err
    } finally {
      if (timer) clearTimeout(timer)
      ac.abort()
      current = null
    }
  }

  async function run(): Promise<void> {
    let base = files.filter(fileReady).reduce((n, f) => n + f.size, 0)
    received = base
    for (const f of files) {
      if (fileReady(f)) continue
      const failures: string[] = []
      for (const src of f.sources) {
        if (closed) return
        const t0 = Date.now()
        try {
          await fetchFile(f, src.url, base)
          console.log(`[STT] downloaded ${f.path} from ${src.name} (${(f.size / 1048576).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s)`)
          failures.length = 0
          break
        } catch (err) {
          if (closed) return
          const msg = err instanceof Error ? err.message : String(err)
          failures.push(`${src.name}: ${msg}`)
          console.log(`[STT] download ${f.path} from ${src.name} failed: ${msg}`)
        }
      }
      if (failures.length > 0) {
        lastError = `${path.basename(f.path)}: all sources failed (${failures.join('; ')})`
        return
      }
      base += f.size
      received = base
    }
  }

  function ensure(): Promise<void> {
    if (inflight) return inflight
    if (closed || files.every(fileReady)) return Promise.resolve()
    lastError = ''
    console.log('[STT] model download start')
    inflight = run().finally(() => {
      inflight = null
      emit()
    })
    emit()
    return inflight
  }

  return {
    status,
    ensure,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    filePath,
    close() {
      closed = true
      current?.abort()
    },
  }
}

/** The server's instance (WS route, engine, extensions watcher). */
export const sttModels = createSttModelManager()
