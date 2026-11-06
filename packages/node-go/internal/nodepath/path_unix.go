//go:build !windows

package nodepath

import (
	"os"
	"os/user"
	"path/filepath"
)

// Unix paths have no Win32 normalization restrictions.
func Supported(string) bool { return true }

// WholePath preserves the original unconstrained Unix path behavior.
func WholePath(base, p string) string { return Resolve(base, p) }

// Realpath resolves existing paths like Node's fs.realpathSync.native.
func Realpath(p string) (string, error) { return filepath.EvalSymlinks(p) }

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
