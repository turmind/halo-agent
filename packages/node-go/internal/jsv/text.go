package jsv

import (
	"strings"
	"unicode/utf8"
	"unsafe"
)

// Decoder is a streaming WHATWG UTF-8 decoder (maximal-subpart U+FFFD
// replacement, BOM kept) — Node's Buffer#toString('utf-8') / TextDecoder.
type Decoder struct {
	needed, seen int
	cp           rune
	lower, upper byte
	pending      []byte
}

// Decode decodes a whole buffer.
func Decode(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var d Decoder
	return d.decode(b, true)
}

// Write decodes a chunk, keeping an unfinished trailing sequence for the next.
func (d *Decoder) Write(b []byte) string {
	if d.needed == 0 && utf8.Valid(b) {
		return string(b)
	}
	return d.decode(b, false)
}

// decode sizes the output with a counting pass, then fills one exact
// allocation: every invalid byte can become 3 (U+FFFD), so a growing buffer
// would hold up to ~2× the result while it doubles. flush ends the stream.
func (d *Decoder) decode(b []byte, flush bool) string {
	if d.lower == 0 {
		d.lower, d.upper = 0x80, 0xBF
	}
	saved := *d
	n := d.run(b, nil, flush)
	*d = saved
	out := make([]byte, n)
	d.run(b, out, flush)
	return unsafe.String(unsafe.SliceData(out), n)
}

// put writes r at out[n:] (just counts when out is nil); returns the new length.
func put(out []byte, n int, r rune) int {
	if out == nil {
		return n + utf8.RuneLen(r)
	}
	return n + utf8.EncodeRune(out[n:], r)
}

// run is the WHATWG state machine over b, writing into out (nil: count only).
func (d *Decoder) run(b, out []byte, flush bool) int {
	n := 0
	for i := 0; i < len(b); i++ {
		c := b[i]
		if d.needed == 0 {
			switch {
			case c <= 0x7F:
				if out != nil {
					out[n] = c
				}
				n++
			case c >= 0xC2 && c <= 0xDF:
				d.needed, d.cp = 1, rune(c&0x1F)
			case c >= 0xE0 && c <= 0xEF:
				if c == 0xE0 {
					d.lower = 0xA0
				} else if c == 0xED {
					d.upper = 0x9F
				}
				d.needed, d.cp = 2, rune(c&0x0F)
			case c >= 0xF0 && c <= 0xF4:
				if c == 0xF0 {
					d.lower = 0x90
				} else if c == 0xF4 {
					d.upper = 0x8F
				}
				d.needed, d.cp = 3, rune(c&0x07)
			default:
				n = put(out, n, utf8.RuneError)
			}
			continue
		}
		if c < d.lower || c > d.upper {
			d.reset()
			n = put(out, n, utf8.RuneError)
			i-- // reprocess this byte as a lead
			continue
		}
		d.lower, d.upper = 0x80, 0xBF
		d.cp = d.cp<<6 | rune(c&0x3F)
		d.seen++
		if d.seen == d.needed {
			n = put(out, n, d.cp)
			d.reset()
		}
	}
	if flush && d.needed != 0 { // = Flush
		d.reset()
		n = put(out, n, utf8.RuneError)
	}
	return n
}

// Flush ends the stream: an unfinished sequence becomes one U+FFFD.
func (d *Decoder) Flush() string {
	if d.needed != 0 {
		d.reset()
		return string(utf8.RuneError)
	}
	return ""
}

func (d *Decoder) reset() {
	d.needed, d.seen, d.cp = 0, 0, 0
	d.lower, d.upper = 0x80, 0xBF
}

// Len16 is JS `s.length` (UTF-16 code units).
func Len16(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// Truncate16 is JS `s.slice(0, n)`. A cut through a surrogate pair keeps the
// lone high surrogate, encoded as WTF-8 (ED A0..AF xx) so WriteJSONString can
// emit it as `\udXXX` exactly like JSON.stringify does.
func Truncate16(s string, n int) string {
	u := 0
	for i, r := range s {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if u+w > n {
			if u < n { // half of a pair fits
				hi := 0xD800 + ((r - 0x10000) >> 10)
				return s[:i] + string([]byte{0xED, byte(0x80 | (hi>>6)&0x3F), byte(0x80 | hi&0x3F)})
			}
			return s[:i]
		}
		u += w
	}
	return s
}

// ByteOffset16 is the byte index of UTF-16 position u in s (clamped to len).
func ByteOffset16(s string, u int) int {
	if u <= 0 {
		return 0
	}
	n := 0
	for i, r := range s {
		if n >= u {
			return i
		}
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return len(s)
}

// Units16 widens s to UTF-16 code units, one rune each.
func Units16(s string) []rune {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if r >= 0x10000 {
			r -= 0x10000
			out = append(out, 0xD800+(r>>10), 0xDC00+(r&0x3FF))
		} else {
			out = append(out, r)
		}
	}
	return out
}

// HasAstral reports a code point ≥ U+10000 in s.
func HasAstral(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0xF0 {
			return true
		}
	}
	return false
}

// Less16 is the default Array#sort order: UTF-16 code-unit comparison.
func Less16(a, b string) bool {
	for a != "" && b != "" {
		ra, na := utf8.DecodeRuneInString(a)
		rb, nb := utf8.DecodeRuneInString(b)
		if ra != rb {
			return key16(ra) < key16(rb)
		}
		a, b = a[na:], b[nb:]
	}
	return len(a) < len(b) && b != ""
}

// first code unit, then the low one for pairs sharing a high surrogate
func key16(r rune) uint32 {
	if r >= 0x10000 {
		r -= 0x10000
		return uint32(0xD800+(r>>10))<<16 | uint32(0xDC00+(r&0x3FF))
	}
	return uint32(r) << 16
}

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// Trim is String.prototype.trim (U+FEFF trimmed, U+0085 kept).
func Trim(s string) string {
	return strings.TrimFunc(s, isJSSpace)
}

func trimLeft(s string) string {
	return strings.TrimLeftFunc(s, isJSSpace)
}
