// Package jsregex compiles a JavaScript `new RegExp(src)` (no flags: non-u
// mode + Annex B) into an equivalent regexp2 pattern, with V8's syntax-error
// text, and matches over UTF-16 code units like `RegExp#test`.
//
// The front end parses the pattern itself (code units, ES Annex B grammar) and
// emits only constructs whose regexp2 semantics equal JS's:
//   - R1 `.` → [^\n\r\u2028\u2029]; `$` → (?![\s\S]) (.NET `$` also matches before a final \n)
//   - R2 every literal is emitted per code unit (\uXXXX), lines with astral chars are fed as code units
//   - R3 unknown escapes are identity escapes (literal)
//   - R4 `(?i)` / `(?#` / … are rejected ("Invalid group")
//   - R5 `\b` / `\B` use an ASCII word class (regexp2 treats é as a word char)
//   - R6 `[a-\d]` → a, -, \d; oversized {n,m} saturate at 2^31-1 (= V8 kInfinity)
//
// Named groups are emitted as plain numbered groups (regexp2 names can't hold
// `$` / Unicode) and `\k<name>` as the numbered backreference.
package jsregex

import (
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/dlclark/regexp2"
	"github.com/turmind/halo-agent/packages/node-go/internal/jsv"
)

// MatchTimeout bounds catastrophic backtracking (= the hub's non-run call timeout).
const MatchTimeout = 120 * time.Second

const maxCount = 1<<31 - 1

// SyntaxError carries V8's message.
type SyntaxError struct{ Src, Msg string }

func (e *SyntaxError) Error() string {
	return "Invalid regular expression: /" + e.Src + "/: " + e.Msg
}

// Regexp is a compiled JS regex.
type Regexp struct{ re *regexp2.Regexp }

// Compile is `new RegExp(src)`.
func Compile(src string) (*Regexp, error) {
	out, err := Translate(src)
	if err != nil {
		return nil, err
	}
	re, cerr := regexp2.Compile(out, regexp2.ECMAScript)
	if cerr != nil {
		// JS accepted it but our translation didn't compile: a jsregex bug.
		return nil, &SyntaxError{src, "jsregex: " + cerr.Error()}
	}
	re.MatchTimeout = MatchTimeout
	return &Regexp{re}, nil
}

// Test is RegExp#test on s.
func (r *Regexp) Test(s string) bool {
	var ok bool
	if jsv.HasAstral(s) {
		ok, _ = r.re.MatchRunes(jsv.Units16(s))
	} else {
		ok, _ = r.re.MatchString(s)
	}
	return ok
}

type kind int

const (
	kAtom kind = iota
	kAssert
	kLookahead
	kLookbehind
)

type parser struct {
	src      string
	u        []rune // UTF-16 code units
	i        int
	nCaps    int
	capSeen  int
	hasNamed bool
	names    map[string]int
	refs     []string
}

type synErr struct{ msg string }

func (p *parser) fail(msg string) { panic(synErr{msg}) }

const (
	wordClass  = `[A-Za-z0-9_]`
	boundary   = `(?:(?<=` + wordClass + `)(?!` + wordClass + `)|(?<!` + wordClass + `)(?=` + wordClass + `))`
	nonBound   = `(?:(?<=` + wordClass + `)(?=` + wordClass + `)|(?<!` + wordClass + `)(?!` + wordClass + `))`
	jsDot      = `[^\n\r\u2028\u2029]`
	jsEnd      = `(?![\s\S])`
	refMarkL   = "\x00K"
	refMarkR   = "\x00"
	emptyClass = `[^\s\S]`
	anyClass   = `[\s\S]`
)

