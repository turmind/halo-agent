//go:build windows

package nodepath

import (
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// Supported rejects spellings whose namespace / trailing characters ordinary
// Win32 calls would reinterpret after confinement (D18). Check before Clean.
func Supported(p string) bool {
	p = strings.ReplaceAll(p, "/", `\`)
	if strings.HasPrefix(p, `\\?\`) || strings.HasPrefix(p, `\\.\`) {
		return false
	}
	p = p[len(filepath.VolumeName(p)):]
	for _, part := range strings.Split(p, `\`) {
		if part != "." && part != ".." && (strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ")) {
			return false
		}
	}
	return true
}

// WholePath applies the same spelling / canonical checks without confinement.
func WholePath(base, p string) string { return canonical(base, p) }

// Realpath uses the same handle-based native resolution as Node, including
// junctions. EvalSymlinks can leave mount-point reparse paths unchanged.
func Realpath(p string) (string, error) {
	if !Supported(p) {
		return "", errors.New("unsupported Windows path")
	}
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
			real = `\\` + real[8:]
		} else {
			real = strings.TrimPrefix(real, `\\?\`)
		}
		// The API adds a namespace prefix itself. Removing it is safe only if
		// the remaining spelling survives ordinary Win32 normalization intact.
		if !Supported(real) {
			return "", errors.New("unsupported Windows path")
		}
		return real, nil
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
