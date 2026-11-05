package jsv

import (
	"errors"
	"strconv"
	"syscall"
)

// errnoText (libuv's text per errno) is generated: errno_linux.go. Release
// builds are Linux-only; elsewhere the map is empty and every errno prints as
// Node's unmapped form.

// FsError renders err like a Node fs error: `CODE: desc, syscall 'path'`
// (path omitted when ""). Non-errno errors pass through.
func FsError(err error, sys, path string) error {
	var en syscall.Errno
	if !errors.As(err, &en) {
		return err
	}
	t, ok := errnoText[uint32(en)]
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
