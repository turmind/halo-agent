//go:build windows

package nodepath

import (
	"os"
	"os/user"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// Realpath uses the same handle-based native resolution as Node, including
// junctions. EvalSymlinks can leave mount-point reparse paths unchanged.
func Realpath(p string) (string, error) {
	name, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return "", err
	}
	h, err := windows.CreateFile(name, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, 512)
	for {
		n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0)
		if err != nil {
			return "", err
		}
		if int(n) >= len(buf) {
			buf = make([]uint16, n+1)
			continue
		}
		real := windows.UTF16ToString(buf[:n])
		if strings.HasPrefix(real, `\\?\UNC\`) {
			return `\\` + real[8:], nil
		}
		return strings.TrimPrefix(real, `\\?\`), nil
	}
}

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
