package jsv

import (
	"errors"
	"strconv"
	"syscall"
)

// libuv's uv_strerror text per errno, as Node 22 prints it.
var errnoText = map[syscall.Errno][2]string{
	syscall.ENOENT:       {"ENOENT", "no such file or directory"},
	syscall.EACCES:       {"EACCES", "permission denied"},
	syscall.EISDIR:       {"EISDIR", "illegal operation on a directory"},
	syscall.ENOTDIR:      {"ENOTDIR", "not a directory"},
	syscall.EEXIST:       {"EEXIST", "file already exists"},
	syscall.ELOOP:        {"ELOOP", "too many symbolic links encountered"},
	syscall.ENAMETOOLONG: {"ENAMETOOLONG", "name too long"},
	syscall.EROFS:        {"EROFS", "read-only file system"},
	syscall.ENOSPC:       {"ENOSPC", "no space left on device"},
	syscall.EPERM:        {"EPERM", "operation not permitted"},
	syscall.EMFILE:       {"EMFILE", "too many open files"},
	syscall.ENFILE:       {"ENFILE", "file table overflow"},
	syscall.EIO:          {"EIO", "i/o error"},
	syscall.EBUSY:        {"EBUSY", "resource busy or locked"},
	syscall.ETXTBSY:      {"ETXTBSY", "text file is busy"},
	syscall.EFBIG:        {"EFBIG", "file too large"},
	syscall.EINVAL:       {"EINVAL", "invalid argument"},
	syscall.ENXIO:        {"ENXIO", "no such device or address"},
	syscall.ENODEV:       {"ENODEV", "no such device"},
	syscall.EAGAIN:       {"EAGAIN", "resource temporarily unavailable"},
	syscall.ENOTEMPTY:    {"ENOTEMPTY", "directory not empty"},
	syscall.EXDEV:        {"EXDEV", "cross-device link not permitted"},
	syscall.ENOMEM:       {"ENOMEM", "not enough memory"},
	syscall.EOVERFLOW:    {"EOVERFLOW", "value too large for defined data type"},
	syscall.EBADF:        {"EBADF", "bad file descriptor"},
	syscall.ECANCELED:    {"ECANCELED", "operation canceled"},
	syscall.ENODATA:      {"ENODATA", "no data available"},
	syscall.ESPIPE:       {"ESPIPE", "invalid seek"},
}

// FsError renders err like a Node fs error: `CODE: desc, syscall 'path'`
// (path omitted when ""). Non-errno errors pass through.
func FsError(err error, sys, path string) error {
	var en syscall.Errno
	if !errors.As(err, &en) {
		return err
	}
	t, ok := errnoText[en]
	if !ok {
		// Not in libuv's map (EDQUOT included): Node prints `Unknown system error -<n>` as code and text.
		u := "Unknown system error -" + strconv.Itoa(int(en))
		t = [2]string{u, u}
	}
	msg := t[0] + ": " + t[1] + ", " + sys
	if path != "" {
		msg += " '" + path + "'"
	}
	return errors.New(msg)
}
