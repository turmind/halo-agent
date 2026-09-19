/**
 * OpenTelemetry bootstrap. Everything else in the server (genai-spans.ts,
 * logger.ts) talks only to the `@opentelemetry/api` / `@opentelemetry/api-logs`
 * proxies, which stay no-op until a provider is registered here. The SDK +
 * OTLP exporters live in otel-sdk.ts and are dynamically imported only when an
 * endpoint is configured — an unconfigured server (or the CLI, which shares
 * logger.ts) never loads them.
 *
 * Vendor-neutral by design: the three signals leave over OTLP http/protobuf to
 * whatever collector `general.observability.endpoint` points at. Config keys are
 * mapped onto the standard `OTEL_*` env vars with `??=` so an operator who
 * already exports them (or `--require`s an external distro) wins.
 */
import { trace, metrics, ProxyTracerProvider, type Meter } from '@opentelemetry/api'
import { logs } from '@opentelemetry/api-logs'
import { config } from '../config.js'
import type { Provider } from './otel-sdk.js'

const SCOPE = 'opentelemetry.instrumentation.halo'

/** True once initObservability() found an endpoint (ours or an external
 *  SDK's). The hot-path hooks gate on this single boolean so an unconfigured
 *  server pays nothing beyond the check. */
export let enabled = false

/** Test-only: flip the gate without going through env / config. */
export function _setEnabledForTests(value: boolean): void {
  enabled = value
}

// Tracer / logger come back as api proxies that pick up the real provider once
// it's registered. The metrics api has NO proxy: a Meter fetched before
// setGlobalMeterProvider() is a permanent no-op, so callers resolve the meter
// lazily (see genai-spans.ts) instead of at import time.
export const tracer = trace.getTracer(SCOPE, '1')
export const getMeter = (): Meter => metrics.getMeter(SCOPE, '1')
export const otelLogger = logs.getLogger(SCOPE, '1')

export const captureContent = (): boolean => config.observability.captureContent

let providers: Provider[] = []

/** An external distro registered ahead of us (e.g. `node --require` of a
 *  vendor SDK) leaves the api's ProxyTracerProvider delegating to a real
 *  provider. A fresh ProxyTracerProvider's delegate is the shared NoopTracerProvider
 *  singleton, so comparing against it tells no-op from "someone's already here". */
function externalSdkRegistered(): boolean {
  const provider = trace.getTracerProvider()
  if (!(provider instanceof ProxyTracerProvider)) return true // registered directly, not via the api's proxy
  return provider.getDelegate() !== new ProxyTracerProvider().getDelegate()
}

/**
 * Map settings → OTEL_* env, then register trace / metric / log providers when
 * an endpoint is configured. Resolves to whether export is active. Call once,
 * before initLogger() so the logger interceptors can read `enabled`.
 */
export async function initObservability(): Promise<boolean> {
  const { endpoint, serviceName, headers } = config.observability
  if (endpoint) process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= endpoint
  if (headers) process.env.OTEL_EXPORTER_OTLP_HEADERS ??= headers
  process.env.OTEL_SERVICE_NAME ??= serviceName
  // Declarative only: the *-otlp-proto exporters in otel-sdk.ts are hard-wired
  // to http/protobuf (http:// or https:// by URL scheme; no gRPC). Set so an
  // external SDK loaded via --require picks the same wire protocol.
  process.env.OTEL_EXPORTER_OTLP_PROTOCOL ??= 'http/protobuf'

  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return false
  enabled = true

  if (externalSdkRegistered()) {
    console.log('[Observability] external OpenTelemetry SDK already registered — using it, skipping built-in exporters')
    return true
  }

  const { registerSdk } = await import('./otel-sdk.js')
  providers = registerSdk(process.env.OTEL_SERVICE_NAME, process.env.HALO_VERSION ?? 'dev')
  console.log(`[Observability] OTLP export → ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT} (service.name=${process.env.OTEL_SERVICE_NAME}, capture_content=${config.observability.captureContent})`)
  return true
}

/** Flush + shut down the providers we registered, bounded to 3s total so a
 *  dead collector can't hold up process exit. */
export async function shutdownObservability(): Promise<void> {
  if (providers.length === 0) return
  const all = Promise.all(providers.map(async (p) => {
    try { await p.forceFlush() } catch { /* ok */ }
    try { await p.shutdown() } catch { /* ok */ }
  }))
  await Promise.race([all, new Promise<void>((resolve) => setTimeout(resolve, 3_000))])
}
