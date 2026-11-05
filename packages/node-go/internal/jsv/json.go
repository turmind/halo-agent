package jsv

import (
	"encoding/json"
	"strings"
	"unicode/utf8"
)

const hexDigits = "0123456789abcdef"

// WriteJSONString appends JSON.stringify(s): `"` `\` and controls escaped
// (\b \f \n \r \t, else \u00xx), everything else raw — except a WTF-8 lone
// surrogate (see Truncate16), which becomes `\udxxx` like V8's well-formed
// stringify.
func WriteJSONString(sb *strings.Builder, s string) {
	sb.WriteByte('"')
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			switch c {
			case '"':
				sb.WriteString(`\"`)
			case '\\':
				sb.WriteString(`\\`)
			case '\b':
				sb.WriteString(`\b`)
			case '\f':
				sb.WriteString(`\f`)
			case '\n':
				sb.WriteString(`\n`)
			case '\r':
				sb.WriteString(`\r`)
			case '\t':
				sb.WriteString(`\t`)
			default:
				if c < 0x20 {
					sb.WriteString(`\u00`)
					sb.WriteByte(hexDigits[c>>4])
					sb.WriteByte(hexDigits[c&0xF])
				} else {
					sb.WriteByte(c)
				}
			}
			i++
			continue
		}
		r, w := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && w == 1 {
			if c == 0xED && i+2 < len(s) && s[i+1] >= 0xA0 && s[i+1] <= 0xBF {
				u := rune(c&0x0F)<<12 | rune(s[i+1]&0x3F)<<6 | rune(s[i+2]&0x3F)
				sb.WriteString(`\u`)
				for sh := 12; sh >= 0; sh -= 4 {
					sb.WriteByte(hexDigits[(u>>sh)&0xF])
				}
				i += 3
				continue
			}
			sb.WriteString("\uFFFD")
			i++
			continue
		}
		sb.WriteString(s[i : i+w])
		i += w
	}
	sb.WriteByte('"')
}

// Stringify is JSON.stringify for a decoded JSON arg (logs only).
func Stringify(v any) string {
	switch x := v.(type) {
	case Undef:
		return "undefined"
	case string:
		var sb strings.Builder
		WriteJSONString(&sb, x)
		return sb.String()
	case float64:
		return NumberToString(x)
	}
	var sb strings.Builder
	enc := json.NewEncoder(&sb)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return strings.TrimSuffix(sb.String(), "\n")
}
