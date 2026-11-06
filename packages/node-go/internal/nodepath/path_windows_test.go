//go:build windows

package nodepath

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestWindowsResolve(t *testing.T) {
	t.Setenv("HOME", `Z:\wrong`)
	t.Setenv("USERPROFILE", `C:\Users\tester`)
	for _, c := range []struct{ base, p, want string }{
		{`C:\root`, `sub/file`, `C:\root\sub\file`},
		{`C:\root`, `sub\..\file`, `C:\root\file`},
		{`C:\root`, `/absolute/file`, `C:\absolute\file`},
		{`C:\root`, `\absolute\file`, `C:\absolute\file`},
		{`C:\root`, `c:child`, `C:\root\child`},
		{`C:\root`, `C:.`, `C:\root`},
		{`C:\root`, `C:..`, `C:\`},
		{`C:\root`, `D:\other`, `D:\other`},
		{`C:\root`, `~/file`, `C:\Users\tester\file`},
		{`C:\root`, `~\file`, `C:\root\~\file`}, // TS only expands ~/.
		{`\\server\share\root`, `..\file`, `\\server\share\file`},
		{`\\server\share\root`, `\file`, `\\server\share\file`},
	} {
		if got := Resolve(c.base, c.p); got != c.want {
			t.Errorf("Resolve(%q,%q) = %q, want %q", c.base, c.p, got, c.want)
		}
	}
	if Home() != `C:\Users\tester` || Rel(`C:\Root`, `c:\root\a`) != "a" || Rel(`C:\root`, `D:\other`) != `D:\other` {
		t.Fatal("home / case-insensitive relative / cross-volume relative")
	}
	t.Setenv("USERPROFILE", "")
	if Home() != "" || ExpandHome("~/x") != "x" {
		t.Fatal("empty USERPROFILE must not fall back to HOME")
	}
}

func TestWindowsSupported(t *testing.T) {
	for _, p := range []string{`\\?\C:\root`, `//?/C:/root`, `\\.\C:\root`, `//./C:/root`, `inside.\file`, `inside \file`, `C:inside.`, `inside.\..\file`} {
		if Supported(p) {
			t.Errorf("accepted %q", p)
		}
		if InRoot(t.TempDir(), p) != "" {
			t.Errorf("InRoot accepted %q", p)
		}
		if _, err := Realpath(p); err == nil {
			t.Errorf("Realpath accepted %q", p)
		}
	}
	for _, p := range []string{`C:.`, `C:..`, `C:\root\file.txt`, `.\sub\..\file`, `a b\file`, `a.b\file`, `\\server\share\file`} {
		if !Supported(p) {
			t.Errorf("refused %q", p)
		}
	}
}

func TestWindowsInRoot(t *testing.T) {
	tmp, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(tmp, "Root")
	for _, p := range []string{filepath.Join(root, "sub"), filepath.Join(tmp, "outside"), filepath.Join(tmp, "Root-other")} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []struct {
		p      string
		inside bool
	}{
		{".", true}, {"sub/new/file", true}, {`sub\new\file`, true},
		{filepath.VolumeName(root) + ".", true}, {filepath.VolumeName(root) + "..", false},
		{filepath.VolumeName(root) + "inside.", false},
		{strings.ToUpper(root) + `\SUB\new`, true},
		{`..\outside\file`, false}, {"../outside/file", false}, {`..\Root-other\file`, false},
		{`Z:\other\file`, false}, {`\\localhost\absent-share\file`, false},
	} {
		if got := InRoot(root, c.p); (got != "") != c.inside {
			t.Errorf("InRoot(%q) = %q, inside=%v", c.p, got, c.inside)
		}
	}
	// Junction creation needs no symlink privilege or Developer Mode. Both an
	// existing target and a missing tail must be resolved before confinement.
	for _, c := range []struct {
		name, target string
		inside       bool
	}{
		{"in-junction", filepath.Join(root, "sub"), true},
		{"out-junction", filepath.Join(tmp, "outside"), false},
	} {
		link := filepath.Join(root, c.name)
		if out, err := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", link, c.target).CombinedOutput(); err != nil {
			t.Fatalf("junction: %v: %s", err, out)
		}
		for _, suffix := range []string{"", `\missing\file`} {
			if got := InRoot(root, link+suffix); (got != "") != c.inside {
				t.Errorf("junction %s: %q", link+suffix, got)
			}
		}
	}
	t.Run("symlink", func(t *testing.T) {
		link := filepath.Join(root, "symlink")
		if err := os.Symlink(filepath.Join(tmp, "outside"), link); err != nil {
			t.Skipf("Windows symlink creation requires Developer Mode or privilege: %v", err)
		}
		if InRoot(root, link+`\new`) != "" {
			t.Fatal("outward symlink allowed")
		}
	})
}
