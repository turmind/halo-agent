//go:build windows

package exec

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"syscall"

	"github.com/turmind/halo-agent/packages/node-go/internal/jsv"
)

// Open without os.ReadDir's O_DIRECTORY so a file's ENOTDIR retains the
// readdir operation instead of becoming indistinguishable from a missing path.
func readDir(dir string) ([]os.DirEntry, error) {
	f, err := os.Open(dir)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	entries, err := f.ReadDir(-1)
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	return entries, err
}

// mkdirp keeps volume / UNC roots intact while walking missing parents. Stat
// follows junctions, like Node's recursive mkdir; errors name the attempted dir.
func mkdirp(dir string) error {
	err := os.Mkdir(dir, 0o777)
	if err == nil {
		return nil
	}
	if errors.Is(err, os.ErrNotExist) {
		parent := filepath.Dir(dir)
		if parent != dir {
			if err := mkdirp(parent); err != nil {
				return err
			}
			err = os.Mkdir(dir, 0o777)
			if err == nil {
				return nil
			}
		}
	}
	if errors.Is(err, os.ErrExist) || filepath.Dir(dir) == dir {
		if st, statErr := os.Stat(dir); statErr == nil {
			if st.IsDir() {
				return nil
			}
			err = syscall.EEXIST
		}
	}
	return jsv.FsError(err, "mkdir", dir)
}
