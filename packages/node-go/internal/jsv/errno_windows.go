//go:build windows

package jsv

import (
	"errors"
	"os"
	"syscall"

	"golang.org/x/sys/windows"
)

// Win32 errors use libuv's uv_translate_sys_error mapping. Go also synthesizes
// POSIX errnos (e.g. EISDIR from File.Read); those must render identically.
var errnoText = func() map[uint32][2]string {
	m := map[uint32][2]string{}
	add := func(code, text string, values ...syscall.Errno) {
		for _, v := range values {
			m[uint32(v)] = [2]string{code, text}
		}
	}
	add("ENOENT", "no such file or directory", syscall.ENOENT, windows.ERROR_FILE_NOT_FOUND, windows.ERROR_PATH_NOT_FOUND, windows.ERROR_INVALID_DRIVE, windows.ERROR_BAD_NETPATH, windows.ERROR_BAD_NET_NAME, windows.ERROR_INVALID_NAME)
	add("EEXIST", "file already exists", syscall.EEXIST, windows.ERROR_FILE_EXISTS, windows.ERROR_ALREADY_EXISTS)
	// Both ERROR_DIRECTORY and Go's ENOTDIR alias (ERROR_PATH_NOT_FOUND)
	// normally map to ENOENT; directory enumeration is handled below.
	add("ENOENT", "no such file or directory", windows.ERROR_DIRECTORY)
	add("EISDIR", "illegal operation on a directory", syscall.EISDIR)
	add("EPERM", "operation not permitted", syscall.EPERM, windows.ERROR_ACCESS_DENIED, windows.ERROR_PRIVILEGE_NOT_HELD)
	add("EACCES", "permission denied", syscall.EACCES, windows.ERROR_ELEVATION_REQUIRED, windows.ERROR_CANT_ACCESS_FILE)
	add("EFAULT", "bad address in system call argument", syscall.EFAULT, windows.ERROR_NOACCESS)
	add("EBUSY", "resource busy or locked", syscall.EBUSY, windows.ERROR_SHARING_VIOLATION, windows.ERROR_LOCK_VIOLATION)
	add("ENOSPC", "no space left on device", syscall.ENOSPC, windows.ERROR_DISK_FULL, windows.ERROR_HANDLE_DISK_FULL)
	add("ENOTEMPTY", "directory not empty", syscall.ENOTEMPTY, windows.ERROR_DIR_NOT_EMPTY)
	add("EINVAL", "invalid argument", syscall.EINVAL, windows.ERROR_INVALID_PARAMETER)
	add("EBADF", "bad file descriptor", syscall.EBADF, windows.ERROR_INVALID_HANDLE)
	add("EMFILE", "too many open files", syscall.EMFILE, windows.ERROR_TOO_MANY_OPEN_FILES)
	add("ENAMETOOLONG", "name too long", syscall.ENAMETOOLONG, windows.ERROR_FILENAME_EXCED_RANGE)
	return m
}()

func errnoInfo(err error, en syscall.Errno) ([2]string, bool) {
	var pe *os.PathError
	// os.ReadDir reports readdir + ENOTDIR for an existing file, but open +
	// ERROR_PATH_NOT_FOUND for missing parents. The numeric errno is identical.
	if errors.As(err, &pe) && pe.Op == "readdir" && en == syscall.ENOTDIR {
		return [2]string{"ENOTDIR", "not a directory"}, true
	}
	t, ok := errnoText[uint32(en)]
	return t, ok
}
