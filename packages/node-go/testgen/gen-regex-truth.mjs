// Regenerates internal/jsregex/testdata/js-truth.json from the running Node's
// RegExp (the oracle): R1–R7 match tables (§2.9) + V8 syntax-error text.
//   node packages/node-go/conformance/gen-regex-truth.mjs
import fs from 'node:fs'
import path from 'node:path'

const match = [
  // R1 `.`
  ['foo.', ['foo\r', 'foox', 'foo\n']], ['ab.cd', ['ab\u2028cd', 'abxcd', 'ab\u2029cd']], ['[.]', ['.', 'x']],
  // R2 code units
  ['^.$', ['\u{1F600}', 'x']], ['^..$', ['\u{1F600}', 'xy']], ['\u{1F600}', ['a\u{1F600}b']],
  ['[\u{1F600}]', ['x']], ['\\uD83D', ['\u{1F600}']], ['^[^x]$', ['\u{1F600}']],
  // R3 identity escapes
  ['\\e', ['e', '\x1b']], ['\\a', ['a', '\x07']], ['\\A', ['A']], ['\\Z', ['Z']], ['\\z', ['z']], ['\\G', ['G']],
  ['\\p{L}', ['p{L}', 'a']], ['\\P{L}', ['P{L}']], ['\\p{L', ['p{L']],
  // R5 ASCII \b
  ['a\\b', ['a\u00e9', 'ab', 'a']], ['\\Bé', ['xé', 'é']], ['é\\b', ['é']],
  // R6
  ['[a-\\d]', ['-', '5', 'b', 'a']], ['x{99999999999}', ['x']], ['[\\d-z]', ['-', 'z', 'y']],
  // R7 (already equal) + `$`
  ['x\\sy', ['x\u00a0y', 'x\u2028y', 'x\ufeffy', 'x\u3000y', 'x\u0085y', 'x\u180ey']], ['\\w\\d\\W', ['a1!', 'é1!']],
  ['\\1(a)', ['a']], ['(a\\1)', ['a']], ['(a)?\\1b', ['b']], ['\\101', ['A']], ['a\\0', ['a\0']], ['\\8', ['8']],
  ['[\\1]', ['\x01', '1']], ['\\x41', ['A']], ['\\u0041', ['A']], ['\\cI', ['\t']], ['a[^]', ['a\n']], ['[]', ['a', '']],
  ['(?<=A)bc', ['Abc', 'bc']], ['(?<n>b)c', ['bc']], ['(?<a>x)\\k<a>', ['xx', 'x']], ['a{,5}', ['a{,5}', 'aaaaa']],
  ['a{1,', ['a{1,']], [']', [']']], ['}', ['}']], ['b{', ['b{']], ['(?=a)*b', ['b']],
  ['foo$', ['foo\r', 'foo', 'foo\n']], ['^$', ['']], ['\\k', ['k']], ['\\c', ['\\c']], ['\\c*', ['\\c*']],
  ['[\\c*]', ['\\', 'c', '*']], ['(a)\\2', ['a\x02']], ['\\012', ['\n']], ['\\u{3}', ['uuu', 'u{3}']], ['[\\b]', ['\b']],
  ['[a-z-[aeiou]]', ['b]', 'a]', '-]', '[]', 'b']], ['\\k<a>', ['k<a>']], ['[\\w-z]', ['-', 'z']], ['[\\s\\S]', ['x']],
].map(([p, ss]) => { const re = new RegExp(p); return { p, cases: ss.map((s) => [s, re.test(s)]) } })

const errors = [
  '(', '((a)', '(?:', '(?=', '(?!', '(?<=', '(?<!', 'a/(', 'a)', '*a', '+', '?', '{1}', 'a**', 'a{1}{2}', '^*', '$*',
  '\\b*', 'a|*', 'a{2,1}', '[a', '[z-a]', '[\u{1F600}-\u{1F602}]', 'a\\', '(?', '(?x)', '(?i)abc', '(?i:a)', '(?-i:a)',
  '(?m)a', '(?#c)a', '(?<a', '(?<1a>x)', '(?<a>.)\\k<a', '(?<a>x)(?<a>y)', '\\k<b>(?<a>x)', '(?<a>x)\\k<b>',
  '(?<a>x)\\k', '(?<=a)*', '[a-\\d]', '(?=a)*', 'x{99999999999}', '\\c', '\\u{', '\\p{L', '[]', '[^]', 'a{,5}', 'a{1,',
].map((p) => { try { new RegExp(p); return [p, null] } catch (e) { return [p, e.message] } })

const out = path.join(path.dirname(new URL(import.meta.url).pathname), '../internal/jsregex/testdata/js-truth.json')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify({ node: process.version, match, errors }, null, 1) + '\n')
console.log(`wrote ${match.length} match patterns, ${errors.length} error probes → ${out}`)
