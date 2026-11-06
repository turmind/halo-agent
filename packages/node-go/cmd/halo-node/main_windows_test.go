//go:build windows

package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/turmind/halo-agent/packages/node-go/internal/nodepath"
)

func TestWindowsStartupHelper(t *testing.T) {
	if os.Getenv("HALO_TEST_STARTUP") != "1" {
		return
	}
	i := slices.Index(os.Args, "--")
	if i < 0 {
		t.Fatal("missing CLI arguments")
	}
	// Enter the namespace spelling in-process so CreateProcess cannot normalize
	// the working directory before the CLI's own validation sees it.
	if err := os.Chdir(os.Getenv("HALO_TEST_STARTUP_CWD")); err != nil {
		t.Fatal(err)
	}
	os.Args = append(os.Args[:1], os.Args[i+1:]...)
	main()
}

func TestWindowsStartupPaths(t *testing.T) {
	root, err := nodepath.Realpath(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	unsupported := `\\?\` + root
	for _, c := range []struct {
		name, cwd, rootArg string
		connect            bool
	}{
		{"drive-relative root", root, filepath.VolumeName(root) + ".", true},
		{"unsupported whole-machine cwd", unsupported, "", false},
		{"unsupported explicit whole-machine cwd", unsupported, "/", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				w.WriteHeader(http.StatusUnauthorized) // stop a valid startup without retries
			}))
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			args := []string{"-test.run=^TestWindowsStartupHelper$", "--", "--server", server.URL, "--token", "test-startup-token"}
			if c.rootArg != "" {
				args = append(args, "--root", c.rootArg)
			}
			cmd := exec.CommandContext(ctx, os.Args[0], args...)
			cmd.Env = append(os.Environ(), "HALO_TEST_STARTUP=1", "HALO_TEST_STARTUP_CWD="+c.cwd)
			cmd.Dir = root
			out, err := cmd.CombinedOutput()
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 1 || ctx.Err() != nil {
				t.Fatalf("exit: %v, context: %v, output: %s", err, ctx.Err(), out)
			}
			if c.connect {
				if requests.Load() != 1 || !strings.Contains(string(out), "[Node] sharing "+root+" → ") {
					t.Fatalf("drive-relative root did not start: requests=%d output=%s", requests.Load(), out)
				}
			} else if requests.Load() != 0 || !strings.Contains(string(out), "halo-node: current directory ") || !strings.Contains(string(out), "unsupported Windows path") || strings.Contains(string(out), "[Node] sharing") {
				t.Fatalf("unsupported cwd did not fail before connecting: requests=%d output=%s", requests.Load(), out)
			}
		})
	}
}
