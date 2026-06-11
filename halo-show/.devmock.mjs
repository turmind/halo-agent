// Dev-only mock: serves halo-show statically + a synthetic /api/show/state so
// the pixel world can be screenshotted without touching a live halo server.
// Not shipped. Run: node .devmock.mjs  (port 8899)
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const PORT = 8899
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }

const SKILLS = (n) => ['acp', 'self', 'cron', 'evo', 'web-search', 'deep-research', 'verify', 'review'].slice(0, n).map((id) => ({ id, name: id, description: `${id} skill — does ${id} things.`, command: id }))
const TOOLS = ['file_read', 'file_edit', 'shell_exec', 'grep', 'web_fetch', 'activate_skill', 'start_session', 'draft']
let t = 0
function mkSessions(prefix, specs) {
  return specs.map((sp, i) => ({
    id: `${prefix}_${i}`, parentId: sp.p ?? null, depth: sp.d ?? 0,
    agentName: sp.n, description: sp.desc || `${sp.n} 正在处理任务 #${i}`,
    status: sp.s, lastTool: sp.s === 'running' ? TOOLS[(i + t) % TOOLS.length] : '',
    activeSkill: sp.sk || '', updatedAt: Date.now() - i * 60000,
    contextTokens: sp.s === 'stopped' ? 0 : 12000 + i * 3300, outputTokens: 800 + i * 450,
  }))
}

function state() {
  t++
  return {
    serverTime: Date.now(), uptime: 44800 + t * 8, accessLevel: 'full', skills: SKILLS(8),
    workspaces: [
      {
        path: '/home/ubuntu/halo-agent', key: 'halo-agent', label: 'jdhuang',
        skills: SKILLS(6),
        sessions: mkSessions('a', [
          { n: 'default', s: 'running', sk: t % 3 === 0 ? 'self' : '' },
          { n: 'executor', s: 'running', sk: 'cron' },
          { n: 'researcher', s: 'idle' },
          { n: 'sub-coder', s: 'running', p: 'a_0', d: 1 },
          { n: 'sub-tester', s: 'idle', p: 'a_0', d: 1 },
          { n: 'reviewer', s: 'stopped' },
          { n: 'old-task', s: 'stopped' },
          { n: 'planner', s: 'idle' },
        ]),
        counts: { running: 3, idle: 3, stopped: 2 }, totalSessions: 8,
      },
      {
        path: '/home/ubuntu/feishu-test', key: 'feishu-test', label: 'feishu-test',
        skills: SKILLS(3),
        sessions: mkSessions('b', [
          { n: 'default', s: 'running', sk: 'acp' },
          { n: 'helper', s: 'idle' },
          { n: 'archivist', s: 'stopped' },
          { n: 'sub-worker', s: 'running', p: 'b_0', d: 1, sk: 'web-search' },
        ]),
        counts: { running: 2, idle: 1, stopped: 1 }, totalSessions: 4,
      },
      {
        path: '/home/ubuntu/web-demo', key: 'web-demo', label: 'web-demo',
        skills: SKILLS(2),
        sessions: mkSessions('c', [{ n: 'default', s: 'idle' }]),
        counts: { running: 0, idle: 1, stopped: 0 }, totalSessions: 1,
      },
    ],
  }
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  if (url.pathname === '/api/show/state') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    res.end(JSON.stringify(state())); return
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname
  const file = path.join(DIR, p)
  if (!file.startsWith(DIR) || !fs.existsSync(file)) { res.writeHead(404); res.end('nf'); return }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
}).listen(PORT, () => console.log(`mock on http://localhost:${PORT}`))
