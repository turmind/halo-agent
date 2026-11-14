/**
 * OpenTelemetry bootstrap. Everything else in the server (genai-spans.ts,
 * logger.ts) talks only to the `@opentelemetry/api` / `@opentelemetry/api-logs`
 * proxies, which stay no-op until a provider is registered here. Both api
 * packages, and the SDK + OTLP exporters in otel-sdk.ts, are dynamically
 * imported only when an endpoint is configured — an unconfigured process
 * (server, `halo cli`, `halo tui`) loads no OpenTelemetry package at all.
 *
 * Vendor-neutral by design: the three signals leave over OTLP http/protobuf to
 * whatever collector `general.observability.endpoint` points at. Config keys are
 * mapped onto the standard `OTEL_*` env vars with `??=` so an operator who
 * already exports them (or `--require`s an external distro) wins.
 */
import type { Meter, Tracer } from '@opentelemetry/api'
import type { Logger } from '@opentelemetry/api-logs'
import { config } from '../config.js'
import { settingsOtelEnvKeys } from '../child-env.js'
import type { Provider } from './otel-sdk.js'

const SCOPE = 'opentelemetry.instrumentation.halo'

/** Which halo process is exporting — the `halo.process` resource attribute.
 *  Evolution children are spawned `halo cli` runs, so they report `cli`
 *  (their `session.id` — the `__evo_agent__`-style agent name — tells them
 *  apart from a hand-run cli); cron runs in the server and reports `server`. */
export type HaloProcess = 'server' | 'cli' | 'tui'

/** Cap on the exit-time flush. A healthy collector acks an OTLP POST in tens
 *  of ms; 3s leaves room for the metrics provider's two sequential exports
 *  (forceFlush + shutdown) plus one ~1s exporter retry, and stays well inside
 *  the cron runner's 30s / evo wrapper's 10s SIGTERM→SIGKILL grace. */
const SHUTDOWN_CAP_MS = 3_000

/** True once initObservability() found an endpoint (ours or an external
 *  SDK's). The hot-path hooks gate on this single boolean so an unconfigured
 *  server pays nothing beyond the check. Only ever true after loadApi(), so
 *  code behind the gate may use `api` / `apiLogs` / `tracer` / `otelLogger`. */
export let enabled = false

/** The `@opentelemetry/api` / `api-logs` modules — null until an endpoint is
 *  configured (they are imported in loadApi(), never at module top: the npm
 *  bundle would otherwise load them on every start). */
export let api: typeof import('@opentelemetry/api') | null = null
export let apiLogs: typeof import('@opentelemetry/api-logs') | null = null

// Tracer / logger come back as api proxies that pick up the real provider once
// it's registered. The metrics api has NO proxy: a Meter fetched before
// setGlobalMeterProvider() is a permanent no-op, so callers resolve the meter
// lazily (see genai-spans.ts) instead of at import time.
export let tracer: Tracer
export let otelLogger: Logger
export const getMeter = (): Meter => api!.metrics.getMeter(SCOPE, '1')

async function loadApi(): Promise<void> {
  if (api) return
  const [traceApi, logsApi] = await Promise.all([import('@opentelemetry/api'), import('@opentelemetry/api-logs')])
  tracer = traceApi.trace.getTracer(SCOPE, '1')
  otelLogger = logsApi.logs.getLogger(SCOPE, '1')
  api = traceApi
  apiLogs = logsApi
}

/** Test-only: flip the gate without going through env / config. */
export async function _setEnabledForTests(value: boolean): Promise<void> {
  if (value) await loadApi()
  enabled = value
}

export const captureContent = (): boolean => config.observability.captureContent

let providers: Provider[] = []

/** An external distro registered ahead of us (e.g. `node --require` of a
 *  vendor SDK) leaves the api's ProxyTracerProvider delegating to a real
 *  provider. A fresh ProxyTracerProvider's delegate is the shared NoopTracerProvider
 *  singleton, so comparing against it tells no-op from "someone's already here". */
function externalSdkRegistered(): boolean {
  const { trace, ProxyTracerProvider } = api!
  const provider = trace.getTracerProvider()
  if (!(provider instanceof ProxyTracerProvider)) return true // registered directly, not via the api's proxy
  return provider.getDelegate() !== new ProxyTracerProvider().getDelegate()
}

/** `??=` a settings value onto env, recording the key so cleanChildEnv() drops
 *  it — boot-time settings inherited by children would beat the child's own
 *  fresh read. An operator-exported key is left alone and still inherited. */
function setFromSettings(key: string, value: string): void {
  if (process.env[key] !== undefined) return
  process.env[key] = value
  settingsOtelEnvKeys.add(key)
}

/**
 * Map settings → OTEL_* env, then register trace / metric / log providers when
 * an endpoint is configured. Resolves to whether export is active. Call once,
 * before initLogger() so the logger interceptors can read `enabled`.
 */
export async function initObservability(haloProcess: HaloProcess = 'server'): Promise<boolean> {
  const { endpoint, serviceName, headers } = config.observability
  if (endpoint) setFromSettings('OTEL_EXPORTER_OTLP_ENDPOINT', endpoint)
  if (headers) setFromSettings('OTEL_EXPORTER_OTLP_HEADERS', headers)
  setFromSettings('OTEL_SERVICE_NAME', serviceName)
  // Declarative only: the *-otlp-proto exporters in otel-sdk.ts are hard-wired
  // to http/protobuf (http:// or https:// by URL scheme; no gRPC). Set so an
  // external SDK loaded via --require picks the same wire protocol.
  setFromSettings('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/protobuf')

  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return false
  await loadApi()
  enabled = true

  if (externalSdkRegistered()) {
    console.log('[Observability] external OpenTelemetry SDK already registered — using it, skipping built-in exporters')
    return true
  }

  const { registerSdk } = await import('./otel-sdk.js')
  providers = await registerSdk(process.env.OTEL_SERVICE_NAME!, process.env.HALO_VERSION ?? 'dev', haloProcess)
  console.log(`[Observability] OTLP export → ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT} (service.name=${process.env.OTEL_SERVICE_NAME}, halo.process=${haloProcess}, capture_content=${config.observability.captureContent})`)
  return true
}

let shutdown: Promise<boolean> | null = null

/** Flush + shut down the providers we registered, capped at SHUTDOWN_CAP_MS so
 *  a dead collector can't hold up process exit. Idempotent (a signal can land
 *  while the end-of-run flush is in flight). Resolves false when the cap fired:
 *  the exporters' own retry / timeout timers (10s OTLP timeout, 30s batch
 *  export timeout) are then still pending and keep the event loop alive, so a
 *  caller relying on a natural exit must process.exit() itself. */
export function shutdownObservability(): Promise<boolean> {
  if (providers.length === 0) return Promise.resolve(true)
  shutdown ??= (async () => {
    const all = Promise.all(providers.map(async (p) => {
      try { await p.forceFlush() } catch { /* ok */ }
      try { await p.shutdown() } catch { /* ok */ }
    })).then(() => true)
    let timer: ReturnType<typeof setTimeout> | undefined
    const cap = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), SHUTDOWN_CAP_MS) })
    // Cleared either way: a pending cap timer would itself hold a cli that
    // finished flushing in 50ms open for the full 3s.
    try { return await Promise.race([all, cap]) } finally { clearTimeout(timer) }
  })()
  return shutdown
}
