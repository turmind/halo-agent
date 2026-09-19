# Observability (OpenTelemetry)

## Overview

A vendor-neutral observability layer built on the official OpenTelemetry JS SDK. One setting, `general.observability.endpoint`, turns on OTLP http/protobuf export of traces, metrics and logs to whatever collector the operator points at — empty means fully off. Principle: zero AWS (or any vendor) code in the server — SigV4 signing, backend endpoints, and resource enrichment all live in the collector, not in halo.

## Configuration

| key | type | default | description |
|---|---|---|---|
| `general.observability.endpoint` | string | `''` | OTLP base URL of an OpenTelemetry collector (e.g. `http://localhost:4318`). Traces, metrics and logs all exported over OTLP http/protobuf — `http://` or `https://`, on the collector's OTLP/HTTP port (4318 by default); gRPC (4317) not supported. Empty = off. Restart required. |
| `general.observability.service_name` | string | `halo` | OTel resource `service.name`. Restart required. |
| `general.observability.headers` | string, **secret** | `''` | Extra headers for every OTLP request, comma-separated `k=v` (e.g. `authorization=Bearer …`). Restart required. |
| `general.observability.capture_content` | boolean | `false` | Put prompt / completion / tool argument+result text on spans (`gen_ai.*.messages` etc.). Off = metadata only (model, tokens, latency, tool names). Restart required. |

All four keys are `globalOnly` and take effect on server restart — `otel.ts` reads them once at boot, before anything else touches the OTel API.

**Env-var mapping.** `initObservability()` maps settings onto the standard `OTEL_*` env vars with `??=`, so an operator who already exports them (or `--require`s an external distro) wins:

- `endpoint` → `OTEL_EXPORTER_OTLP_ENDPOINT`
- `headers` → `OTEL_EXPORTER_OTLP_HEADERS`
- `service_name` → `OTEL_SERVICE_NAME`
- always `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` (declarative — the `*-otlp-proto` exporters are hard-wired to it; this just makes an externally-loaded SDK agree on wire protocol)

No `OTEL_EXPORTER_OTLP_ENDPOINT` after the mapping → `enabled=false`, `initObservability()` returns without registering anything.

**External-SDK detection.** If an external SDK is already registered (e.g. via `node --require` of a vendor distro) — detected by comparing `ProxyTracerProvider.getDelegate()` against a fresh proxy's `NoopTracerProvider` delegate — halo logs `[Observability] external OpenTelemetry SDK already registered — using it, skipping built-in exporters` and skips its own exporters. The `??=` env mapping above still applies first, so the external SDK picks up halo's settings unless it already set its own.

**TLS / HTTPS.** `https://` endpoints work out of the box against CA-signed certs — the exporter picks `node:http` vs `node:https` by URL scheme. Self-signed certs / mTLS go through the standard exporter env vars `OTEL_EXPORTER_OTLP_CERTIFICATE` / `OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE` / `OTEL_EXPORTER_OTLP_CLIENT_KEY` (read by the exporter itself, not by halo code). Verified: a self-signed sink is rejected with `DEPTH_ZERO_SELF_SIGNED_CERT` unless the cert is trusted — no silent bypass.

