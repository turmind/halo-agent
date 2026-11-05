// Regenerates internal/jsv/testdata/js-truth.json from the running Node:
// Number::toString, toFixed(1), WHATWG UTF-8 decode, trim, ToNumber(string),
// parseInt(s, 10) and the default (UTF-16) sort order.
//   node packages/node-go/conformance/gen-jsv-truth.mjs
import fs from 'node:fs'
import path from 'node:path'

let seed = 42
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)

const nums = [0, -0, 1, -1, 1.5, 0.1, 0.000001, 0.0000001, 1e21, 1e20, 123456789, 1.7976931348623157e308, 5e-324, 2 ** 53, 2.25, 0.05, 1.25, 0.35, -0.04, 3.0000004, 9.95, 99.95]
for (let i = 0; i < 300; i++) nums.push(rnd() * 10 ** Math.floor(rnd() * 30 - 10) * (rnd() < 0.2 ? -1 : 1))
for (let i = 0; i < 200; i++) nums.push(Math.round(rnd() * 60000) / 1000) // backoff-like delays in s
const numbers = nums.map((n) => [n, String(n), n.toFixed(1)])

const decode = [[0xff], [0xe2, 0x82], [0xf0, 0x9f, 0x98], [0xed, 0xa0, 0x80], [0xef, 0xbb, 0xbf, 0x68], [0xc0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe0, 0x80, 0x80], [0xf8, 0x88, 0x80, 0x80, 0x80], [0x61, 0xff, 0x62, 0xe2, 0x82, 0x0a, 0xf0, 0x9f, 0x98, 0x0a]]
for (let i = 0; i < 300; i++) {
  const n = 1 + Math.floor(rnd() * 12)
  const b = []
  for (let j = 0; j < n; j++) b.push(rnd() < 0.5 ? 0x80 + Math.floor(rnd() * 0x80) : Math.floor(rnd() * 256))
  decode.push(b)
}
// Escape non-ASCII as \u so lone surrogates never appear (outputs are well-formed anyway).
const decoded = decode.map((b) => [Buffer.from(b).toString('hex'), Buffer.from(b).toString('utf-8')])

const trims = ['  a  ', '\u00a0a\ufeff', '\u0085a\u0085', '\u2028a\u3000', '\u180ea', '\t\n\v\f\r a', '\u200ba\u200a']
  .map((s) => [s, s.trim()])
const toNumber = ['2', ' 2 ', '', 'abc', '0x10', '0b11', '0o7', '1e3', '.5', '5.', '+5', '-5', 'Infinity', '-Infinity', '1_000', '0x', '1e', '\u00a012\u00a0', '00012', '-0x10']
  .map((s) => [s, String(Number(s))])
const parseInts = ['1500', '1500ms', '1e3', '0x10', ' 15', '-5', '\u00a015', '', 'abc', '+7', '-0', '99999999999']
  .map((s) => [s, Number.isNaN(parseInt(s, 10)) ? null : parseInt(s, 10)])
const sortIn = ['😀.ts', '～.ts', 'Zeta.ts', '_under.ts', 'é.ts', '.halo/docs/k.ts', 'sub/b.ts', '\u{1F601}', '\u{10000}', '\uffff', 'a', 'ab', '']
const sorted = [...sortIn].sort()

const out = path.join(path.dirname(new URL(import.meta.url).pathname), '../internal/jsv/testdata/js-truth.json')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify({ node: process.version, numbers, decoded, trims, toNumber, parseInts, sortIn, sorted }) + '\n')
console.log(`wrote ${numbers.length} numbers, ${decoded.length} decode vectors → ${out}`)
