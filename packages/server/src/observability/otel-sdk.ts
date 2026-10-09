/**
 * The ONE module that loads the OpenTelemetry SDK + OTLP exporters, only when
 * an endpoint is configured, so an unconfigured server / `halo cli` /
 * `halo tui` never pays for the SDK module graph (~120ms).
 *
 * The SDK packages are `import()`ed inside registerSdk, not imported at the top:
 * the npm bundle (esbuild, packages/cli/scripts/build-bundle.mjs) inlines this
 * module, and top-level imports of those external packages would be hoisted
 * into the bundle's static imports, loading on every `halo` start, `--version`
 * included. otel.ts's dynamic import of this file alone doesn't survive that.
 */
import { metrics } from '@opentelemetry/api'
import { logs } from '@opentelemetry/api-logs'
import type { HaloProcess } from './otel.js'

export interface Provider {
  forceFlush(): Promise<void>
  shutdown(): Promise<void>
}

/** Build + register trace / metric / log providers. Exporters read endpoint,
 *  headers and protocol from the OTEL_* env vars otel.ts has already set.
 *  `halo.process` is the only thing telling a server's telemetry from a cli's —
 *  both share service.name, and no resource detectors run. */
export async function registerSdk(serviceName: string, serviceVersion: string, haloProcess: HaloProcess): Promise<Provider[]> {
  const [
    { resourceFromAttributes },
    { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
    { NodeTracerProvider },
    { BatchSpanProcessor },
    { MeterProvider, PeriodicExportingMetricReader },
    { LoggerProvider, BatchLogRecordProcessor },
    { OTLPTraceExporter },
    { OTLPMetricExporter },
    { OTLPLogExporter },
  ] = await Promise.all([
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions'),
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/sdk-trace-base'),
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/sdk-logs'),
    import('@opentelemetry/exporter-trace-otlp-proto'),
    import('@opentelemetry/exporter-metrics-otlp-proto'),
    import('@opentelemetry/exporter-logs-otlp-proto'),
  ])
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
    'halo.process': haloProcess,
  })
  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  })
  tracerProvider.register()
  const meterProvider = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 15_000 })],
  })
  metrics.setGlobalMeterProvider(meterProvider)
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
  })
  logs.setGlobalLoggerProvider(loggerProvider)
  return [tracerProvider, meterProvider, loggerProvider]
}
