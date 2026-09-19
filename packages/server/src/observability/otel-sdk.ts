/**
 * The ONE module that imports the OpenTelemetry SDK + OTLP exporters. Loaded
 * via dynamic import from otel.ts only when an endpoint is configured, so the
 * unconfigured server (and the CLI, which shares logger.ts) never pays for
 * the SDK module graph.
 */
import { metrics } from '@opentelemetry/api'
import { logs } from '@opentelemetry/api-logs'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'

export interface Provider {
  forceFlush(): Promise<void>
  shutdown(): Promise<void>
}

/** Build + register trace / metric / log providers. Exporters read endpoint,
 *  headers and protocol from the OTEL_* env vars otel.ts has already set. */
export function registerSdk(serviceName: string, serviceVersion: string): Provider[] {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
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
