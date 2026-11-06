//go:build windows

package exec

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWindowsMkdirp(t *testing.T) {
	root := t.TempDir()
	for _, p := range []string{filepath.VolumeName(root) + `\`, root, filepath.Join(root, "a", "b"), filepath.ToSlash(filepath.Join(root, "c", "d"))} {
		for i := 0; i < 2; i++ {
			if err := mkdirp(p); err != nil {
				t.Fatalf("mkdirp(%q): %v", p, err)
			}
		}
		if st, err := os.Stat(p); err != nil || !st.IsDir() {
			t.Fatalf("not a directory: %s: %v", p, err)
		}
	}
	// An extended-length volume path must retain its prefix during parent walks.
	if err := mkdirp(`\\?\` + filepath.Join(root, "extended", "child")); err != nil {
		t.Fatal(err)
	}
	// A nonexistent UNC share must settle at the share root, not keep recursing
	// through \\server or strip the volume. No live network share is required.
	if err := mkdirp(`\\localhost\halo-node-missing-share\child`); err == nil {
		t.Fatal("missing UNC share accepted")
	}
	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := mkdirp(file); err == nil || !strings.HasPrefix(err.Error(), "EEXIST: file already exists, mkdir '") {
		t.Fatalf("file: %v", err)
	}
	ex := New(Scope{Base: root, Log: func(string) {}})
	if got := run1(ex, "list", map[string]any{"path": "file"}); got != "ERR ENOTDIR: not a directory, scandir '"+file+"'" {
		t.Fatalf("list file: %s", got)
	}
}
