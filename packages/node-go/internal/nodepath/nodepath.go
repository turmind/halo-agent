// Package nodepath is node-path.ts: `~/` expansion and folder-mode confinement.
package nodepath

import (
	"os"
	"os/user"
	"path/filepath"
	"strings"
)

// Home is os.homedir(): $HOME, else the passwd entry.
func Home() string {
	if h := os.Getenv("HOME"); h != "" {
		return h
	}
	if u, err := user.Current(); err == nil {
		return u.HomeDir
	}
	return "/"
}

// ExpandHome expands a leading `~/` only.
func ExpandHome(p string) string {
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(Home(), p[2:])
	}
	return p
}

// Resolve is path.resolve(base, expandHome(p)).
func Resolve(base, p string) string {
	p = ExpandHome(p)
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Join(base, p)
}

// InRoot returns the absolute in-root path for p, or "" when p lands outside
// root (already realpath'd): realpath of the longest existing prefix (lstat
// walk-up, so a dangling symlink is refused) plus the missing tail.
func InRoot(root, p string) string {
	prefix := Resolve(root, p)
	var tail []string
	for {
		if _, err := os.Lstat(prefix); err == nil {
			break
		}
		parent := filepath.Dir(prefix)
		if parent == prefix {
			break
		}
		tail = append([]string{filepath.Base(prefix)}, tail...)
		prefix = parent
	}
	real, err := filepath.EvalSymlinks(prefix)
	if err != nil {
		return ""
	}
	full := filepath.Join(append([]string{real}, tail...)...)
	rel, err := filepath.Rel(root, full)
	if err != nil {
		return ""
	}
	if rel == "." || (rel != ".." && !strings.HasPrefix(rel, "../") && !filepath.IsAbs(rel)) {
		return full
	}
	return ""
}

// Rel is path.relative(from, to) for absolute paths ("" when equal).
func Rel(from, to string) string {
	r, err := filepath.Rel(from, to)
	if err != nil || r == "." {
		return ""
	}
	return r
}
