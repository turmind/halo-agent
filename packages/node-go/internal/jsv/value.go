// Package jsv reproduces the bits of JavaScript value / string semantics the
// server's own file tools lean on (ToString / ToNumber / truthiness on JSON args,
// WHATWG UTF-8 decoding, UTF-16 lengths, String.prototype.trim, toFixed, Node
// fs error text), so the Go node answers byte-for-byte like the server's tools.
package jsv

import (
	"math"
	"strconv"
	"strings"
)

// Undef is JS `undefined` — an absent key in the request args.
type Undef struct{}

// Undefined is the one Undef value.
var Undefined = Undef{}

// Get returns args[k], or Undefined when the key is absent.
func Get(args map[string]any, k string) any {
	if v, ok := args[k]; ok {
		return v
	}
	return Undefined
}

// IsNullish is `v == null` (null or undefined).
func IsNullish(v any) bool {
	if v == nil {
		return true
	}
	_, u := v.(Undef)
	return u
}

// ToString is ECMAScript ToString over JSON values (+ undefined).
func ToString(v any) string {
	switch x := v.(type) {
	case Undef:
		return "undefined"
	case nil:
		return "null"
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return NumberToString(x)
	case string:
		return x
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if !IsNullish(e) {
				parts[i] = ToString(e)
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

// ToNumber is ECMAScript ToNumber over JSON values (+ undefined).
func ToNumber(v any) float64 {
	switch x := v.(type) {
	case Undef:
		return math.NaN()
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case string:
		return StringToNumber(x)
	case []any:
		return StringToNumber(ToString(x))
	default:
		return math.NaN()
	}
}

// Truthy is ToBoolean.
func Truthy(v any) bool {
	switch x := v.(type) {
	case Undef, nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	default:
		return true
	}
}

// StrictEqual is `===` on JSON values: objects / arrays are distinct references.
func StrictEqual(a, b any) bool {
	switch x := a.(type) {
	case Undef:
		_, ok := b.(Undef)
		return ok
	case nil:
		return b == nil
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case float64:
		y, ok := b.(float64)
		return ok && x == y
	case string:
		y, ok := b.(string)
		return ok && x == y
	default:
		return false
	}
}

// StringToNumber is StringNumericLiteral → Number (decimal, 0x / 0o / 0b,
// ±Infinity; whitespace-trimmed; empty → 0; anything else NaN).
func StringToNumber(s string) float64 {
	s = Trim(s)
	if s == "" {
		return 0
	}
	if len(s) > 2 && s[0] == '0' {
		base := 0
		switch s[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			var f float64
			for _, c := range s[2:] {
				d := digitVal(c)
				if d < 0 || d >= base {
					return math.NaN()
				}
				f = f*float64(base) + float64(d)
			}
			return f
		}
	}
	body := s
	if body[0] == '+' || body[0] == '-' {
		body = body[1:]
	}
	if body == "Infinity" {
		if s[0] == '-' {
			return math.Inf(-1)
		}
		return math.Inf(1)
	}
	if !isDecimalLiteral(body) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		if ne, ok := err.(*strconv.NumError); ok && ne.Err == strconv.ErrRange {
			return f
		}
		return math.NaN()
	}
	return f
}

func digitVal(c rune) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'z':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'Z':
		return int(c-'A') + 10
	}
	return -1
}

// digits [. digits] [e[±]digits] | . digits [e…]
func isDecimalLiteral(s string) bool {
	i, n := 0, len(s)
	intDigits := 0
	for i < n && s[i] >= '0' && s[i] <= '9' {
		i++
		intDigits++
	}
	fracDigits := 0
	if i < n && s[i] == '.' {
		i++
		for i < n && s[i] >= '0' && s[i] <= '9' {
			i++
			fracDigits++
		}
	}
	if intDigits == 0 && fracDigits == 0 {
		return false
	}
	if i < n && (s[i] == 'e' || s[i] == 'E') {
		i++
		if i < n && (s[i] == '+' || s[i] == '-') {
			i++
		}
		expDigits := 0
		for i < n && s[i] >= '0' && s[i] <= '9' {
			i++
			expDigits++
		}
		if expDigits == 0 {
			return false
		}
	}
	return i == n
}

// ParseInt is parseInt(s, 10): leading whitespace, sign, leading digits.
// ok=false is NaN.
func ParseInt(s string) (int64, bool) {
	s = trimLeft(s)
	neg := false
	if s != "" && (s[0] == '+' || s[0] == '-') {
		neg = s[0] == '-'
		s = s[1:]
	}
	var n int64
	digits := 0
	for digits < len(s) && s[digits] >= '0' && s[digits] <= '9' {
		if n < math.MaxInt64/10 {
			n = n*10 + int64(s[digits]-'0')
		}
		digits++
	}
	if digits == 0 {
		return 0, false
	}
	if neg {
		n = -n
	}
	return n, true
}
