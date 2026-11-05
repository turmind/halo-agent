package nodepath

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInRoot(t *testing.T) {
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	root := filepath.Join(tmp, "root")
	_ = os.MkdirAll(filepath.Join(root, "sub"), 0o755)
	_ = os.MkdirAll(filepath.Join(tmp, "outside"), 0o755)
	_ = os.MkdirAll(filepath.Join(tmp, "root-other"), 0o755)
	_ = os.Symlink(filepath.Join(root, "sub"), filepath.Join(root, "in-link"))
	_ = os.Symlink(filepath.Join(tmp, "outside"), filepath.Join(root, "out-link"))
	_ = os.Symlink(filepath.Join(tmp, "outside", "new"), filepath.Join(root, "dangling"))
	t.Setenv("HOME", tmp)
	for _, c := range []struct{ p, want string }{
		{".", root},
		{"", root},
		{"sub/x/y.txt", filepath.Join(root, "sub/x/y.txt")},
		{"in-link/f", filepath.Join(root, "sub/f")},
		{"out-link/f", ""},
		{"dangling", ""},
		{"../outside", ""},
		{"../root-other/x", ""},
		{root + "/a", root + "/a"},
		{"~/root/sub", filepath.Join(root, "sub")},
		{"~/outside", ""},
		{"/", ""},
	} {
		if got := InRoot(root, c.p); got != c.want {
			t.Errorf("InRoot(%q) = %q, want %q", c.p, got, c.want)
		}
	}
}

func TestResolveExpand(t *testing.T) {
	t.Setenv("HOME", "/h")
	for _, c := range []struct{ base, p, want string }{
		{"/b", "x", "/b/x"},
		{"/b", "/abs/../y", "/y"},
		{"/b", "~/z", "/h/z"},
		{"/b", "~", "/b/~"},
		{"/b", "~x/y", "/b/~x/y"},
		{"/b", "", "/b"},
	} {
		if got := Resolve(c.base, c.p); got != c.want {
			t.Errorf("Resolve(%q,%q) = %q, want %q", c.base, c.p, got, c.want)
		}
	}
	if Rel("/a/b", "/a/c/d") != "../c/d" || Rel("/a", "/a") != "" {
		t.Error("Rel")
	}
}

// os.homedir() with HOME set but empty is "" (no passwd fallback), so
// `~/z` is path.join('', 'z') = the relative `z`, resolved against base.
func TestEmptyHome(t *testing.T) {
	t.Setenv("HOME", "")
	if h := Home(); h != "" {
		t.Errorf(`Home() = %q, want ""`, h)
	}
	if got := ExpandHome("~/z"); got != "z" {
		t.Errorf("ExpandHome(~/z) = %q, want z", got)
	}
	if got := Resolve("/b", "~/z"); got != "/b/z" {
		t.Errorf("Resolve(/b, ~/z) = %q, want /b/z", got)
	}
}
