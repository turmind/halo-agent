package jsv

import (
	"math"
	"math/big"
	"strconv"
	"strings"
)

// NumberToString is Number::toString(10).
func NumberToString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case f == 0:
		return "0"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	}
	sign := ""
	if f < 0 {
		sign = "-"
		f = -f
	}
	// Shortest round-trip digits + exponent: "d.ddde±x".
	e := strconv.FormatFloat(f, 'e', -1, 64)
	mant, expPart, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	exp, _ := strconv.Atoi(expPart)
	k := len(digits)
	n := exp + 1
	var out string
	switch {
	case k <= n && n <= 21:
		out = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		out = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		out = "0." + strings.Repeat("0", -n) + digits
	default:
		es := "+"
		if n-1 < 0 {
			es = "-"
		}
		ev := strconv.Itoa(abs(n - 1))
		if k == 1 {
			out = digits + "e" + es + ev
		} else {
			out = digits[:1] + "." + digits[1:] + "e" + es + ev
		}
	}
	return sign + out
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// ToFixed is Number.prototype.toFixed(digits) on the exact binary value:
// n = the integer nearest x·10^d, ties to the larger n (so 2.25 → "2.3").
func ToFixed(x float64, d int) string {
	if math.IsNaN(x) {
		return "NaN"
	}
	if math.Abs(x) >= 1e21 || math.IsInf(x, 0) {
		return NumberToString(x)
	}
	sign := ""
	if x < 0 {
		sign = "-"
		x = -x
	}
	r := new(big.Rat).SetFloat64(x)
	r.Mul(r, new(big.Rat).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(d)), nil)))
	r.Add(r, big.NewRat(1, 2))
	n := new(big.Int).Quo(r.Num(), r.Denom()) // floor (both positive)
	s := n.String()
	if d == 0 {
		return sign + s
	}
	if len(s) <= d {
		s = strings.Repeat("0", d-len(s)+1) + s
	}
	return sign + s[:len(s)-d] + "." + s[len(s)-d:]
}
