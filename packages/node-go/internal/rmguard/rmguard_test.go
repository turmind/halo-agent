package rmguard

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// testdata/vectors.json: conformance/gen-rmguard-vectors.mjs (the TS
// assertRmSafe is the oracle; CI re-runs it with --check).
type vectors struct {
	Home    string `json:"home"`
	WS      string `json:"ws"`
	Vectors []struct {
		Cmd    string `json:"cmd"`
		Cwd    string `json:"cwd"`
		Result string `json:"result"`
	} `json:"vectors"`
	Homes []struct {
		Home   string `json:"home"`
		Cmd    string `json:"cmd"`
		Cwd    string `json:"cwd"`
		Result string `json:"result"`
	} `json:"homes"`
}

func load(t *testing.T) vectors {
	b, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Vectors) == 0 || len(v.Homes) == 0 {
		t.Fatal("empty vectors")
	}
	return v
}

func result(err error) string {
	if err == nil {
		return "ok"
	}
	return err.Error()
}

// unhold puts the real paths back for the generator's placeholders (<WS> is
// HOME/projects/demo, so it's expanded first, as the generator held it).
func unhold(s, home, ws string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "<WS>", ws), "<HOME>", home)
}

func TestVectors(t *testing.T) {
	v := load(t)
	for _, r := range v.Vectors {
		cmd, cwd, want := unhold(r.Cmd, v.Home, v.WS), unhold(r.Cwd, v.Home, v.WS), unhold(r.Result, v.Home, v.WS)
		if got := result(Check(cmd, cwd, v.Home)); got != want {
			t.Errorf("Check(%q, %q)\n got %q\nwant %q", cmd, cwd, got, want)
		}
	}
}

func TestHomes(t *testing.T) {
	for _, r := range load(t).Homes {
		if got := result(Check(r.Cmd, r.Cwd, r.Home)); got != r.Result {
			t.Errorf("HOME=%q Check(%q, %q)\n got %q\nwant %q", r.Home, r.Cmd, r.Cwd, got, r.Result)
		}
	}
}

func TestUnhold(t *testing.T) {
	const home, ws = "/home/tester", "/home/tester/projects/demo"
	for _, c := range [][2]string{
		{"rm -rf <WS>/out", "rm -rf /home/tester/projects/demo/out"},
		{`"<HOME>" resolves to <HOME>/.halo`, `"/home/tester" resolves to /home/tester/.halo`},
		{"<WS><HOME>", ws + home},
		{"<HOMEX> <ws>", "<HOMEX> <ws>"},
		{"ok", "ok"},
	} {
		if got := unhold(c[0], home, ws); got != c[1] {
			t.Errorf("unhold(%q) = %q, want %q", c[0], got, c[1])
		}
	}
}

// HOME / cwd are inserted as-is: no `$&` / `$'` / `$$` pattern expansion.
func TestExpandLiteral(t *testing.T) {
	for _, c := range []struct{ w, cwd, home, want string }{
		{"~", "/c", "/home/x$&y", "/home/x$&y"},
		{"~/q", "/c", "/home/x$'y", "/home/x$'y/q"},
		{"$HOME/${HOME}", "/c", "/h$$", "/h$$//h$$"},
		{"a$PWD`pwd`$(pwd)${PWD}", "/w$&b$`", "/h", "a/w$&b$`/w$&b$`/w$&b$`/w$&b$`"},
		{"$PWD/$X", "/w$1", "/h", "/w$1/"},
		{"~", "/c", "/home/u$PWD$X", "/home/u$PWD$X"},
		{"$(echo $(pwd))/", "/c", "/h", "/"},                    // still expanded before the unset pass, as before
		{"~/[a]*", "/c", "/h[1]?*", "/h\x0021]\x001\x000/[a]*"}, // home's globs escaped, the word's kept
		{"$PWD/*", "/c\x002", "/h", "/c\x002/*"},                // cwd arrives already escaped
	} {
		if got := expandWord(c.w, c.cwd, c.home); got != c.want {
			t.Errorf("expandWord(%q, %q, %q) = %q, want %q", c.w, c.cwd, c.home, got, c.want)
		}
	}
}

