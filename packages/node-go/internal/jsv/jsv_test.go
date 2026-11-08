package jsv

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"runtime"
	"slices"
	"strings"
	"syscall"
	"testing"
)

// testdata/js-truth.json: testgen/gen-jsv-truth.mjs (Node is the oracle).
type truth struct {
	Numbers   [][3]any    `json:"numbers"`
	Decoded   [][2]string `json:"decoded"`
	Trims     [][2]string `json:"trims"`
	ToNumber  [][2]string `json:"toNumber"`
	ParseInts [][2]any    `json:"parseInts"`
	SortIn    []string    `json:"sortIn"`
	Sorted    []string    `json:"sorted"`
	Errno     [][3]any    `json:"errno"`
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

// Invalid bytes become 3-byte U+FFFD: the output is sized up front, so a
// decode allocates the result once — no doubling buffer next to it.
func TestDecodeAllocatesOnce(t *testing.T) {
	b := bytes.Repeat([]byte{0xff, 'a', 0xe2, 0x82}, 16<<20) // 64 MiB, all of it invalid but the 'a's
	var m0, m1 runtime.MemStats
	runtime.ReadMemStats(&m0)
	s := Decode(b)
	runtime.ReadMemStats(&m1)
	if want := 16 << 20 * 7; len(s) != want { // FFFD a FFFD
		t.Fatalf("len %d, want %d", len(s), want)
	}
	if got := m1.TotalAlloc - m0.TotalAlloc; float64(got) > 1.2*float64(len(s)) {
		t.Errorf("allocated %d bytes for a %d-byte result", got, len(s))
	}
}

// FsError's code / text per errno is Node's (util.getSystemErrorMap()); a code
// libuv doesn't map prints as `Unknown system error -<n>` (Node 22, measured with
// an LD_PRELOAD shim: EDQUOT, 200).
func TestFsErrorErrno(t *testing.T) {
	tr := load(t)
	if runtime.GOOS != "linux" {
		t.Skip("errno numbers are Linux's")
	}
	if len(tr.Errno) < 60 {
		t.Fatalf("truth has %d errnos", len(tr.Errno))
	}
	for _, e := range tr.Errno {
		n, code, text := int(e[0].(float64)), e[1].(string), e[2].(string)
		want := code + ": " + text + ", open '/p'"
		if got := FsError(syscall.Errno(n), "open", "/p").Error(); got != want {
			t.Errorf("errno %d: %q, want %q", n, got, want)
		}
	}
	for _, c := range []struct {
		en   syscall.Errno
		want string
	}{
		{syscall.EMLINK, "EMLINK: too many links, mkdir '/p'"},
		{syscall.ETIMEDOUT, "ETIMEDOUT: connection timed out, mkdir '/p'"},
		{syscall.EILSEQ, "EILSEQ: illegal byte sequence, mkdir '/p'"},
		{syscall.ENOTSUP, "ENOTSUP: operation not supported on socket, mkdir '/p'"},
		{syscall.EDQUOT, "Unknown system error -122: Unknown system error -122, mkdir '/p'"},
		{200, "Unknown system error -200: Unknown system error -200, mkdir '/p'"},
	} {
		if got := FsError(c.en, "mkdir", "/p").Error(); got != c.want {
			t.Errorf("%d: %q, want %q", c.en, got, c.want)
		}
	}
}