**Common pitfall**: pointing `endpoint` at 4317 (the collector's gRPC port) instead of 4318 (OTLP/HTTP). Exports then fail silently — the batch processor swallows the error, at most one diagnostic line, no user-visible failure.

## Architecture

| module | role |
|---|---|
| `packages/server/src/observability/otel.ts` (91 lines) | Bootstrap. `initObservability()` / `shutdownObservability()`, the `enabled` gate, `tracer` / `getMeter()` / `otelLogger` / `captureContent()` exports. |
| `packages/server/src/observability/otel-sdk.ts` (47 lines) | The ONE module that imports the SDK packages and OTLP exporters. |
| `packages/server/src/observability/genai-spans.ts` (296 lines) | The span model: `beginTurn` / `onAgentEvent` / `recordRetry` / `endTurn`. |
| `packages/server/src/agents/session-manager.ts` | Calls the four hooks above from the turn loop (see below). |
| `packages/server/src/logger.ts` | Bridges every `logger.*` call into an OTel LogRecord when `enabled`. |
| `packages/server/src/index.ts` | `await initObservability()` (L262, before `initLogger()`) and `await shutdownObservability()` (L599, in `gracefulShutdown`). |

**Hook call sites in `session-manager.ts`**: `beginTurn(session, message)` at L1276 (start of `runAgentTurn`), `onAgentEvent(session, event)` at L1316 (inside the agent event loop, one call per `AgentEvent`), `recordRetry(kind)` at the 7 retry catch sites, `endTurn(session, {error?})` at L1547 (the turn's single exit point, success or failure).

**The `enabled` gate.** `otel.ts` exports a single `enabled: boolean`, set once by `initObservability()`. Every hook in `genai-spans.ts` and the `logger.ts` bridge checks it first — an unconfigured server pays nothing beyond one boolean read per hook call.

**Why `otel-sdk.ts` is a dynamic import.** `logger.ts` is shared with the CLI (`halo cli`), which never wants observability. Eagerly importing the SDK module graph would cost ~100ms on every `halo cli` start. `otel.ts` only `import()`s `otel-sdk.ts` after confirming an endpoint is configured, so the unconfigured path (server or CLI) never loads it.

**Why the meter is lazy.** The `@opentelemetry/api` tracer and logger are proxies — they stay no-op until a real provider is registered, then transparently start forwarding, so `tracer` / `otelLogger` can be module-level consts. The metrics API has **no proxy**: a `Meter` fetched via `metrics.getMeter()` before `setGlobalMeterProvider()` runs is a permanent no-op forever after, even once a provider registers later. `getMeter()` in `otel.ts` is therefore a function, not a const, and `genai-spans.ts` calls it lazily on first metric emission (`instruments()`, cached after).

**Dependencies** (`packages/server/package.json`): `@opentelemetry/api` 1.9.1, `api-logs` 0.222.0, `sdk-trace-node` / `sdk-trace-base` / `sdk-metrics` / `sdk-logs` / `resources` 2.11.0, `exporter-trace-otlp-proto` / `exporter-metrics-otlp-proto` / `exporter-logs-otlp-proto` 0.222.0, `semantic-conventions` 1.43.0. No gRPC exporter (see [Rejected alternatives](#rejected-alternatives)).

**Test coverage**: `packages/server/test/observability-genai-spans.test.ts` (7 cases) drives `beginTurn` / `onAgentEvent` / `endTurn` against an in-memory tracer + `InMemorySpanExporter`, asserting the three-level span tree, parent ids, semconv attribute names, and the `capture_content` on/off split.

## Span model

OTel GenAI semantic conventions. Scope `opentelemetry.instrumentation.halo`, version `1`. Hierarchy: **session** (`session.id`, whole conversation) ⊃ **trace** (one turn = one `invoke_agent` span) ⊃ **span**. All spans `kind=INTERNAL`, all carry `gen_ai.system=halo` and `session.id=<halo session id>`.

### `invoke_agent <agentName>`

One per turn — the root span, opened by `beginTurn` and closed by `endTurn`.

| attribute | always | capture_content |
|---|---|---|
| `gen_ai.operation.name` | `invoke_agent` | |
| `gen_ai.agent.name` | ✓ | |
| `gen_ai.request.model` | ✓ | |
| `gen_ai.task.input` | | user message text |
| `gen_ai.task.output` | | final assistant text |
| `gen_ai.system_instructions` | | system prompt, capped 8 KB — once per turn here, not on every `chat` |

On error: status `ERROR` + the error message, plus a low-cardinality `error.type` attribute (parsed `<ErrName>Error/Exception` prefix, else `_OTHER`).

### `chat <modelId>`

Child of `invoke_agent`, one per model call — created retroactively on the `usage` event (the agent loop only reports a call ended, with its `durationMs`).

| attribute | always | capture_content |
|---|---|---|
| `gen_ai.operation.name` | `chat` | |
| `gen_ai.request.model` | ✓ | |
| `gen_ai.usage.input_tokens` | ✓ | |
| `gen_ai.usage.output_tokens` | ✓ | |
| `gen_ai.response.finish_reasons` | `["tool_use"]` or `["end_turn"]` | |
| `gen_ai.input.messages` | | semconv JSON (see below) — **delta only**: messages appended since this turn's previous `chat` span (first call → the user message; later calls → that cycle's `tool_result`s) |
| `gen_ai.output.messages` | | semconv JSON, only the trailing assistant message |

Semconv message JSON: `[{role, parts:[{type:"text",content}|{type:"tool_call",id,name,arguments}|{type:"tool_call_response",id,result}]}]`.

`gen_ai.input.messages` is incremental on purpose (since 1.3.1): replaying the full history on every model call made a turn's exported bytes O(n²) and the system prompt alone was ~60% of the volume — a 4-turn / 9-call session dropped from 129 KB to 44 KB of content attributes. Nothing is lost: the full conversation for a trace is the concatenation of its `chat` spans' input + output deltas in order (a `TurnState.messageCursor` tracks the boundary; a mid-turn compact that shrinks the history yields an empty delta and re-syncs the cursor). Verified that AgentCore Evaluations scores are unchanged — its evaluators read `invoke_agent`'s `task.*` and `execute_tool`'s `arguments/result`, not the chat messages.

**Note**: `gen_ai.usage.input_tokens` counts only the prompt-cache MISS increment on Bedrock — small values like `2` are normal, not a bug.

### `execute_tool <toolName>`

Child of the `chat` span that requested it, one per tool call — created on the matching `tool_result` event.

| attribute | always | capture_content |
|---|---|---|
| `gen_ai.operation.name` | `execute_tool` | |
| `gen_ai.tool.name` | ✓ | |
| `gen_ai.tool.call.id` | ✓ | |
| `gen_ai.tool.call.arguments` | | JSON |
| `gen_ai.tool.call.result` | | text, empty → `[no output]` |

Tool calls still pending when `endTurn` fires (turn interrupted/aborted mid-cycle) are closed as orphans with status `ERROR` and `halo.tool.orphaned=true`, so no trace is left with a dangling tool-call id.

All content attributes are capped (32 KB general cap, 2 KB per message part, 8 KB for system instructions); over-cap content is truncated with a `…[truncated N chars]` marker, and an over-cap message list drops the oldest messages first with an omission marker.

## Metrics

Exported every 15s via `PeriodicExportingMetricReader`. Same scope as the spans.

| name | kind | unit | attrs |
|---|---|---|---|
| `gen_ai.client.token.usage` | histogram | `{token}` | `gen_ai.request.model`, `gen_ai.token.type=input\|output` |
| `gen_ai.client.operation.duration` | histogram | s | `gen_ai.request.model`, `gen_ai.operation.name=chat` |
| `halo.tool.duration` | histogram | s | `gen_ai.tool.name` |
| `halo.turn.duration` | histogram | s | `outcome=ok\|error` |
| `halo.model.retries` | counter | — | `kind=<retry kind>` |

`halo.model.retries` is incremented by `recordRetry(kind)` from 7 retry sites in `session-manager.ts`: `context_overflow`, `throttle`, `server_error`, `network`, `empty_response`, `corrupted`, `multimodal_4xx`.

## Logs bridge

Every `logger.*` call in `packages/server/src/logger.ts` also emits an OTel LogRecord when `enabled`: severity number `debug=5 / info=9 / warn=13 / error=17`, attribute `halo.module` set to the call's `[ModuleName]` prefix. Same OTLP endpoint, `/v1/logs`.

## Reference: collector → AWS CloudWatch / X-Ray

Verified working, all AWS-specific pieces live in the collector config, not in halo. `otel/opentelemetry-collector-contrib:0.161.0`:

```yaml
extensions:
  sigv4auth/xray:
    region: <region>
    service: xray
  sigv4auth/logs:
    region: <region>
    service: logs

processors:
  resource:
    attributes:
      - { key: aws.service.type, value: gen_ai_agent, action: insert }
      - { key: aws.log.group.names, value: /aws/bedrock-agentcore/runtimes/<name>, action: insert }

exporters:
  otlphttp/xray:
    endpoint: https://xray.<region>.amazonaws.com/v1/traces
    auth: { authenticator: sigv4auth/xray }
  otlphttp/cwlogs:
    endpoint: https://logs.<region>.amazonaws.com/v1/logs
    auth: { authenticator: sigv4auth/logs }
    headers:
      x-aws-log-group: /aws/bedrock-agentcore/runtimes/<name>
      x-aws-log-stream: runtime-logs
  awsemf:
    namespace: bedrock-agentcore
```

Prerequisites: CloudWatch Transaction Search must be enabled (spans land in the shared `aws/spans` log group, no resource policy needed); the log group `/aws/bedrock-agentcore/runtimes/<name>` must be created beforehand.

Halo-side settings for this setup: `endpoint=http://localhost:4318`, `service_name=<name>`, `capture_content=true` (AgentCore Evaluations needs content to score against).

## AgentCore Evaluations

Two modes, both read `aws/spans` filtered by data source `serviceNames: ["<service_name>"]`:

1. **Online evaluation config** (console: AgentCore → Evaluations, or `create-online-evaluation-config`): data source `aws/spans` + serviceNames filter, evaluators e.g. `Builtin.Helpfulness` / `Builtin.GoalSuccessRate` / `Builtin.ToolSelectionAccuracy`, results written to `/aws/bedrock-agentcore/evaluations/results/<config>`. Results appear roughly **15 minutes** after the session goes idle (`sessionTimeoutMinutes` idle detection + a processing queue).
2. **On-demand `aws bedrock-agentcore evaluate`** — synchronous, result only in the response, not persisted. Input: `{"sessionSpans":[<span doc>, …]}`, each span doc the flattened OTLP shape CloudWatch itself writes into `aws/spans`:

```jsonc
{
  "resource": { "attributes": { "service.name": "halo" } },
  "scope": { "name": "opentelemetry.instrumentation.halo", "version": "1" },
  "traceId": "...", "spanId": "...", "parentSpanId": "...",
  "name": "chat <modelId>",
  "kind": "INTERNAL",
  "startTimeUnixNano": "...", "endTimeUnixNano": "...", "durationNano": "...",
  "attributes": { "gen_ai.operation.name": "chat", "...": "..." },
  "status": { "code": "OK" }
}
```

Target by evaluator level:

| evaluator level | example | `--evaluation-target` |
|---|---|---|
| SESSION | `GoalSuccessRate` | omit — feed the whole session |
| TRACE | `Helpfulness`, `Correctness` | `{"traceIds":[…]}` |
| TOOL_CALL | `ToolSelectionAccuracy` | `{"spanIds":[…]}` (passing traceIds → `ValidationException`) |

Verified feeding the input **directly from halo's own OTLP output** (collector `file` exporter → flatten), no CloudWatch involved: `GoalSuccessRate` 1.0, `Helpfulness` 1.0, `ToolSelectionAccuracy` 1.0.

**Contract for custom instrumentation** (official: [supported-frameworks-generic](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/supported-frameworks-generic.html), plus 11 probe runs):

- `scope.name` MUST start with `opentelemetry.instrumentation.*` (or `openinference.instrumentation.*`) — a custom scope like `halo.tracing` → `no spans with supported scope` (the error message only lists named frameworks; the generic prefix rule still applies).
- Every span MUST carry `gen_ai.operation.name` ∈ `{invoke_agent, chat, execute_tool}`; spans without it are skipped (`no spans to evaluate`).
- Content is read from: `invoke_agent`'s `gen_ai.task.input` / `.task.output` (falls back to the first user / last assistant message on `chat` spans); `chat`'s `gen_ai.input.messages` / `.output.messages` / `gen_ai.system_instructions`; `execute_tool`'s `gen_ai.tool.name` / `.tool.call.arguments` / `.tool.call.result`. Values are stringified, not parsed.
- `session.id` groups spans into a session — required for SESSION-level evaluators.
- The parser requires `traceId`, `spanId`, `startTimeUnixNano`, `endTimeUnixNano`. `resource`, `scope.version`, `kind`, `status`, `name`, `durationNano`, `parentSpanId` are all optional — a single-span minimal doc scored fine.
- Strict on keys, lenient on values: garbage attributes with a correct envelope → rejected; correct keys with any string content → scored.
- `gen_ai.tool.definitions` (JSON array of tool schemas on `chat` spans) is read by `GoalSuccessRate` to check called tools were declared; halo does not emit it and still scored 1.0 — optional.

The official spec is spread over three places: the CLI/API reference (envelope only — `sessionSpans` is a list of opaque `document`s, 1–20000), the generic-framework page (semantic contract), and the runtime's own error messages (structural field requirements). None of the three alone is sufficient.

References: [CLI reference](https://docs.aws.amazon.com/cli/latest/reference/bedrock-agentcore/evaluate.html) · [API reference](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_Evaluate.html) · [on-demand guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/getting-started-on-demand.html)

## Rejected alternatives

- **Direct CloudWatch / X-Ray SDK calls from halo** (an earlier 2026-08 prototype) — vendor lock-in inside core; replaced by OTel + collector.
- **ADOT `--require` into the halo process** — pulls in `sdk-node` + gRPC + auto-instrumentations, and its `api-logs` 0.219 is incompatible with halo's 0.222 (0.x minors must match); also couples the process to one vendor's distro. Rejected. The `??=` env mapping + external-SDK detection still let an operator do this if they insist.
- **gRPC exporter** — an extra native-ish dependency (`@grpc/grpc-js`) for a port (4317) that every collector also serves over plain HTTP (4318).
