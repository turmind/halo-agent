import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { api } from '../src/shared/api-client'
import { getExtensionToken, extensionEntryUrl, resetExtensionTokenCache } from '../src/features/editor/previews/extension-token'

/**
 * Contract: one asset token per page — concurrent first callers share the
 * in-flight request, later callers reuse the cached token until it is within
 * a minute of expiry, and the token rides in the asset URL as a path segment
 * (a sandboxed iframe's subresources carry no cookie and inherit no query).
 */

const HOUR = 60 * 60 * 1000

beforeEach(() => {
  resetExtensionTokenCache()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('getExtensionToken', () => {
  it('dedupes concurrent callers and caches the result', async () => {
    const spy = vi.spyOn(api.extensions, 'token').mockResolvedValue({ token: 't1', expiresAt: Date.now() + 24 * HOUR })
    const [a, b] = await Promise.all([getExtensionToken(), getExtensionToken()])
    expect(a).toBe('t1')
    expect(b).toBe('t1')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(await getExtensionToken()).toBe('t1')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('re-mints when within the refresh margin of expiry', async () => {
    const spy = vi.spyOn(api.extensions, 'token')
      .mockResolvedValueOnce({ token: 't1', expiresAt: Date.now() + HOUR })
      .mockResolvedValueOnce({ token: 't2', expiresAt: Date.now() + 25 * HOUR })
    expect(await getExtensionToken()).toBe('t1')
    vi.setSystemTime(Date.now() + HOUR - 30_000) // 30s left → inside the 60s margin
    expect(await getExtensionToken()).toBe('t2')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('a failed mint is not cached — the next call retries', async () => {
    const spy = vi.spyOn(api.extensions, 'token')
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce({ token: 't1', expiresAt: Date.now() + HOUR })
    await expect(getExtensionToken()).rejects.toThrow('503')
    expect(await getExtensionToken()).toBe('t1')
    expect(spy).toHaveBeenCalledTimes(2)
  })
})

describe('extensionEntryUrl', () => {
  it('puts the token in the path ahead of the entry, leaving the entry path intact', () => {
    expect(extensionEntryUrl('glb', '1.0.0', 'tok/en', 'dist/index.html'))
      .toBe('/api/extensions/glb/1.0.0/tok%2Fen/dist/index.html')
  })
})
