// Differential fuzz oracle for internal/jsregex (§3.5): random no-flag JS
// patterns from a grammar, evaluated by this Node's own RegExp. One JSONL line
// per pattern — {src, err} or {src, in, out} (out: '0'/'1' per input) — read
// by `go test ./internal/jsregex -run Differential` via JSREGEX_VECTORS.
//   node packages/node-go/conformance/regex-fuzz.mjs --n 20000 --seed 42 > /tmp/re.jsonl
//   node packages/node-go/conformance/regex-fuzz.mjs --eval cases.jsonl   # {src, in?} lines → full vectors (regress entries)
import fs from 'node:fs'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }

// Fixed corpus: ASCII, NBSP, U+2028, CR, astral, accented, empty, controls.
const CORPUS = ['', 'a', 'abc', 'xyz', 'Abc_1', 'foo\r', 'x\u00a0y', 'ab\u2028cd', '\u{1F600}', 'a\u{1F600}b', 'é', 'aé', 'tab\there', '{1}', 'a-b]', '\\c*', '\x1b\x07\b\x00', '$x_1']

function evaluate(src, inputs) {
  let re
  try { re = new RegExp(src) } catch (e) { return { src, err: e.message } }
  // V8 compiles lazily: engine limits (backtrack stack, "Regular expression too large")
  // surface from test(), not new RegExp. Recorded as `rt` — Go only checks it compiles.
  try { return { src, in: inputs, out: inputs.map((s) => (re.test(s) ? '1' : '0')).join('') } } catch (e) { return { src, rt: `${e.name}: ${e.message}` } }
}

if (opt('--eval')) {
  for (const line of fs.readFileSync(opt('--eval'), 'utf8').split('\n')) {
    if (!line.trim()) continue
    const c = JSON.parse(line)
    process.stdout.write(JSON.stringify(evaluate(c.src, c.in ?? CORPUS)) + '\n')
  }
  process.exit(0)
}

const N = Number(opt('--n', 20000))
const SEED = Number(opt('--seed', Date.now() % 2 ** 31))
process.stderr.write(`[regex-fuzz] n=${N} seed=${SEED} node=${process.version}\n`)

// mulberry32
let s = SEED >>> 0
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32 }
const int = (n) => Math.floor(rnd() * n)
const pick = (a) => a[int(a.length)]
const chance = (p) => rnd() < p

const LIT = [...'abcxyzAZ019_-é ,/:<>=!&@#%~`\'"', '\u00a0', '\u2028', '\r', '\t', '\u{1F600}', '\u{1F601}', '{', '}', ']']
const HEX = '0123456789abcdefABCDEFgz'
const NAMES = ['a', 'b', 'n', '$x', '_1', 'é', 'a1', '1a', '\\u0061', '\\u{62}', '\\x61', 'a-b', '', '\u{1D49C}']
const PREFIX = ['', '', '', '', '?:', '?:', '?=', '?!', '?<=', '?<!', '?<n>', '?<a>', '?', '?i', '?i:', '?-i:', '?#', '?<', '?m)', '?P<a>', '?>']
const hexs = (n) => Array.from({ length: n }, () => pick(HEX)).join('')
const num = () => (chance(0.05) ? pick(['99999999999', '2147483647', '2147483648', '65536']) : String(int(4)))

function escape(inClass) {
  const r = rnd()
  if (r < 0.3) return '\\' + pick([...'dDwWsSbBfnrtv0'])
  if (r < 0.45) return '\\' + pick([...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'])
  if (r < 0.55) return '\\' + pick([...'123456789']) + (chance(0.3) ? pick([...'0123456789']) : '')
  if (r < 0.65) return '\\' + pick([...'.\\/-[]{}()*+?$^|'])
  if (r < 0.72) return '\\x' + hexs(int(3))
  if (r < 0.8) return '\\u' + (chance(0.15) ? '{' + hexs(int(3)) + (chance(0.7) ? '}' : '') : hexs(int(5)))
  if (r < 0.87) return '\\c' + pick([...'aZ09_*[-'])
  if (r < 0.93) return inClass ? '\\' + pick([...'pPk']) : '\\k' + (chance(0.8) ? '<' + pick(NAMES) + (chance(0.85) ? '>' : '') : '')
  return '\\' + pick([...'pP']) + (chance(0.7) ? '{L}' : '{L')
}

function classAtom() {
  const r = rnd()
  if (r < 0.55) return pick(LIT)
  if (r < 0.85) return escape(true)
  return pick(['-', '^', '[', '\\]', '\\-'])
}

function cls() {
  let out = '[' + (chance(0.25) ? '^' : '')
  for (let i = int(4); i > 0; i--) out += chance(0.25) ? classAtom() + '-' + classAtom() : classAtom()
  return out + (chance(0.93) ? ']' : '')
}

function quant() {
  const r = rnd()
  let q
  if (r < 0.5) q = pick(['*', '+', '?'])
  else if (r < 0.8) q = pick([`{${num()}}`, `{${num()},}`, `{${num()},${num()}}`])
  else q = pick([`{,${num()}}`, `{${num()},`, '{', `{${num()}`, '{a}', `{${num()},${num()}`])
  return q + (chance(0.2) ? '?' : '')
}

function atom(depth) {
  const r = rnd()
  if (r < 0.32) return pick(LIT)
  if (r < 0.38) return pick(['.', '^', '$'])
  if (r < 0.58) return escape(false)
  if (r < 0.72) return cls()
  if (r < 0.92 && depth < 3) {
    let p = pick(PREFIX)
    if (p === '?<n>' || p === '?<a>') p = chance(0.6) ? p : '?<' + pick(NAMES) + (chance(0.9) ? '>' : '')
    return '(' + p + disjunction(depth + 1) + (chance(0.93) ? ')' : '')
  }
  return pick([')', '*', '+', '?', '{2}', '|', '(', '[', '\\'])
}

function term(depth) {
  const a = atom(depth)
  return chance(0.3) ? a + quant() : a
}

function disjunction(depth) {
  let out = ''
  for (let alt = chance(0.2) ? 1 + int(2) : 0; alt >= 0; alt--) {
    for (let i = int(depth ? 3 : 5); i >= 0; i--) out += term(depth)
    if (alt) out += '|'
  }
  return out
}

// Inputs: the fixed corpus + strings sampled from the pattern's own code points
// (whole code points, so no lone surrogates reach the JSON).
function inputs(src) {
  const pool = [...new Set([...src, ...'abcAé\n\r\u2028\u{1F600}'])]
  const extra = Array.from({ length: 8 }, () => Array.from({ length: int(7) }, () => pick(pool)).join(''))
  return [...CORPUS, ...extra]
}

for (let i = 0; i < N; i++) {
  const src = disjunction(0)
  process.stdout.write(JSON.stringify(evaluate(src, inputs(src))) + '\n')
}
