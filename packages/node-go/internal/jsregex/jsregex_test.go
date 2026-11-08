package jsregex

import (
	"bufio"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// testdata/js-truth.json is produced by testgen/gen-regex-truth.mjs from
// Node's own RegExp — the oracle for §2.9 R1–R7 and the V8 error text.
type truth struct {
	Match []struct {
		P     string  `json:"p"`
		Cases [][]any `json:"cases"`
	} `json:"match"`
	Errors [][]any `json:"errors"`
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

func TestMatchesJS(t *testing.T) {
	for _, m := range load(t).Match {
		re, err := Compile(m.P)
		if err != nil {
			t.Errorf("%q: compile: %v", m.P, err)
			continue
		}
		for _, c := range m.Cases {
			s, want := c[0].(string), c[1].(bool)
			if got, _ := re.Test(s); got != want {
				t.Errorf("/%s/.test(%q) = %v, want %v", m.P, s, got, want)
			}
		}
	}
}

func TestErrorsJS(t *testing.T) {
	for _, e := range load(t).Errors {
		src := e[0].(string)
		_, err := Compile(src)
		switch want := e[1].(type) {
		case nil:
			if err != nil {
				t.Errorf("%q: JS accepts, got %v", src, err)
			}
		case string:
			if err == nil || err.Error() != want {
				t.Errorf("%q: got %v, want %q", src, err, want)
			}
		}
	}
}

// TestDifferential replays JSONL vectors from testgen/regex-fuzz.mjs —
// {src, err} or {src, in, out} with out[i] = '1' when /src/.test(in[i]) — from
// testdata/regex-regress.jsonl (minimised past mismatches, always) plus the
// file named by JSREGEX_VECTORS (a fresh CI fuzz run, when set). A vector with
// "known":"D<n>" pins an accepted difference: Go must still differ from out.
func TestDifferential(t *testing.T) {
	files := []string{"testdata/regex-regress.jsonl"}
	if f := os.Getenv("JSREGEX_VECTORS"); f != "" {
		files = append(files, f)
	}
	for _, name := range files {
		f, err := os.Open(name)
		if err != nil {
			t.Fatal(err)
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(nil, 1<<20)
		n, bad, rt, slow := 0, 0, 0, 0
		for sc.Scan() {
			if strings.TrimSpace(sc.Text()) == "" {
				continue
			}
			var v struct {
				Src   string   `json:"src"`
				Err   *string  `json:"err"`
				Rt    string   `json:"rt"`
				In    []string `json:"in"`
				Out   string   `json:"out"`
				Known string   `json:"known"`
			}
			if err := json.Unmarshal(sc.Bytes(), &v); err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			n++
			msg := ""
			if v.Rt != "" { // V8 hit an engine limit inside test() (D10): only the syntax must agree
				rt++
				if _, err := Compile(v.Src); err != nil {
					msg = "JS accepts, got " + err.Error()
				}
			} else if v.Known != "" { // design/node.md known differences
				if m, _ := diff(v.Src, v.Err, v.In, v.Out); m == "" {
					msg = "known difference " + v.Known + " no longer differs — drop the vector's known mark"
				}
			} else {
				var timedOut bool
				msg, timedOut = diff(v.Src, v.Err, v.In, v.Out)
				if timedOut { // catastrophic backtracking both engines share; V8 pruned this input (D10)
					slow++
					t.Logf("%s: %q: regexp2 over %v, skipped", name, v.Src, diffTimeout)
				}
			}
			if msg != "" {
				bad++
				if bad <= 50 {
					t.Errorf("%s: %q: %s", name, v.Src, msg)
				}
			}
		}
		f.Close()
		if err := sc.Err(); err != nil {
			t.Fatal(err)
		}
		t.Logf("%s: %d vectors (%d engine-limit compile-only, %d over %v), %d mismatches", name, n, rt, slow, diffTimeout, bad)
	}
}

const diffTimeout = 2 * time.Second

func diff(src string, wantErr *string, in []string, out string) (string, bool) {
	re, err := Compile(src)
	if wantErr != nil {
		if err == nil || err.Error() != *wantErr {
			return "got " + errText(err) + ", want " + *wantErr, false
		}
		return "", false
	}
	if err != nil {
		return "JS accepts, got " + err.Error(), false
	}
	re.re.MatchTimeout = diffTimeout
	var got strings.Builder
	for _, s := range in {
		ok, merr := re.Test(s)
		if merr != nil {
			return "", true
		}
		if ok {
			got.WriteByte('1')
		} else {
			got.WriteByte('0')
		}
	}
	if got.String() != out {
		var d []string
		for i := range in {
			if got.String()[i] != out[i] {
				d = append(d, jsonQ(in[i])+"→"+string(out[i]))
			}
		}
		return "test() differs on " + strings.Join(d, " "), false
	}
	return "", false
}

func errText(err error) string {
	if err == nil {
		return "<accepted>"
	}
	return err.Error()
}

func jsonQ(s string) string { b, _ := json.Marshal(s); return string(b) }

// json.Unmarshal turns a lone surrogate into U+FFFD, so astral / surrogate
// cases the JSON can't carry are pinned here.
func TestSurrogates(t *testing.T) {
	for _, c := range []struct {
		p, s string
		want bool
	}{
		{"^.$", "\U0001F600", false},
		{"^..$", "\U0001F600", true},
		{`\uD83D`, "\U0001F600", true},
		{`\uD83D\uDE00`, "x\U0001F600", true},
		{"[\U0001F600]", "\U0001F601", true}, // shares the high surrogate D83D
		{"^[\U0001F600]$", "\U0001F600", false},
		{"\U0001F600", "\U0001F600", true},
	} {
		re, err := Compile(c.p)
		if err != nil {
			t.Fatalf("%q: %v", c.p, err)
		}
		if got, _ := re.Test(c.s); got != c.want {
			t.Errorf("/%s/.test(%q) = %v, want %v", c.p, c.s, got, c.want)
		}
	}
	if _, err := Compile("[\U0001F600-\U0001F602]"); err == nil || err.Error() != "Invalid regular expression: /[\U0001F600-\U0001F602]/: Range out of order in character class" {
		t.Errorf("astral range: %v", err)
	}
}

// The parser recurses per group: past maxDepth it is a SyntaxError, not a
// goroutine stack overflow (V8: `Stack overflow` at test(), depth ~11000).
func TestNestingDepth(t *testing.T) {
	for _, open := range []string{"(", "(?:", "(?="} {
		ok := strings.Repeat(open, maxDepth) + "a" + strings.Repeat(")", maxDepth)
		if _, err := Compile(ok); err != nil {
			t.Errorf("depth %d %q: %v", maxDepth, open, err)
		}
		deep := strings.Repeat(open, maxDepth+1) + "a" + strings.Repeat(")", maxDepth+1)
		_, err := Compile(deep)
		if se, isSE := err.(*SyntaxError); !isSE || se.Msg != "Stack overflow" {
			t.Errorf("depth %d %q: %v", maxDepth+1, open, err)
		}
	}
	src := strings.Repeat("(?:", 1_000_000) // unterminated, far past any recursion budget
	if _, err := Compile(src); err == nil || !strings.HasSuffix(err.Error(), "/: Stack overflow") {
		t.Errorf("1e6 deep: %v", err)
	}
}

func TestMatchTimeout(t *testing.T) {
	old := MatchTimeout
	MatchTimeout = 200 * time.Millisecond
	defer func() { MatchTimeout = old }()
	re, err := Compile(`^(a+)+$`)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if ok, err := re.Test(strings.Repeat("a", 40) + "!"); ok || err != ErrTimeout {
		t.Fatalf("got %v, %v; want ErrTimeout", ok, err)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("timed out after %v", d)
	}
	if ok, err := re.Test("aaa"); !ok || err != nil {
		t.Errorf("plain match: %v, %v", ok, err)
	}
	// regexp2's timeout text is what Test keys on; keep it pinned across upgrades.
	_, err = re.re.MatchString(strings.Repeat("a", 40) + "!")
	if err == nil || !strings.HasPrefix(err.Error(), "match timeout after ") {
		t.Errorf("regexp2 timeout error: %v", err)
	}
}
