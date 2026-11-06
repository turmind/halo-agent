//go:build !windows

package nodepath

import (
	"os"
	"os/user"
	"path/filepath"
)

// Home is os.homedir(): $HOME when set — even to "" (then `~/x` → relative
// `x`, like path.join("", "x")) — else the passwd entry.
func Home() string {
	if h, ok := os.LookupEnv("HOME"); ok {
		return h
	}
	if u, err := user.Current(); err == nil {
		return u.HomeDir
	}
	return "/"
}

// Resolve is path.resolve(base, expandHome(p)).
func Resolve(base, p string) string {
	p = ExpandHome(p)
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Join(base, p)
}

// Rel is path.relative(from, to) for absolute paths ("" when equal).
func Rel(from, to string) string {
	r, err := filepath.Rel(from, to)
	if err != nil || r == "." {
		return ""
	}
	return r
}
