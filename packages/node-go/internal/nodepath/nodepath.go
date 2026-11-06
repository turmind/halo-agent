// Package nodepath is node-path.ts: `~/` expansion and folder-mode confinement.
package nodepath

import (
	"os"
	"path/filepath"
	"strings"
)

// ExpandHome expands a leading `~/` only.
func ExpandHome(p string) string {
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(Home(), p[2:])
	}
	return p
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
	if rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)) {
		return full
	}
	return ""
}
