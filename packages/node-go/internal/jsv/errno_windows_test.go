//go:build windows

package jsv

import (
	"os"
	"syscall"
	"testing"

	"golang.org/x/sys/windows"
)

func TestWindowsFsErrors(t *testing.T) {
	for _, c := range []struct {
		err  syscall.Errno
		text string
	}{
		{windows.ERROR_FILE_NOT_FOUND, "ENOENT: no such file or directory"},
		{windows.ERROR_PATH_NOT_FOUND, "ENOENT: no such file or directory"},
		{windows.ERROR_ALREADY_EXISTS, "EEXIST: file already exists"},
		{windows.ERROR_FILE_EXISTS, "EEXIST: file already exists"},
		{windows.ERROR_DIRECTORY, "ENOENT: no such file or directory"},
		{syscall.EISDIR, "EISDIR: illegal operation on a directory"},
		{windows.ERROR_ACCESS_DENIED, "EPERM: operation not permitted"},
		{windows.ERROR_ELEVATION_REQUIRED, "EACCES: permission denied"},
		{windows.ERROR_NOACCESS, "EFAULT: bad address in system call argument"},
	} {
		const path = `C:\root\file`
		if got := FsError(&os.PathError{Op: "open", Path: path, Err: c.err}, "open", path).Error(); got != c.text+", open '"+path+"'" {
			t.Errorf("%d: %q", c.err, got)
		}
	}
}
