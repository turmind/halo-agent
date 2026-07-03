import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, generateJwtSecret } from '../src/middleware/password-hash.js'

/**
 * Contract: hash→verify is the login gate. verifyPassword must return a
 * boolean for ANY stored string — a throw here becomes a 500 on /auth/login
 * (the route awaits it with no try/catch, by design: bad hash = bad password).
 */
describe('password-hash', () => {
  it('hash → verify round-trips', async () => {
    const stored = await hashPassword('s3cret')
    expect(await verifyPassword('s3cret', stored)).toBe(true)
  })

  it('wrong password → false', async () => {
    const stored = await hashPassword('s3cret')
    expect(await verifyPassword('nope', stored)).toBe(false)
  })

  it('same password hashes differently (random salt)', async () => {
    const a = await hashPassword('pw')
    const b = await hashPassword('pw')
    expect(a).not.toBe(b)
    expect(await verifyPassword('pw', a)).toBe(true)
    expect(await verifyPassword('pw', b)).toBe(true)
  })

  it('encodes the documented on-disk format', async () => {
    const stored = await hashPassword('pw')
    expect(stored).toMatch(/^scrypt\$N=16384,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
  })

  it('rejects non-scrypt / structurally malformed stored values as false', async () => {
    expect(await verifyPassword('pw', '')).toBe(false)
    expect(await verifyPassword('pw', 'plaintext')).toBe(false)
    expect(await verifyPassword('pw', 'scrypt$N=16384$onlythree')).toBe(false)
    expect(await verifyPassword('pw', 'scrypt$x=1,y=2,z=3$c2FsdA==$aGFzaA==')).toBe(false)
  })

  it('degenerate digest segments return false, never true (regression)', async () => {
    // A 0-length digest made scrypt derive a 0-byte key and
    // timingSafeEqual(empty, empty) → true: ANY password passed. The digest
    // must be exactly KEY_LEN (32) bytes.
    const stored = await hashPassword('pw')
    const [, params, salt] = stored.split('$')
    // empty digest
    expect(await verifyPassword('pw', `scrypt$${params}$${salt}$`)).toBe(false)
    // pure-padding digest (decodes to 0 bytes)
    expect(await verifyPassword('pw', `scrypt$${params}$${salt}$====`)).toBe(false)
    // garbage base64 digest (decodes to 0 bytes)
    expect(await verifyPassword('pw', `scrypt$${params}$${salt}$!!!!`)).toBe(false)
    // truncated digest (< 32 bytes) — wrong length even if valid base64
    expect(await verifyPassword('pw', `scrypt$${params}$${salt}$c2hvcnQ=`)).toBe(false)
  })

  it('invalid scrypt cost params return false, not a throw (regression)', async () => {
    // A hand-edited/corrupt hash with N=3 (not a power of two) made
    // crypto.scrypt reject → unhandled in /auth/login → 500. Must be false.
    const stored = await hashPassword('pw')
    const tampered = stored.replace(/N=\d+/, 'N=3')
    await expect(verifyPassword('pw', tampered)).resolves.toBe(false)
  })

  it('generateJwtSecret returns 32 random bytes as base64', () => {
    const s = generateJwtSecret()
    expect(Buffer.from(s, 'base64')).toHaveLength(32)
    expect(generateJwtSecret()).not.toBe(s)
  })
})
