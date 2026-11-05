package jsv

import (
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"slices"
	"strings"
	"testing"
)

// testdata/js-truth.json: conformance/gen-jsv-truth.mjs (Node is the oracle).
type truth struct {
	Numbers   [][3]any    `json:"numbers"`
	Decoded   [][2]string `json:"decoded"`
	Trims     [][2]string `json:"trims"`
	ToNumber  [][2]string `json:"toNumber"`
	ParseInts [][2]any    `json:"parseInts"`
	SortIn    []string    `json:"sortIn"`
	Sorted    []string    `json:"sorted"`
}

func load(t *testing.T) truth {
	b, err := os.ReadFile("testdata/js-truth.json")
	if err != nil {
		t.Fatal(err)
	}
	var tr truth
	if err := json.Unmarshal(b, &tr); err != nil {
		t.Fatal(err)
	}
	return tr
}

func TestNumbers(t *testing.T) {
	for _, v := range load(t).Numbers {
		f := v[0].(float64)
		if got := NumberToString(f); got != v[1] {
			t.Errorf("String(%v) = %q, want %q", f, got, v[1])
		}
		if got := ToFixed(f, 1); got != v[2] {
			t.Errorf("(%v).toFixed(1) = %q, want %q", f, got, v[2])
		}
	}
	if got := ToFixed(2359296.0/1024/1024, 1); got != "2.3" {
		t.Errorf("2.25 MiB tie: %q", got)
	}
}

func TestDecode(t *testing.T) {
	for _, v := range load(t).Decoded {
		b, _ := hex.DecodeString(v[0])
		if got := Decode(b); got != v[1] {
			t.Errorf("decode %s = %+q, want %+q", v[0], got, v[1])
		}
		// streaming: every split point gives the same text
		for cut := 0; cut <= len(b); cut++ {
			var d Decoder
			if got := d.Write(b[:cut]) + d.Write(b[cut:]) + d.Flush(); got != v[1] {
				t.Errorf("stream %s @%d = %+q, want %+q", v[0], cut, got, v[1])
				break
			}
		}
	}
}

func TestTrimNumberParseInt(t *testing.T) {
	tr := load(t)
	for _, v := range tr.Trims {
		if got := Trim(v[0]); got != v[1] {
			t.Errorf("trim(%+q) = %+q, want %+q", v[0], got, v[1])
		}
	}
	for _, v := range tr.ToNumber {
		if got := NumberToString(StringToNumber(v[0])); got != v[1] {
			t.Errorf("Number(%q) = %s, want %s", v[0], got, v[1])
		}
	}
	for _, v := range tr.ParseInts {
		n, ok := ParseInt(v[0].(string))
		if v[1] == nil {
			if ok {
				t.Errorf("parseInt(%q) = %d, want NaN", v[0], n)
			}
		} else if !ok || float64(n) != v[1].(float64) {
			t.Errorf("parseInt(%q) = %d,%v want %v", v[0], n, ok, v[1])
		}
	}
}

func TestSort16(t *testing.T) {
	tr := load(t)
	got := slices.Clone(tr.SortIn)
	slices.SortStableFunc(got, func(a, b string) int {
		if Less16(a, b) {
			return -1
		}
		if Less16(b, a) {
			return 1
		}
		return 0
	})
	if !slices.Equal(got, tr.Sorted) {
		t.Errorf("sort = %q\nwant  %q", got, tr.Sorted)
	}
}

func TestValues(t *testing.T) {
	cases := []struct {
		v      any
		str    string
		num    float64
		truthy bool
	}{
		{Undefined, "undefined", math.NaN(), false},
		{nil, "null", 0, false},
		{true, "true", 1, true},
		{float64(5), "5", 5, true},
		{1.5, "1.5", 1.5, true},
		{1e21, "1e+21", 1e21, true},
		{float64(123456789), "123456789", 123456789, true},
		{"", "", 0, false},
		{"false", "false", math.NaN(), true},
		{" 2 ", " 2 ", 2, true},
		{[]any{}, "", 0, true},
		{[]any{float64(3)}, "3", 3, true},
		{[]any{"a", nil, float64(1)}, "a,,1", math.NaN(), true},
		{map[string]any{}, "[object Object]", math.NaN(), true},
	}
	for _, c := range cases {
		if got := ToString(c.v); got != c.str {
			t.Errorf("ToString(%#v) = %q, want %q", c.v, got, c.str)
		}
		if got := ToNumber(c.v); !(got == c.num || math.IsNaN(got) && math.IsNaN(c.num)) {
			t.Errorf("ToNumber(%#v) = %v, want %v", c.v, got, c.num)
		}
		if got := Truthy(c.v); got != c.truthy {
			t.Errorf("Truthy(%#v) = %v", c.v, got)
		}
	}
}

func TestUTF16(t *testing.T) {
	s := strings.Repeat("a", 3) + "\U0001F600" + "b"
	if Len16(s) != 6 {
		t.Fatal(Len16(s))
	}
	cut := Truncate16(s, 4) // through the pair: lone high surrogate kept
	var sb strings.Builder
	WriteJSONString(&sb, cut)
	if sb.String() != `"aaa\ud83d"` {
		t.Errorf("lone surrogate JSON = %s", sb.String())
	}
	sb.Reset()
	WriteJSONString(&sb, "q\"\\\n\t\x01<>&é\U0001F600")
	if sb.String() != `"q\"\\\n\t\u0001<>&é`+"\U0001F600"+`"` {
		t.Errorf("JSON = %s", sb.String())
	}
	if Truncate16(s, 5) != s[:len(s)-1] || Truncate16(s, 3) != "aaa" {
		t.Error("Truncate16 boundaries")
	}
}
