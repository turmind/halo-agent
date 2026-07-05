import express from 'express'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import crypto from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.PORT || '9528', 10)
const HALO_API = process.env.HALO_API || 'http://localhost:9527'
const HALO_TOKEN = process.env.HALO_TOKEN || ''
const PASSWORD = process.env.HALO_WEB_DEMO_PASSWORD || ''

if (!HALO_TOKEN) {
  console.error('[web-demo] HALO_TOKEN is required (get it from halo admin panel)')
  process.exit(1)
}

const app = express()
app.use(express.json({ limit: '10mb' }))

// ── Session auth (HMAC-based, survives restart) ──

function createSession() {
  const payload = Date.now().toString(36)
  const sig = crypto.createHmac('sha256', PASSWORD).update(payload).digest('hex').slice(0, 16)
  return `${payload}.${sig}`
}

function isValidSession(token) {
  if (!token || !PASSWORD) return !PASSWORD
  const dot = token.indexOf('.')
  if (dot === -1) return false
  const payload = token.slice(0, dot)
  const sig = crypto.createHmac('sha256', PASSWORD).update(payload).digest('hex').slice(0, 16)
  return sig === token.slice(dot + 1)
}

function authMiddleware(req, res, next) {
  if (!PASSWORD) return next()
  const sid = req.headers['x-session']
  if (!isValidSession(sid)) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  next()
}

// ── Brute-force protection ──

const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000
const loginAttempts = new Map()

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (forwarded) return forwarded.split(',')[0].trim()
  return req.socket?.remoteAddress || 'unknown'
}

function isLockedOut(ip) {
  const record = loginAttempts.get(ip)
  if (!record) return false
  if (record.count >= MAX_ATTEMPTS) {
    if (Date.now() - record.lastAttempt < LOCKOUT_MS) return true
    loginAttempts.delete(ip)
  }
  return false
}

function recordFailure(ip) {
  const record = loginAttempts.get(ip)
  if (record) { record.count++; record.lastAttempt = Date.now() }
  else loginAttempts.set(ip, { count: 1, lastAttempt: Date.now() })
}

function clearFailures(ip) { loginAttempts.delete(ip) }

app.post('/auth/login', (req, res) => {
  if (!PASSWORD) return res.json({ ok: true, session: '' })

  const ip = getClientIp(req)
  if (isLockedOut(ip)) {
    return res.status(429).json({ error: 'too many attempts, try again later' })
  }

  if (req.body.password !== PASSWORD) {
    recordFailure(ip)
    return res.status(401).json({ error: 'wrong password' })
  }

  clearFailures(ip)
  res.json({ ok: true, session: createSession() })
})

// ── Halo API client ──

async function haloFetch(path, opts = {}) {
  const url = `${HALO_API}/api/web${path}`
  const headers = {
    'content-type': 'application/json',
    'x-token': HALO_TOKEN,
    ...opts.headers,
  }
  return fetch(url, { ...opts, headers })
}

// ── Web-demo own API ──

app.post('/chat', authMiddleware, async (req, res) => {
  const { message, images } = req.body
  if (!message && (!images || images.length === 0)) {
    return res.status(400).json({ error: 'message required' })
  }

  try {
    const upstream = await haloFetch('/chat', {
      method: 'POST',
      body: JSON.stringify({ message, images }),
    })

    if (!upstream.ok) {
      const err = await upstream.text()
      return res.status(upstream.status).send(err)
    }

    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('cache-control', 'no-cache')
    res.setHeader('connection', 'keep-alive')

    const reader = upstream.body.getReader()
    req.on('close', () => reader.cancel())

    while (true) {
      const { done, value } = await reader.read()
      if (done) { res.end(); return }
      res.write(value)
    }
  } catch {
    res.status(502).json({ error: 'halo unavailable' })
  }
})

app.post('/stop', authMiddleware, async (req, res) => {
  try {
    const upstream = await haloFetch('/stop', { method: 'POST' })
    const data = await upstream.json()
    res.json(data)
  } catch {
    res.status(502).json({ error: 'halo unavailable' })
  }
})

app.get('/history', authMiddleware, async (req, res) => {
  try {
    const upstream = await haloFetch('/history')
    const data = await upstream.json()
    res.json(data)
  } catch {
    res.status(502).json({ error: 'halo unavailable' })
  }
})

app.get('/subscribe', authMiddleware, async (req, res) => {
  try {
    const upstream = await haloFetch('/subscribe')

    if (!upstream.ok) {
      const err = await upstream.text()
      return res.status(upstream.status).send(err)
    }

    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('cache-control', 'no-cache')
    res.setHeader('connection', 'keep-alive')

    const reader = upstream.body.getReader()
    req.on('close', () => reader.cancel())

    while (true) {
      const { done, value } = await reader.read()
      if (done) { res.end(); return }
      res.write(value)
    }
  } catch {
    res.status(502).json({ error: 'halo unavailable' })
  }
})

app.get('/file', authMiddleware, async (req, res) => {
  const filePath = req.query.path
  if (!filePath) return res.status(400).json({ error: 'path required' })

  try {
    const url = `${HALO_API}/api/web/file?path=${encodeURIComponent(filePath)}`
    const upstream = await fetch(url, { headers: { 'x-token': HALO_TOKEN } })
    if (!upstream.ok) {
      return res.status(upstream.status).send(await upstream.text())
    }
    const ct = upstream.headers.get('content-type')
    const cd = upstream.headers.get('content-disposition')
    if (ct) res.setHeader('content-type', ct)
    if (cd) res.setHeader('content-disposition', cd)

    const reader = upstream.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) { res.end(); return }
      res.write(value)
    }
  } catch {
    res.status(502).json({ error: 'halo unavailable' })
  }
})

// ── Static files ──

app.use(express.static(path.join(__dirname, 'public')))

app.listen(PORT, () => {
  console.log(`[web-demo] listening on http://localhost:${PORT}`)
})
