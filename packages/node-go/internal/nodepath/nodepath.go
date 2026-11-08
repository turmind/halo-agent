// Package nodepath: `~/` expansion and folder-mode confinement.
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
	full := canonical(root, p)
	if full == "" {
		return ""
	}
	rel, err := filepath.Rel(root, full)
	if err != nil {
		return ""
	}
	if rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)) {
		return full
	}
	return ""
}

// canonical resolves the longest existing prefix without admitting spellings
// that Windows would normalize differently when the checked path is opened.
func canonical(base, p string) string {
	if !Supported(base) || !Supported(p) {
		return ""
	}
	prefix := Resolve(base, p)
	if !Supported(prefix) {
		return ""
	}
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
	real, err := Realpath(prefix)
	if err != nil {
		return ""
	}
	full := filepath.Join(append([]string{real}, tail...)...)
	if !Supported(full) {
		return ""
	}
	return full
}
