import { describe, it, expect } from 'vitest'
import { redactSecrets } from '../src/logger.js'

describe('redactSecrets', () => {
  it('scrubs ?token= and &token= values, keeps the rest of the URL', () => {
    expect(redactSecrets('GET /api/web/file?path=a.png&token=abc123XYZ done'))
      .toBe('GET /api/web/file?path=a.png&token=<redacted> done')
    expect(redactSecrets('http://h/api/web/subscribe?token=t0k.en-_~'))
      .toBe('http://h/api/web/subscribe?token=<redacted>')
  })

  it('stops at quotes / whitespace / next param', () => {
    expect(redactSecrets('url="/x?token=abc" next')).toBe('url="/x?token=<redacted>" next')
    expect(redactSecrets('/x?token=abc&path=y')).toBe('/x?token=<redacted>&path=y')
  })

  it('leaves unrelated text and bare "token" words alone', () => {
    expect(redactSecrets('[SessionManager] token count 1200')).toBe('[SessionManager] token count 1200')
    expect(redactSecrets('maxContextTokens=200000')).toBe('maxContextTokens=200000')
  })
})
