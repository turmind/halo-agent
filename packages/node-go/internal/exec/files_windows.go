//go:build windows

package exec

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"

	"github.com/turmind/halo-agent/packages/node-go/internal/jsv"
)

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
