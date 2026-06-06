/**
 * Password hashing using Node's built-in scrypt — no external deps.
 *
 * Format on disk:
 *   scrypt$N=16384,r=8,p=1$<salt-base64>$<hash-base64>
 *
 * The cost parameters are inlined so a future bump (`N=32768` etc.) can be
 * verified against existing hashes without breaking older deployments.
 */
import crypto from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(crypto.scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>

const COST = { N: 16384, r: 8, p: 1 } as const
const KEY_LEN = 32

/** Hash a plaintext password. Returns the canonical on-disk encoding. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.randomBytes(16)
  const hash = await scryptAsync(plain, salt, KEY_LEN, COST)
  return `scrypt$N=${COST.N},r=${COST.r},p=${COST.p}$${salt.toString('base64')}$${hash.toString('base64')}`
}

/** Constant-time verify a plaintext against a stored hash. */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (!stored.startsWith('scrypt$')) return false
  const parts = stored.split('$')
  if (parts.length !== 4) return false
  const params = parts[1]!
  const saltB64 = parts[2]!
  const hashB64 = parts[3]!

  const opts: Record<string, number> = {}
  for (const kv of params.split(',')) {
    const [k, v] = kv.split('=')
    if (k && v) opts[k] = parseInt(v, 10)
  }
  const N = opts.N
  const r = opts.r
  const p = opts.p
  if (!N || !r || !p) return false

  const salt = Buffer.from(saltB64, 'base64')
  const expected = Buffer.from(hashB64, 'base64')
  const actual = await scryptAsync(plain, salt, expected.length, { N, r, p })
  return crypto.timingSafeEqual(actual, expected)
}

/** Generate a random JWT signing secret as base64. 32 bytes = 256 bits. */
export function generateJwtSecret(): string {
  return crypto.randomBytes(32).toString('base64')
}
