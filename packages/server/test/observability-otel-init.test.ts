import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * initObservability / shutdownObservability contract, shared by the server and
 * `halo cli` / `halo tui` (packages/cli/src/harness.ts):
 *  - no endpoint → false, otel-sdk.ts never loaded (the unconfigured cli start
 *    pays nothing);
 *  - endpoint → providers registered with the caller's `halo.process` kind;
 *  - the exit flush is capped (dead collector can't hang exit) and idempotent
 *    (a signal landing mid-flush shares the in-flight one).
 */

const registerSdk = vi.fn()
vi.mock('../src/observability/otel-sdk.js', () => ({ registerSdk }))

const ENV_KEYS = ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_SERVICE_NAME', 'OTEL_EXPORTER_OTLP_PROTOCOL'] as const
const savedEnv: Record<string, string | undefined> = {}

/** Fresh otel.ts module state (enabled / providers / in-flight shutdown) per test. */
async function loadOtel() {
  vi.resetModules()
  return import('../src/observability/otel.js')
}

beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
  registerSdk.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('initObservability', () => {
  it('no endpoint → false, otel-sdk.ts never imported', async () => {
    const otel = await loadOtel()
    expect(await otel.initObservability('cli')).toBe(false)
    expect(otel.enabled).toBe(false)
    expect(registerSdk).not.toHaveBeenCalled()
    // Nothing registered → shutdown is an instant no-op.
    expect(await otel.shutdownObservability()).toBe(true)
  })

  it('endpoint → registers providers tagged with the process kind', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:1'
    registerSdk.mockResolvedValue([])
    const otel = await loadOtel()
    expect(await otel.initObservability('tui')).toBe(true)
    expect(otel.enabled).toBe(true)
    expect(registerSdk).toHaveBeenCalledWith('halo', expect.any(String), 'tui')
  })

  it("defaults to 'server' (the server's own call site passes nothing)", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:1'
    registerSdk.mockResolvedValue([])
    const otel = await loadOtel()
    await otel.initObservability()
    expect(registerSdk).toHaveBeenCalledWith('halo', expect.any(String), 'server')
  })
})

describe('shutdownObservability', () => {
  it('flushes then shuts down each provider; resolves true when done in time', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:1'
    const calls: string[] = []
    const provider = {
      forceFlush: vi.fn(async () => { calls.push('flush') }),
      shutdown: vi.fn(async () => { calls.push('shutdown') }),
    }
    registerSdk.mockResolvedValue([provider])
    const otel = await loadOtel()
    await otel.initObservability('cli')
    expect(await otel.shutdownObservability()).toBe(true)
    expect(calls).toEqual(['flush', 'shutdown'])
  })

  it('a hung collector is capped at 3s, and a second call shares the in-flight flush', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:1'
    const provider = { forceFlush: vi.fn(() => new Promise<void>(() => {})), shutdown: vi.fn(async () => {}) }
    registerSdk.mockResolvedValue([provider])
    const otel = await loadOtel()
    await otel.initObservability('cli')
    vi.useFakeTimers()
    const first = otel.shutdownObservability()
    const second = otel.shutdownObservability()
    expect(second).toBe(first)
    let settled: boolean | undefined
    void first.then((v) => { settled = v })
    await vi.advanceTimersByTimeAsync(2_999)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(false)
    expect(provider.forceFlush).toHaveBeenCalledTimes(1)
  })
})
