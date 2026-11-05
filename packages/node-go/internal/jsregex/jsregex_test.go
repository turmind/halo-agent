package jsregex

import (
	"encoding/json"
	"os"
	"testing"
)

// testdata/js-truth.json is produced by conformance/gen-regex-truth.mjs from
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
			if got := re.Test(s); got != want {
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
		if got := re.Test(c.s); got != c.want {
			t.Errorf("/%s/.test(%q) = %v, want %v", c.p, c.s, got, c.want)
		}
	}
	if _, err := Compile("[\U0001F600-\U0001F602]"); err == nil || err.Error() != "Invalid regular expression: /[\U0001F600-\U0001F602]/: Range out of order in character class" {
		t.Errorf("astral range: %v", err)
	}
}
