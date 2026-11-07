package jsregex

import (
	"runtime"
	"strings"
	"testing"
)

func TestLiteralMatch(t *testing.T) {
	// Boolean results checked against Node's no-flags RegExp. Escapes and
	// syntax stay on the UTF-16 engine, including matches of half a pair.
	for _, c := range []struct {
		pattern, input string
		want           bool
	}{
		{"", "", true}, {"needle", "hay needle hay", true}, {"needle", "hay", false},
		{"é中", "xé中y", true}, {"é中", "e中", false},
		{"😀", "x😀y", true}, {"😀", "😁", false},
		{"a.b", "aXb", true}, {`a\+b`, "a+b", true},
		{"^a", "ba", false}, {"a$", "ab", false},
		{"a*", "", true}, {"a+", "aa", true}, {"a?", "", true},
		{"(ab)", "ab", true}, {"[ab]", "b", true},
		{"a{2}", "aa", true}, {"a|b", "b", true},
		{`\uD83D`, "😀", true}, {`\uDE00`, "😀", true},
		{"[😀]", "😁", true},       // non-u: either UTF-16 code unit matches
		{"\ufffd", "\xff", true}, // regexp2 decodes invalid Go UTF-8, unlike Contains
		{"\xff", "\ufffd", true},
	} {
		r, err := Compile(c.pattern)
		if err != nil {
			t.Fatalf("%q: %v", c.pattern, err)
		}
		got, err := r.Test(c.input)
		if err != nil || got != c.want {
			t.Errorf("/%s/.test(%q) = %v, %v; want %v", c.pattern, c.input, got, err, c.want)
		}
	}
}

func TestLiteralMatchAllocation(t *testing.T) {
	input := strings.Repeat("a", 1<<20) + "😀"
	for _, pattern := range []string{"needle", "a", "😀", "😁", ""} {
		r, err := Compile(pattern)
		if err != nil {
			t.Fatal(err)
		}
		var before, after runtime.MemStats
		runtime.ReadMemStats(&before)
		_, err = r.Test(input)
		runtime.ReadMemStats(&after)
		if err != nil {
			t.Fatal(err)
		}
		if n := after.TotalAlloc - before.TotalAlloc; n > 64<<10 {
			t.Errorf("literal %q allocated %d bytes for a %d-byte line", pattern, n, len(input))
		}
	}
}
