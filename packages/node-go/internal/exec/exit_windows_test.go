//go:build windows

package exec

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestWindowsShellExitClosesJob(t *testing.T) {
	root := t.TempDir()
	pidFile, release := filepath.Join(root, "child.pid"), filepath.Join(root, "release")
	t.Setenv("HALO_TEST_TREE", "background")
	t.Setenv("HALO_TEST_PID", pidFile)
	t.Setenv("HALO_TEST_RELEASE", release)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan string, 1)
	go func() {
		_, _, msg, _ := spawnGroup(ctx, `"`+os.Args[0]+`" -test.run=^TestWindowsTreeHelper$`, root, 60000)
		done <- msg
	}()
	var pid int
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(pidFile); err == nil {
			pid, _ = strconv.Atoi(string(b))
			if pid != 0 {
				break
			}
		}
		time.Sleep(10 * time.Millisecond) // readiness handshake with the helper
	}
	if pid == 0 {
		t.Fatal("background child never started")
	}
	h, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(h)
	defer windows.TerminateProcess(h, 1)
	if err := os.WriteFile(release, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case msg := <-done:
		if msg != "" {
			t.Fatalf("normal shell exit: %q", msg)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("shell exited but the background child's pipes kept the call open")
	}
	if status, err := windows.WaitForSingleObject(h, 1000); err != nil || status != windows.WAIT_OBJECT_0 {
		t.Fatalf("background child still running: status=%d err=%v", status, err)
	}
}
