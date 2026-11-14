import { describe, it, expect, afterAll } from 'vitest'

/**
 * otel.ts imports @opentelemetry/api as ESM; the SDK packages otel-sdk.ts loads
 * `require()` it. Both must land on the same api build, or the tracer otel.ts
 * hands out never sees the provider the SDK registers and every span is a
 * NonRecordingSpan. api 1.10 ships split .mjs / .cjs builds and does exactly
 * that — pinned below 1.10 in pnpm-workspace.yaml `overrides`.
 */

const savedEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT

afterAll(async () => {
  const otel = await import('../src/observability/otel.js')
  await otel.shutdownObservability()
  otel.api?.trace.disable()
  otel.api?.metrics.disable()
  otel.apiLogs?.logs.disable()
  if (savedEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = savedEndpoint
})

describe('initObservability with the real SDK', () => {
  it('a span from the exported tracer records', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:1'
    const otel = await import('../src/observability/otel.js')
    expect(await otel.initObservability('cli')).toBe(true)
    const span = otel.tracer.startSpan('probe')
    expect(span.isRecording()).toBe(true)
    span.end()
  })
})
