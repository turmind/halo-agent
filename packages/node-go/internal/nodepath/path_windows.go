//go:build windows

package nodepath

import (
	"os"
	"os/user"
	"path/filepath"
	"strings"
)

// Home is Node's os.homedir() on Windows, independent of a POSIX shell's HOME.
func Home() string {
	if h, ok := os.LookupEnv("USERPROFILE"); ok {
		return h
	}
	if u, err := user.Current(); err == nil {
		return u.HomeDir
	}
	return ""
}

// Resolve mirrors path.win32.resolve, including rooted paths without a drive
// and drive-relative paths. filepath.Abs uses Windows' per-drive current dirs.
func Resolve(base, p string) string {
	p = filepath.FromSlash(ExpandHome(p))
	base = filepath.Clean(base)
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	volume := filepath.VolumeName(p)
	if volume != "" {
		if strings.EqualFold(volume, filepath.VolumeName(base)) {
			return filepath.Join(base, p[len(volume):])
		}
		full, _ := filepath.Abs(p)
		return full
	}
	if strings.HasPrefix(p, `\`) {
		return filepath.Clean(filepath.VolumeName(base) + p)
	}
	return filepath.Join(base, p)
}

// filepath.Rel compares Windows volumes and components case-insensitively.
// Like Node, another volume produces an absolute path, not an empty relative one.
func Rel(from, to string) string {
	r, err := filepath.Rel(from, to)
	if err != nil {
		return to
	}
	if r == "." {
		return ""
	}
	return r
}