// Translate returns the regexp2 pattern for JS src, or a *SyntaxError.
func Translate(src string) (out string, err error) {
	p := &parser{src: src, u: jsv.Units16(src), names: map[string]int{}}
	p.prescan()
	defer func() {
		if r := recover(); r != nil {
			se, ok := r.(synErr)
			if !ok {
				panic(r)
			}
			out, err = "", &SyntaxError{src, se.msg}
		}
	}()
	out = p.disjunction()
	if p.i < len(p.u) { // only a ')' stops the top level early
		p.fail("Unmatched ')'")
	}
	for _, name := range p.refs {
		if _, ok := p.names[name]; !ok {
			p.fail("Invalid named capture referenced")
		}
	}
	for idx, name := range p.refs {
		out = strings.Replace(out, refMarkL+strconv.Itoa(idx)+refMarkR, `(?:\`+strconv.Itoa(p.names[name])+`)`, 1)
	}
	return out, nil
}

// prescan: total capture count (for \N backreference vs octal) and whether any
// named group exists (makes `\k` strict).
func (p *parser) prescan() {
	u := p.u
	for i := 0; i < len(u); i++ {
		switch u[i] {
		case '\\':
			i++
		case '[':
			for i++; i < len(u) && u[i] != ']'; i++ {
				if u[i] == '\\' {
					i++
				}
			}
		case '(':
			if i+1 < len(u) && u[i+1] == '?' {
				if i+2 < len(u) && u[i+2] == '<' && (i+3 >= len(u) || (u[i+3] != '=' && u[i+3] != '!')) {
					p.nCaps++
					p.hasNamed = true
				}
			} else {
				p.nCaps++
			}
		}
	}
}

func (p *parser) peek(off int) rune {
	if p.i+off < len(p.u) {
		return p.u[p.i+off]
	}
	return -1
}

func (p *parser) disjunction() string {
	var b strings.Builder
	b.WriteString(p.alternative())
	for p.peek(0) == '|' {
		p.i++
		b.WriteByte('|')
		b.WriteString(p.alternative())
	}
	return b.String()
}

func (p *parser) alternative() string {
	var b strings.Builder
	for p.i < len(p.u) {
		if c := p.u[p.i]; c == '|' || c == ')' {
			break
		}
		b.WriteString(p.term())
	}
	return b.String()
}

func (p *parser) term() string {
	atom, k := p.atom()
	q, ok := p.quantifier()
	if !ok {
		return atom
	}
	switch k {
	case kAssert:
		p.fail("Nothing to repeat")
	case kLookbehind:
		p.fail("Invalid quantifier")
	case kLookahead: // Annex B QuantifiableAssertion
		atom = "(?:" + atom + ")"
	}
	return atom + q
}

// braces parses `{n}` / `{n,}` / `{n,m}` at p.i (no consume). max -1 = ∞.
func (p *parser) braces() (min, max, end int, ok bool) {
	u, i := p.u, p.i+1
	num := func() (int, bool) {
		start := i
		v := 0
		for i < len(u) && u[i] >= '0' && u[i] <= '9' {
			if v < maxCount {
				v = v*10 + int(u[i]-'0')
				if v > maxCount {
					v = maxCount
				}
			}
			i++
		}
		return v, i > start
	}
	min, ok = num()
	if !ok {
		return
	}
	if i < len(u) && u[i] == '}' {
		return min, min, i + 1, true
	}
	if i >= len(u) || u[i] != ',' {
		return 0, 0, 0, false
	}
	i++
	max, has := num()
	if !has {
		max = -1
	} else if max == maxCount {
		max = -1 // V8 kInfinity
	}
	if i < len(u) && u[i] == '}' {
		return min, max, i + 1, true
	}
	return 0, 0, 0, false
}

func (p *parser) quantifier() (string, bool) {
	var q string
	switch p.peek(0) {
	case '*', '+', '?':
		q = string(p.u[p.i])
		p.i++
	case '{':
		min, max, end, ok := p.braces()
		if !ok {
			return "", false
		}
		if max != -1 && min > max {
			p.fail("numbers out of order in {} quantifier")
		}
		p.i = end
		switch {
		case max == -1:
			q = fmt.Sprintf("{%d,}", min)
		case min == max:
			q = fmt.Sprintf("{%d}", min)
		default:
			q = fmt.Sprintf("{%d,%d}", min, max)
		}
	default:
		return "", false
	}
	if p.peek(0) == '?' {
		p.i++
		q += "?"
	}
	return q, true
}

func lit(c rune) string {
	if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' {
		return string(c)
	}
	return fmt.Sprintf(`\u%04X`, c)
}

func (p *parser) atom() (string, kind) {
	c := p.u[p.i]
	switch c {
	case '^':
		p.i++
		return "^", kAssert
	case '$':
		p.i++
		return jsEnd, kAssert
	case '.':
		p.i++
		return jsDot, kAtom
	case '(':
		return p.group()
	case '[':
		return p.class(), kAtom
	case '*', '+', '?':
		p.fail("Nothing to repeat")
	case '{':
		if _, _, _, ok := p.braces(); ok {
			p.fail("Nothing to repeat")
		}
	case '\\':
		return p.atomEscape()
	}
	p.i++
	return lit(c), kAtom
}

func (p *parser) group() (string, kind) {
	p.i++ // (
	prefix, k, name := "(", kAtom, ""
	if p.peek(0) == '?' {
		switch p.peek(1) {
		case ':':
			prefix = "(?:"
			p.i += 2
		case '=', '!':
			prefix, k = "(?"+string(p.u[p.i+1]), kLookahead
			p.i += 2
		case '<':
			switch p.peek(2) {
			case '=', '!':
				prefix, k = "(?<"+string(p.u[p.i+2]), kLookbehind
				p.i += 3
			default:
				p.i += 2
				name = p.groupName()
				p.capSeen++
				if _, dup := p.names[name]; !dup {
					p.names[name] = p.capSeen
				} else {
					name = "\x00dup" // reported at the close paren, like V8
				}
			}
		default:
			p.fail("Invalid group")
		}
	} else {
		p.capSeen++
	}
	body := p.disjunction()
	if p.i >= len(p.u) {
		p.fail("Unterminated group")
	}
	p.i++ // )
	if name == "\x00dup" {
		p.fail("Duplicate capture group name")
	}
	return prefix + body + ")", k
}

func isHex(c rune) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

func (p *parser) hexN(off, n int) (rune, bool) {
	var v rune
	for k := 0; k < n; k++ {
		c := p.peek(off + k)
		if !isHex(c) {
			return 0, false
		}
		d, _ := strconv.ParseUint(string(c), 16, 8)
		v = v*16 + rune(d)
	}
	return v, true
}

// groupName parses RegExpIdentifierName up to '>' (p.i just past '<').
func (p *parser) groupName() string {
	var cps []rune
	for {
		c := p.peek(0)
		if c == -1 {
			p.fail("Invalid capture group name")
		}
		if c == '>' {
			p.i++
			break
		}
		var cp rune
		if c == '\\' {
			if p.peek(1) != 'u' {
				p.fail("Invalid capture group name")
			}
			if p.peek(2) == '{' {
				j := 3
				var v rune
				for isHex(p.peek(j)) {
					d, _ := strconv.ParseUint(string(p.peek(j)), 16, 8)
					v = v*16 + rune(d)
					if v > 0x10FFFF {
						p.fail("Invalid capture group name")
					}
					j++
				}
				if j == 3 || p.peek(j) != '}' {
					p.fail("Invalid capture group name")
				}
				cp = v
				p.i += j + 1
			} else {
				v, ok := p.hexN(2, 4)
				if !ok {
					p.fail("Invalid capture group name")
				}
				p.i += 6
				cp = v
				if v >= 0xD800 && v <= 0xDBFF && p.peek(0) == '\\' && p.peek(1) == 'u' {
					if lo, ok := p.hexN(2, 4); ok && lo >= 0xDC00 && lo <= 0xDFFF {
						cp = 0x10000 + (v-0xD800)<<10 + (lo - 0xDC00)
						p.i += 6
					}
				}
			}
		} else {
			cp = c
			p.i++
			if c >= 0xD800 && c <= 0xDBFF {
				if lo := p.peek(0); lo >= 0xDC00 && lo <= 0xDFFF {
					cp = 0x10000 + (c-0xD800)<<10 + (lo - 0xDC00)
					p.i++
				}
			}
		}
		if len(cps) == 0 && !idStart(cp) || len(cps) > 0 && !idContinue(cp) {
			p.fail("Invalid capture group name")
		}
		cps = append(cps, cp)
	}
	if len(cps) == 0 {
		p.fail("Invalid capture group name")
	}
	return string(cps)
}

func idStart(c rune) bool {
	return c == '$' || c == '_' || unicode.IsLetter(c) || unicode.Is(unicode.Nl, c) || unicode.Is(unicode.Other_ID_Start, c)
}

func idContinue(c rune) bool {
	return idStart(c) || c == 0x200C || c == 0x200D || unicode.In(c, unicode.Mn, unicode.Mc, unicode.Nd, unicode.Pc, unicode.Other_ID_Continue)
}

func isLetter(c rune) bool { return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }

func isOctal(c rune) bool { return c >= '0' && c <= '7' }

// octal: Annex B LegacyOctalEscapeSequence the V8 way (≤ 3 digits, < 256).
func (p *parser) octal() rune {
	v := p.u[p.i] - '0'
	p.i++
	if isOctal(p.peek(0)) {
		v = v*8 + p.u[p.i] - '0'
		p.i++
		if v < 32 && isOctal(p.peek(0)) {
			v = v*8 + p.u[p.i] - '0'
			p.i++
		}
	}
	return v
}

// controlEscape: \f \n \r \t \v → unit, ok.
func controlEscape(c rune) (rune, bool) {
	switch c {
	case 'f':
		return '\f', true
	case 'n':
		return '\n', true
	case 'r':
		return '\r', true
	case 't':
		return '\t', true
	case 'v':
		return '\v', true
	}
	return 0, false
}

// hexEscape: \xHH / \uHHHH at p.i (the letter); identity letter when malformed.
func (p *parser) hexEscape(c rune) rune {
	n := 2
	if c == 'u' {
		n = 4
	}
	if v, ok := p.hexN(1, n); ok {
		p.i += 1 + n
		return v
	}
	p.i++
	return c
}

func (p *parser) atomEscape() (string, kind) {
	p.i++ // backslash
	c := p.peek(0)
	if c == -1 {
		p.fail(`\ at end of pattern`)
	}
	switch c {
	case 'b':
		p.i++
		return boundary, kAssert
	case 'B':
		p.i++
		return nonBound, kAssert
	case 'd', 'D', 'w', 'W', 's', 'S':
		p.i++
		return `\` + string(c), kAtom
	case 'c':
		if l := p.peek(1); isLetter(l) {
			p.i += 2
			return lit(l & 31), kAtom
		}
		return lit('\\'), kAtom // `\` literal; the `c` is the next atom
	case 'x', 'u':
		return lit(p.hexEscape(c)), kAtom
	case 'k':
		if !p.hasNamed {
			p.i++
			return "k", kAtom
		}
		if p.peek(1) != '<' {
			p.fail("Invalid named reference")
		}
		p.i += 2
		name := p.groupName()
		p.refs = append(p.refs, name)
		return refMarkL + strconv.Itoa(len(p.refs)-1) + refMarkR, kAtom
	case '0':
		if d := p.peek(1); d < '0' || d > '9' {
			p.i++
			return lit(0), kAtom
		}
		return lit(p.octal()), kAtom
	}
	if c >= '1' && c <= '9' {
		j, n := p.i, 0
		for j < len(p.u) && p.u[j] >= '0' && p.u[j] <= '9' {
			if n <= p.nCaps {
				n = n*10 + int(p.u[j]-'0')
			}
			j++
		}
		if n <= p.nCaps {
			p.i = j
			return `(?:\` + strconv.Itoa(n) + `)`, kAtom
		}
		if c >= '8' {
			p.i++
			return lit(c), kAtom
		}
		return lit(p.octal()), kAtom
	}
	if v, ok := controlEscape(c); ok {
		p.i++
		return lit(v), kAtom
	}
	p.i++ // identity escape (R3)
	return lit(c), kAtom
}

type classAtom struct {
	s     string
	unit  rune
	isEsc bool // \d \w \s …
}

func (p *parser) classAtom() classAtom {
	c := p.u[p.i]
	if c != '\\' {
		p.i++
		return classAtom{s: lit(c), unit: c}
	}
	p.i++
	c = p.peek(0)
	if c == -1 {
		p.fail(`\ at end of pattern`)
	}
	unit := func(v rune) classAtom { return classAtom{s: lit(v), unit: v} }
	switch c {
	case 'd', 'D', 'w', 'W', 's', 'S':
		p.i++
		return classAtom{s: `\` + string(c), isEsc: true}
	case 'b':
		p.i++
		return unit('\b')
	case 'c':
		if l := p.peek(1); isLetter(l) || l >= '0' && l <= '9' || l == '_' {
			p.i += 2
			return unit(l & 31)
		}
		return unit('\\') // `\` literal; the `c` is the next class atom
	case 'x', 'u':
		return unit(p.hexEscape(c))
	}
	if isOctal(c) {
		return unit(p.octal())
	}
	if v, ok := controlEscape(c); ok {
		p.i++
		return unit(v)
	}
	p.i++
	return unit(c)
}

func (p *parser) class() string {
	p.i++ // [
	negate := false
	if p.peek(0) == '^' {
		negate = true
		p.i++
	}
	if p.peek(0) == ']' {
		p.i++
		if negate {
			return anyClass
		}
		return emptyClass
	}
	var b strings.Builder
	b.WriteByte('[')
	if negate {
		b.WriteByte('^')
	}
	for {
		if p.i >= len(p.u) {
			p.fail("Unterminated character class")
		}
		if p.u[p.i] == ']' {
			p.i++
			break
		}
		a := p.classAtom()
		if p.peek(0) == '-' && p.peek(1) != -1 && p.peek(1) != ']' {
			p.i++
			z := p.classAtom()
			if a.isEsc || z.isEsc { // Annex B: `-` is literal next to a class escape (R6)
				b.WriteString(a.s + lit('-') + z.s)
				continue
			}
			if a.unit > z.unit {
				p.fail("Range out of order in character class")
			}
			b.WriteString(a.s + "-" + z.s)
			continue
		}
		b.WriteString(a.s)
	}
	b.WriteByte(']')
	return b.String()
}
