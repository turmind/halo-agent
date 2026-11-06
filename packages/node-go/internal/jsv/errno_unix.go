//go:build !windows

package jsv

import "syscall"

func errnoInfo(_ error, en syscall.Errno) ([2]string, bool) {
	t, ok := errnoText[uint32(en)]
	return t, ok
}