// /^<<(-?)\s*(['"]?)([A-Za-z0-9_.-]+)\2/ incl. the backtrack onto `-`.
func TestHeredocAt(t *testing.T) {
	for _, c := range []struct {
		s     string
		n     int
		delim string
		dash  bool
	}{
		{"<<EOF\n", 5, "EOF", false},
		{"<< 'EOF' x", 8, "EOF", false},
		{"<<-\"E\"", 6, "E", true},
		{"<<-'EOF\n", 3, "-", false},
		{"<<--x", 5, "-x", true},
		{"<<\u00a0\u2028X", 2 + 2 + 3 + 1, "X", false},
		{"<<'EOF", 0, "", false},
		{"<<''", 0, "", false},
		{"<< ;", 0, "", false},
		{"<<", 0, "", false},
	} {
		n, delim, dash := heredocAt(c.s)
		if n != c.n || delim != c.delim || dash != c.dash {
			t.Errorf("heredocAt(%q) = %d %q %v, want %d %q %v", c.s, n, delim, dash, c.n, c.delim, c.dash)
		}
	}
}

// Go-side spellings the vectors can't vary: relative / unclean cwd, an
// empty home, non-ASCII bytes copied through the byte-wise walk.
func TestCheckEdges(t *testing.T) {
	const home = "/home/tester"
	wd, _ := os.Getwd()
	for _, c := range []struct{ cmd, cwd, home, want string }{
		{"rm -rf .", "/srv/ws/", home, `"." resolves to /srv/ws, which is the workspace root`},
		{"rm -rf ..", "/srv//ws/./a/..", home, `".." resolves to /srv, which is the workspace root or a parent of it`},
		{"rm -rf a", "/srv//ws/./a/..", home, ""},
		{"rm -rf .", "", home, `"." resolves to ` + wd + `, which is`},
		{"rm -rf ~", "/srv/ws", "", ""},
		{"rm -rf ~/x", "/srv/ws", "", ""},
		{`rm -rf "/home/tëster"`, "/srv/ws", home, `"/home/tëster" resolves to /home/tëster, which is a system directory`},
		{"rm -rf 日本/*", "/srv/ws", home, ""},
		{`rm -rf \日`, "/srv/ws", home, ""},
		// glob chars from cwd / home are literal; the word's own globs still count
		{"rm -rf ./*", "/srv/proj [v2]", home, `"./*" resolves to /srv/proj [v2], which is the workspace root`},
		{"rm -rf $PWD", "/srv/a*b", home, `"$PWD" resolves to /srv/a*b, which is the workspace root`},
		{"rm -rf ~/*", "/srv/ws", "/home/x?y", `"~/*" resolves to /home/x?y, which is the home directory`},
		{"rm -rf *.log", "/srv/a[1]b", home, ""},
		// a narrow glob is judged by its literal self
		{`cd "/srv/proj [v2]" && rm -rf .`, "/srv/proj [v2]", home, `"." resolves to /srv/proj [v2], which is the workspace root`},
		{`rm -rf "/home/x[1]y"`, "/srv/ws", "/home/x[1]y", `"/home/x[1]y" resolves to /home/x[1]y, which is the home directory`},
		{"cd /srv/x[1] && rm -rf .", "/srv/ws", home, `"." resolves to /srv/x[1], which is a system directory`},
		{"rm -rf /tmp/build-*", "/srv/a[1]b", home, ""},
		{"rm -rf ~/*.log", "/srv/ws", "/home/x[1]y", ""},
		// an everything-glob after a glob-looking literal segment is judged by its parent
		{`cd "/srv/proj [v2]" && rm -rf *`, "/srv/proj [v2]", home, `"*" resolves to /srv/proj [v2], which is the workspace root`},
		{`rm -rf /srv/proj\ \[v2\]/*`, "/srv/proj [v2]", home, `"/srv/proj [v2]/*" resolves to /srv/proj [v2], which is the workspace root`},
		{`cd "/srv/proj [v2]/sub" && rm -rf ../*`, "/srv/proj [v2]", home, `"../*" resolves to /srv/proj [v2], which is the workspace root`},
		{`rm -rf "/home/x[1]y"/*`, "/srv/ws", "/home/x[1]y", `"/home/x[1]y/*" resolves to /home/x[1]y, which is the home directory`},
		{"rm -rf /srv/build-*/*", "/srv/ws", home, `"/srv/build-*/*" resolves to /srv/build-*, which is a system directory`},
		{"rm -rf /tmp/foo/*", "/srv/ws", home, ""},
		{`cd "/srv/a[1]b" && rm -rf *.log`, "/srv/ws", home, ""},
	} {
		got := ""
		if err := Check(c.cmd, c.cwd, c.home); err != nil {
			got = err.Error()
		}
		if c.want == "" && got != "" || c.want != "" && !strings.Contains(got, c.want) {
			t.Errorf("Check(%q, %q, %q) = %q, want ~%q", c.cmd, c.cwd, c.home, got, c.want)
		}
	}
}
