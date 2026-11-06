//go:build windows

package exec

import (
	"context"
	"errors"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/turmind/halo-agent/packages/node-go/internal/nodepath"
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

// D18: validating inside. then opening it without the namespace would follow
// the distinct inside junction. Both spellings must be refused, never emulated.
func TestWindowsAmbiguousPaths(t *testing.T) {
	for _, suffix := range []string{".", " "} {
		t.Run("suffix="+suffix, func(t *testing.T) {
			tmp := t.TempDir()
			root, outside := filepath.Join(tmp, "shared"), filepath.Join(tmp, "outside")
			for _, dir := range []string{root, outside} {
				if err := os.Mkdir(dir, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			sentinel := filepath.Join(outside, "probe.txt")
			if err := os.WriteFile(sentinel, []byte("outside sentinel"), 0o600); err != nil {
				t.Fatal(err)
			}
			special := `\\?\` + filepath.Join(root, "inside"+suffix)
			if err := os.Mkdir(special, 0o755); err != nil {
				t.Fatal(err)
			}
			// Remove through the namespace too; ordinary cleanup normalizes it.
			t.Cleanup(func() { os.Remove(special + `\probe.txt`); os.Remove(special) })
			if err := os.WriteFile(special+`\probe.txt`, []byte("inside sentinel"), 0o600); err != nil {
				t.Fatal(err)
			}
			for _, link := range []struct{ name, target string }{
				{"inside", outside}, {"alias", special},
			} {
				out, err := osexec.Command("cmd.exe", "/d", "/c", "mklink", "/J", filepath.Join(root, link.name), link.target).CombinedOutput()
				if err != nil {
					t.Fatalf("junction: %v: %s", err, out)
				}
			}
			for _, rejectedRoot := range []string{special, filepath.Join(root, "inside"+suffix), filepath.Join(root, "alias")} {
				if real, err := nodepath.Realpath(rejectedRoot); err == nil {
					t.Errorf("root resolved to %q without refusal: %q", real, rejectedRoot)
				}
				if got := nodepath.InRoot(rejectedRoot, "probe.txt"); got != "" {
					t.Errorf("unsupported root accepted: %q", got)
				}
			}
			// Confirm both distinct objects exist in the fixture.
			if b, err := os.ReadFile(special + `\probe.txt`); err != nil || string(b) != "inside sentinel" {
				t.Fatalf("special: %q %v", b, err)
			}
			if b, err := os.ReadFile(filepath.Join(root, "inside", "probe.txt")); err != nil || string(b) != "outside sentinel" {
				t.Fatalf("junction: %q %v", b, err)
			}
			for _, scopeRoot := range []string{root, ""} {
				ex := New(Scope{Root: scopeRoot, Base: root, Log: func(string) {}})
				for _, p := range []string{
					special + `\probe.txt`, filepath.Join(root, "inside"+suffix, "probe.txt"),
					filepath.ToSlash(special + `\probe.txt`), `\\.\` + filepath.Join(root, "inside", "probe.txt"),
					`alias\probe.txt`, `alias\new.txt`, `alias\missing\new.txt`,
				} {
					for _, op := range []string{"read", "write"} {
						text, err := ex.Exec(context.Background(), op, map[string]any{"path": p, "content": "changed"})
						var refused *refusal
						if !errors.As(err, &refused) || text != "" {
							t.Errorf("%s %q: text=%q err=%v", op, p, text, err)
						}
						if scopeRoot != "" && refused != nil && !strings.Contains(refused.Error(), "outside this machine's shared folder") {
							t.Error(refused)
						}
					}
				}
			}
			if b, err := os.ReadFile(sentinel); err != nil || string(b) != "outside sentinel" {
				t.Fatalf("outside sentinel changed: %q %v", b, err)
			}
			if b, err := os.ReadFile(special + `\probe.txt`); err != nil || string(b) != "inside sentinel" {
				t.Fatalf("inside sentinel changed: %q %v", b, err)
			}
		})
	}
}
