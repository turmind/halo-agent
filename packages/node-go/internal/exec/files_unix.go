//go:build !windows

package exec

import (
	"github.com/turmind/halo-agent/packages/node-go/internal/jsv"
	"strings"
	"syscall"
)

// mkdirp is fs.mkdir(dir, {recursive:true}): a port of Node's MKDirpAsync
// (src/node_file.cc) — mkdir the top of a path stack; ENOENT pushes the
// dirname; EACCES / ENOSPC / ENOTDIR / EPERM end it; any other error is
// replaced by a stat of the same path (so EROFS on a missing dir reads ENOENT,
// EEXIST on a dangling link ENOENT / ENOTDIR). The error names the last path tried.
func mkdirp(dir string) error {
	stack := []string{dir}
	parentOK := false // the path just popped is a child of a dir that mkdir said EEXIST for
	for {
		path := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		childOfDir := parentOK
		parentOK = false
		err := syscall.Mkdir(path, 0o777)
		switch err {
		case nil:
			if len(stack) == 0 {
				return nil
			}
			continue
		case syscall.EACCES, syscall.ENOSPC, syscall.ENOTDIR, syscall.EPERM:
			return jsv.FsError(err, "mkdir", path)
		case syscall.ENOENT:
			// Node re-tries this forever when the parent exists yet mkdir still
			// says ENOENT (procfs: /proc/sys/x) — TS never answers; Go reports it (D9).
			if childOfDir {
				return jsv.FsError(err, "mkdir", path)
			}
			if i := strings.LastIndexByte(path, '/'); i >= 0 {
				// "/x": the parent is "/" (Node takes "", mkdir ENOENT, and loops — D9).
				stack = append(stack, path, path[:max(i, 1)])
				continue
			}
			if len(stack) > 0 {
				continue
			}
			err = syscall.EEXIST
		}
		var st syscall.Stat_t
		serr := syscall.Stat(path, &st)
		isDir := serr == nil && st.Mode&syscall.S_IFMT == syscall.S_IFDIR
		if err == syscall.EEXIST && len(stack) > 0 {
			if isDir {
				parentOK = true
				continue
			}
			return jsv.FsError(syscall.ENOTDIR, "mkdir", path)
		}
		if serr != nil {
			return jsv.FsError(serr, "mkdir", path)
		}
		if !isDir {
			return jsv.FsError(syscall.EEXIST, "mkdir", path)
		}
		return nil
	}
}
